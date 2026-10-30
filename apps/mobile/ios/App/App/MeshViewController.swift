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
        bridge?.registerPluginInstance(FoldPlugin())
        MeshWatch.installSounds()
        if #available(iOS 27.1, *), let webView {
            // Opening or closing the phone moves the fold, and does not always lay the view out again.
            webView.addInteraction(UIHingeInteraction { [weak self] _, _ in self?.measureFold() })
        }
    }

    override func webView(with frame: CGRect, configuration: WKWebViewConfiguration) -> WKWebView {
        MeshWebView(frame: frame, configuration: configuration)
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        measureFold()
    }

    private var foldAgain: DispatchWorkItem?

    /// The fold can be reported a moment after the layout that brought it, so it is read again then.
    private func measureFold() {
        guard let webView else { return }
        FoldPlugin.measure(webView)
        foldAgain?.cancel()
        let again = DispatchWorkItem { [weak webView] in
            if let webView { FoldPlugin.measure(webView) }
        }
        foldAgain = again
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5, execute: again)
    }
}

/// The page's web view, whose menu over selected text carries the formatting while the
/// composer offers it (iOS 16 and later, where that menu is built through `buildMenu`).
final class MeshWebView: WKWebView {
    override func buildMenu(with builder: UIMenuBuilder) {
        super.buildMenu(with: builder)
        guard #available(iOS 16.0, *) else { return }
        guard builder.system == .context, let offer = FormatMenuPlugin.offer, hasSelectedText else { return }
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

    /// Whether text is selected rather than a bare caret, asked of the view with the focus as the
    /// menu asks it about Copy. The page offers the formatting for as long as the composer has the
    /// focus: it hears of a long press's word only after this menu is built.
    private var hasSelectedText: Bool {
        (Self.focused(in: self) ?? self).canPerformAction(#selector(UIResponderStandardEditActions.copy(_:)), withSender: nil)
    }

    private static func focused(in view: UIView) -> UIView? {
        if view.isFirstResponder { return view }
        for sub in view.subviews {
            if let found = focused(in: sub) { return found }
        }
        return nil
    }
}

/// Formatting in the menu over selected text, for the web client's `lib/formatMenu.ts`:
/// `window.Capacitor.Plugins.FormatMenu`.
///
/// - `set({ title, items })`: while the composer has the focus, the submenu's title and its
///   items, `[{ choice, title }]`, in the reader's language; `set({})` takes it away. The
///   submenu shows only over selected text.
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

    /// What the menu offers now, or nil while the composer does not have the focus. Read on the main thread.
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

/// Where the fold of a phone that opens like a book (iPhone Duo) lies across the page, for the web
/// client's `lib/fold.ts`: `window.Capacitor.Plugins.Fold`.
///
/// - `get()`: `{ fold: { start, end } }`, the fold's span across the page in points with the
///   margins the system keeps around it, while one runs down the screen; `{}` otherwise.
/// - Event: `change` with the same, whenever that moves.
@objc(FoldPlugin)
final class FoldPlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "FoldPlugin"
    let jsName = "Fold"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "get", returnType: CAPPluginReturnPromise),
    ]

    /// The fold now. Read and written on the main thread.
    private static var fold: (start: CGFloat, end: CGFloat)?
    private static weak var current: FoldPlugin?

    override func load() {
        Self.current = self
    }

    @objc func get(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            call.resolve(Self.data)
        }
    }

    private static var data: [String: Any] {
        guard let fold else { return [:] }
        return ["fold": ["start": fold.start, "end": fold.end]]
    }

    /// Reads the fold off the page's view, and tells the page when it has moved.
    static func measure(_ view: UIView) {
        var now: (start: CGFloat, end: CGFloat)?
        if #available(iOS 27.1, *) {
            // Inactive ones too: opened flat, the fold is reported as inactive, and the list should
            // not jump away from it as the phone goes from half open to flat. Only a fold that runs
            // down the screen splits the layout; one across it, on the phone opened and turned, does not.
            let regions = view.reservedRegions(kind: .division, options: .includeInactive)
            if let region = regions.first(where: { $0.frame.height > $0.frame.width }) {
                now = (region.frame.minX, region.frame.maxX)
            }
        }
        if now?.start == fold?.start && now?.end == fold?.end { return }
        fold = now
        current?.notifyListeners("change", data: data)
    }
}
