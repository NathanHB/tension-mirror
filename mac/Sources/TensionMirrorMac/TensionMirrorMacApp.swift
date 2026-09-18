import SwiftUI

private let serverPort = 8842

@main
struct TensionMirrorMacApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var appDelegate

    var body: some Scene {
        WindowGroup {
            RootView(server: appDelegate.server, bridge: appDelegate.bridge, uiDelegate: appDelegate.uiDelegate)
        }
        .defaultSize(width: 1200, height: 820)
        .commands {
            CommandGroup(after: .toolbar) {
                Button("Reload Page") {
                    appDelegate.bridge.webView?.reloadFromOrigin()
                }
                .keyboardShortcut("r", modifiers: .command)
            }
        }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    let server = ServerLauncher(port: serverPort)
    let bridge = BluetoothBridge()
    let uiDelegate = WebViewUIDelegate()

    func applicationWillTerminate(_ notification: Notification) {
        server.stop()
    }
}

struct RootView: View {
    let server: ServerLauncher
    let bridge: BluetoothBridge
    let uiDelegate: WebViewUIDelegate

    @State private var isReady = false
    @State private var failedToStart = false

    var body: some View {
        Group {
            if isReady {
                WebViewContainer(url: server.baseURL, bridge: bridge, uiDelegate: uiDelegate)
            } else if failedToStart {
                VStack(spacing: 12) {
                    Text("Couldn't start the Tension Mirror server.")
                        .font(.headline)
                    Text("Check that \(server.baseURL) isn't already in use, and that the venv exists.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .padding()
            } else {
                VStack(spacing: 12) {
                    ProgressView()
                    Text("Starting Tension Mirror…")
                        .foregroundStyle(.secondary)
                }
            }
        }
        .frame(minWidth: 900, minHeight: 700)
        .onAppear {
            server.start { success in
                DispatchQueue.main.async {
                    if success {
                        isReady = true
                    } else {
                        failedToStart = true
                    }
                }
            }
        }
    }
}
