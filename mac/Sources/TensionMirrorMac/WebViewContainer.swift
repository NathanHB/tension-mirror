import SwiftUI
import WebKit

struct WebViewContainer: NSViewRepresentable {
    let url: URL
    let bridge: BluetoothBridge
    let uiDelegate: WebViewUIDelegate

    func makeNSView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.userContentController.add(bridge, name: "bluetooth")

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.uiDelegate = uiDelegate
        bridge.webView = webView
        webView.load(URLRequest(url: url))
        return webView
    }

    func updateNSView(_ webView: WKWebView, context: Context) {}
}
