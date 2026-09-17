import AppKit
import CoreBluetooth
import WebKit

/// Native replacement for bluetooth.js's Web Bluetooth path (which WKWebView,
/// being WebKit, doesn't support - same limitation as Safari). The JS side
/// still builds the exact same byte packet (see static/bluetooth.js); this
/// class only does the actual BLE scan/connect/write, then reports success
/// or failure back into the page via `window.nativeBluetoothResult(...)`.
///
/// The board doesn't necessarily advertise a name starting with the board
/// name (a real Tension board showed up as "NH00012AA6"), so unlike Web
/// Bluetooth's namePrefix filter, this collects everything nearby for a
/// few seconds and lets you pick from a real list - same idea as the
/// browser's own device picker, just a native one.
final class BluetoothBridge: NSObject, WKScriptMessageHandler {
    private var centralManager: CBCentralManager!
    private var peripheral: CBPeripheral?
    private var characteristic: CBCharacteristic?

    private var pendingChunks: [[UInt8]] = []
    private var discovered: [UUID: CBPeripheral] = [:]
    private var collectionTimer: Timer?

    weak var webView: WKWebView?

    private static let serviceUUID = CBUUID(string: "6e400001-b5a3-f393-e0a9-e50e24dcca9e")
    private static let characteristicUUID = CBUUID(string: "6e400002-b5a3-f393-e0a9-e50e24dcca9e")
    private static let collectionWindow: TimeInterval = 4

    override init() {
        super.init()
        centralManager = CBCentralManager(delegate: self, queue: nil)
    }

    // MARK: - JS -> Swift

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard
            let body = message.body as? [String: Any],
            let rawChunks = body["chunks"] as? [[Int]]
        else {
            reportFailure("Malformed Bluetooth request from page.")
            return
        }

        pendingChunks = rawChunks.map { $0.map { UInt8(clamping: $0) } }

        if let peripheral, peripheral.state == .connected, let characteristic {
            writeNextChunk(to: peripheral, characteristic: characteristic)
            return
        }

        guard centralManager.state == .poweredOn else {
            reportFailure("Bluetooth is off, or this app hasn't been granted Bluetooth access yet (check System Settings > Privacy & Security > Bluetooth).")
            return
        }

        startScan()
    }

    // MARK: - Scanning / picking

    private func startScan() {
        webView?.evaluateJavaScript("document.getElementById('illuminate-error').textContent = 'Looking for nearby Bluetooth devices\\u2026'")
        discovered.removeAll()
        centralManager.scanForPeripherals(withServices: nil, options: nil)
        collectionTimer?.invalidate()
        collectionTimer = Timer.scheduledTimer(withTimeInterval: Self.collectionWindow, repeats: false) { [weak self] _ in
            self?.finishCollecting()
        }
    }

    private func finishCollecting() {
        centralManager.stopScan()
        let candidates = discovered.values
            .filter { $0.name != nil }
            .sorted { ($0.name ?? "") < ($1.name ?? "") }

        guard !candidates.isEmpty else {
            reportFailure("No nearby Bluetooth devices found. Make sure the board is powered on and in range.")
            return
        }

        presentPicker(candidates: candidates)
    }

    private func presentPicker(candidates: [CBPeripheral]) {
        let alert = NSAlert()
        alert.messageText = "Which device is your board?"
        alert.informativeText = "Pick the Tension board from the nearby Bluetooth devices found."
        alert.addButton(withTitle: "Connect")
        alert.addButton(withTitle: "Cancel")

        let popup = NSPopUpButton(frame: NSRect(x: 0, y: 0, width: 260, height: 24))
        for candidate in candidates {
            popup.addItem(withTitle: candidate.name ?? "(unnamed)")
        }
        alert.accessoryView = popup

        let response = alert.runModal()
        guard response == .alertFirstButtonReturn else {
            reportFailure(nil) // user cancelled - no alert, just reset the button
            return
        }

        let chosen = candidates[popup.indexOfSelectedItem]
        peripheral = chosen
        chosen.delegate = self
        webView?.evaluateJavaScript("document.getElementById('illuminate-error').textContent = 'Connecting\\u2026'")
        centralManager.connect(chosen, options: nil)
    }

    // MARK: - Reporting back to the page

    private func reportSuccess() {
        webView?.evaluateJavaScript("window.nativeBluetoothResult(true, null)")
    }

    private func reportFailure(_ message: String?) {
        if let message {
            let escaped = message.replacingOccurrences(of: "\"", with: "\\\"")
            webView?.evaluateJavaScript("window.nativeBluetoothResult(false, \"\(escaped)\")")
        } else {
            webView?.evaluateJavaScript("window.nativeBluetoothResult(true, null)")
        }
    }

    // MARK: - Writing

    private func writeNextChunk(to peripheral: CBPeripheral, characteristic: CBCharacteristic) {
        guard !pendingChunks.isEmpty else {
            reportSuccess()
            return
        }
        let chunk = pendingChunks.removeFirst()
        let data = Data(chunk)

        if characteristic.properties.contains(.write) {
            peripheral.writeValue(data, for: characteristic, type: .withResponse)
        } else {
            peripheral.writeValue(data, for: characteristic, type: .withoutResponse)
            writeNextChunk(to: peripheral, characteristic: characteristic)
        }
    }
}

extension BluetoothBridge: CBCentralManagerDelegate {
    func centralManagerDidUpdateState(_ central: CBCentralManager) {}

    func centralManager(_ central: CBCentralManager, didDiscover peripheral: CBPeripheral, advertisementData: [String: Any], rssi: NSNumber) {
        discovered[peripheral.identifier] = peripheral
    }

    func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        peripheral.discoverServices([Self.serviceUUID])
    }

    func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
        reportFailure("Failed to connect to the board: \(error?.localizedDescription ?? "unknown error")")
    }

    func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
        if !pendingChunks.isEmpty {
            reportFailure("Lost connection to the board mid-write.")
        }
        self.peripheral = nil
        self.characteristic = nil
    }
}

extension BluetoothBridge: CBPeripheralDelegate {
    func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        guard let service = peripheral.services?.first(where: { $0.uuid == Self.serviceUUID }) else {
            reportFailure("That device didn't expose the expected Bluetooth service - probably not the board.")
            return
        }
        peripheral.discoverCharacteristics([Self.characteristicUUID], for: service)
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        guard let characteristic = service.characteristics?.first(where: { $0.uuid == Self.characteristicUUID }) else {
            reportFailure("That device didn't expose the expected Bluetooth characteristic.")
            return
        }
        self.characteristic = characteristic
        writeNextChunk(to: peripheral, characteristic: characteristic)
    }

    func peripheral(_ peripheral: CBPeripheral, didWriteValueFor characteristic: CBCharacteristic, error: Error?) {
        if let error {
            reportFailure("Write failed: \(error.localizedDescription)")
            return
        }
        writeNextChunk(to: peripheral, characteristic: characteristic)
    }
}
