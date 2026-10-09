import Capacitor
import Foundation

/// Text another app shares to Ommesh (#88), for the web client's `lib/shareIn.ts`:
/// `window.Capacitor.Plugins.ShareIn`. The share extension (`Share/ShareViewController.swift`)
/// opens the app at `ommesh://share?text=…&url=…&title=…`, which Capacitor passes on as an
/// opened address, at launch once the plugins are in.
///
/// - `take()`: answers `{ title?, text?, url? }` once, so a page still loading misses nothing.
/// - Event: `shared` when a share comes while the page runs.
@objc(ShareInPlugin)
final class ShareInPlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "ShareInPlugin"
    let jsName = "ShareIn"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "take", returnType: CAPPluginReturnPromise),
    ]

    private var pending: [String: String]?

    override func load() {
        NotificationCenter.default.addObserver(self, selector: #selector(opened(_:)), name: .capacitorOpenURL, object: nil)
    }

    @objc private func opened(_ note: Notification) {
        guard let object = note.object as? [String: Any], let url = object["url"] as? URL,
              url.scheme == "ommesh", url.host == "share",
              let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems else { return }
        var shared: [String: String] = [:]
        for item in items where ["title", "text", "url"].contains(item.name) {
            if let value = item.value { shared[item.name] = value }
        }
        guard !shared.isEmpty else { return }
        DispatchQueue.main.async {
            self.pending = shared
            self.notifyListeners("shared", data: [:])
        }
    }

    @objc func take(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            let shared = self.pending ?? [:]
            self.pending = nil
            call.resolve(shared)
        }
    }
}
