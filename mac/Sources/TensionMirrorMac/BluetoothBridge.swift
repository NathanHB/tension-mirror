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
    private var context = "climb"
    private var pendingServiceReports = 0
    private var serviceReport: [String] = []

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

        context = body["context"] as? String ?? "climb"
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
        reportStatus("Looking for nearby Bluetooth devices\u{2026}")
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
        reportStatus("Connecting\u{2026}")
        centralManager.connect(chosen, options: nil)
    }

    // MARK: - Reporting back to the page

    private func reportStatus(_ text: String) {
        let escaped = text.replacingOccurrences(of: "\"", with: "\\\"")
        webView?.evaluateJavaScript("window.nativeBluetoothStatus(\"\(escaped)\", \"\(context)\")")
    }

    private func reportSuccess() {
        webView?.evaluateJavaScript("window.nativeBluetoothResult(true, null, \"\(context)\")")
    }

    private func reportFailure(_ message: String?) {
        if let message {
            let escaped = message.replacingOccurrences(of: "\"", with: "\\\"")
            webView?.evaluateJavaScript("window.nativeBluetoothResult(false, \"\(escaped)\", \"\(context)\")")
        } else {
            webView?.evaluateJavaScript("window.nativeBluetoothResult(true, null, \"\(context)\")")
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
        // Discover everything rather than filtering by our assumed UUID -
        // that UUID was reverse-engineered for Kilter and just assumed to
        // be identical on Tension; if it's wrong, we want to see what the
        // board actually exposes instead of a bare "not found".
        peripheral.discoverServices(nil)
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
        let services = peripheral.services ?? []
        print("BT: discovered \(services.count) service(s): \(services.map { $0.uuid.uuidString })")

        if let service = services.first(where: { $0.uuid == Self.serviceUUID }) {
            peripheral.discoverCharacteristics([Self.characteristicUUID], for: service)
            return
        }

        // Our assumed UUID (reverse-engineered for Kilter) isn't here.
        // Rather than just failing, discover every characteristic on every
        // service found so the error message is a real map of what this
        // board actually exposes.
        guard !services.isEmpty else {
            reportFailure("That device has no Bluetooth services at all.")
            return
        }
        pendingServiceReports = services.count
        serviceReport = []
        for service in services {
            peripheral.discoverCharacteristics(nil, for: service)
        }
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        let characteristics = service.characteristics ?? []
        print("BT: discovered \(characteristics.count) characteristic(s) on \(service.uuid.uuidString): \(characteristics.map { ($0.uuid.uuidString, $0.properties) })")

        if service.uuid == Self.serviceUUID,
           let characteristic = characteristics.first(where: { $0.uuid == Self.characteristicUUID }) {
            self.characteristic = characteristic
            writeNextChunk(to: peripheral, characteristic: characteristic)
            return
        }

        // Exploratory path: record this service's characteristics (with
        // their read/write/notify properties) and, once every service has
        // reported back, surface the whole map in one error.
        let charDescriptions = characteristics.map { "\($0.uuid.uuidString) \(propertyDescription($0.properties))" }
        serviceReport.append("\(service.uuid.uuidString): [\(charDescriptions.joined(separator: ", "))]")
        pendingServiceReports -= 1
        if pendingServiceReports <= 0 {
            reportFailure("Expected service/characteristic not found. This board exposes:\n" + serviceReport.joined(separator: "\n"))
        }
    }

    private func propertyDescription(_ properties: CBCharacteristicProperties) -> String {
        var flags: [String] = []
        if properties.contains(.read) { flags.append("read") }
        if properties.contains(.write) { flags.append("write") }
        if properties.contains(.writeWithoutResponse) { flags.append("writeNoResponse") }
        if properties.contains(.notify) { flags.append("notify") }
        if properties.contains(.indicate) { flags.append("indicate") }
        return flags.isEmpty ? "(no relevant properties)" : "(\(flags.joined(separator: "/")))"
    }

    func peripheral(_ peripheral: CBPeripheral, didWriteValueFor characteristic: CBCharacteristic, error: Error?) {
        if let error {
            reportFailure("Write failed: \(error.localizedDescription)")
            return
        }
        writeNextChunk(to: peripheral, characteristic: characteristic)
    }
}
