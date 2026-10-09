import UIKit
import UniformTypeIdentifiers

/// Ommesh in the share sheet (#88). It has no screen of its own: it reads the link or the
/// text shared, opens the app at `ommesh://share` with them, and goes. The app puts what
/// came over its chat list, where the reader picks the chat it goes to (`ShareInPlugin`,
/// the web client's `lib/shareIn.ts`).
class ShareViewController: UIViewController {
    private var started = false

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .clear
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        guard !started else { return }
        started = true
        Task { @MainActor in
            let shared = await self.read()
            if let url = Self.address(shared) { _ = self.openApp(url) }
            self.extensionContext?.completeRequest(returningItems: nil)
        }
    }

    /// The title, the text and the web address, as the sharing app gave them.
    private func read() async -> [String: String] {
        var shared: [String: String] = [:]
        for case let item as NSExtensionItem in extensionContext?.inputItems ?? [] {
            if shared["title"] == nil, let title = item.attributedTitle?.string, !title.isEmpty { shared["title"] = title }
            if shared["text"] == nil, let text = item.attributedContentText?.string, !text.isEmpty { shared["text"] = text }
            for provider in item.attachments ?? [] {
                if shared["url"] == nil, provider.hasItemConformingToTypeIdentifier(UTType.url.identifier),
                   let url = try? await provider.loadItem(forTypeIdentifier: UTType.url.identifier) as? URL,
                   !url.isFileURL {
                    shared["url"] = url.absoluteString
                } else if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier),
                          let text = try? await provider.loadItem(forTypeIdentifier: UTType.plainText.identifier) as? String,
                          !text.isEmpty {
                    // A note shares its text as an attachment; it says more than the item's own line.
                    shared["text"] = text
                }
            }
        }
        return shared
    }

    private static func address(_ shared: [String: String]) -> URL? {
        guard !shared.isEmpty else { return nil }
        var parts = URLComponents()
        parts.scheme = "ommesh"
        parts.host = "share"
        parts.queryItems = shared.sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) }
        return parts.url
    }

    /// An extension is given no way to open its app, but the application object it runs in
    /// still opens addresses: found up the responder chain and asked by name, since the
    /// method is closed to extensions at compile time.
    private func openApp(_ url: URL) -> Bool {
        let selector = sel_registerName("openURL:options:completionHandler:")
        var responder: UIResponder? = self
        while let current = responder {
            if let application = current as? UIApplication, application.responds(to: selector) {
                typealias Open = @convention(c) (AnyObject, Selector, NSURL, NSDictionary, (@convention(block) (Bool) -> Void)?) -> Void
                let open = unsafeBitCast(application.method(for: selector), to: Open.self)
                open(application, selector, url as NSURL, NSDictionary(), nil)
                return true
            }
            responder = current.next
        }
        return false
    }
}
