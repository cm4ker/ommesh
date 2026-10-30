import Capacitor
import UIKit
import WebKit

/// Capacitor's bridge, with the plugins that live in this app rather than in a
/// package. `SceneDelegate` makes the window with this class.
class MeshViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(MeshTcpPlugin())
        bridge?.registerPluginInstance(MeshWatchPlugin())
        bridge?.registerPluginInstance(MeshRelayPlugin())
        bridge?.registerPluginInstance(ShareInPlugin())
        bridge?.registerPluginInstance(FormatMenuPlugin())
        MeshWatch.installSounds()
    }

    override func webView(with frame: CGRect, configuration: WKWebViewConfiguration) -> WKWebView {
        MeshWebView(frame: frame, configuration: configuration)
    }
}

/// The page's web view, whose menu over selected text carries the formatting while the
/// composer offers it (iOS 16 and later, where that menu is built through `buildMenu`).
final class MeshWebView: WKWebView {
    override func buildMenu(with builder: UIMenuBuilder) {
        super.buildMenu(with: builder)
        guard #available(iOS 16.0, *) else { return }
        guard builder.system == .context, let offer = FormatMenuPlugin.offer else { return }
        let actions = offer.items.map { item in
            UIAction(title: item.title) { _ in FormatMenuPlugin.pick(item.choice) }
        }
        let menu = UIMenu(title: offer.title, children: actions)
        // After Cut, Copy and Paste where the menu has them, as Telegram puts its Format.
        if builder.menu(for: .standardEdit) != nil {
            builder.insertSibling(menu, afterMenu: .standardEdit)
        } else {
            builder.insertChild(menu, atEndOfMenu: .root)
        }
    }
}

/// Formatting in the menu over selected text, for the web client's `lib/formatMenu.ts`:
/// `window.Capacitor.Plugins.FormatMenu`.
///
/// - `set({ title, items })`: while the composer has text selected, the submenu's title and its
///   items, `[{ choice, title }]`, in the reader's language; `set({})` takes it away.
/// - Event: `pick` with `{ choice }` when one is chosen.
@objc(FormatMenuPlugin)
final class FormatMenuPlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "FormatMenuPlugin"
    let jsName = "FormatMenu"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "set", returnType: CAPPluginReturnPromise),
    ]

    struct Item {
        let choice: String
        let title: String
    }

    /// What the menu offers now, or nil while nothing selected may be formatted. Read on the main thread.
    static var offer: (title: String, items: [Item])?
    private static weak var current: FormatMenuPlugin?

    override func load() {
        Self.current = self
    }

    @objc func set(_ call: CAPPluginCall) {
        let title = call.getString("title")
        let items = (call.getArray("items", JSObject.self) ?? []).compactMap { item -> Item? in
            guard let choice = item["choice"] as? String, let title = item["title"] as? String else { return nil }
            return Item(choice: choice, title: title)
        }
        DispatchQueue.main.async {
            if let title, !items.isEmpty {
                Self.offer = (title, items)
            } else {
                Self.offer = nil
            }
            call.resolve()
        }
    }

    static func pick(_ choice: String) {
        current?.notifyListeners("pick", data: ["choice": choice])
    }
}
