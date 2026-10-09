import Capacitor
import Foundation
import Intents

/// Text another app shares to Ommesh (#88), for the web client's `lib/shareIn.ts`:
/// `window.Capacitor.Plugins.ShareIn`. The share extension (`Share/ShareViewController.swift`)
/// opens the app at `ommesh://share?text=…&url=…&title=…&chat=…`, which Capacitor passes on
/// as an opened address, at launch once the plugins are in.
///
/// - `take()`: answers `{ title?, text?, url?, chat? }` once, so a page still loading misses nothing.
/// - `offer({ chats })`: the chats the share sheet suggests by name, `[{ id, title, icon }]`, the
///   icon a PNG in base64, the first ranked first. Each is told to iOS as a message sent to that
///   conversation; a share to one of them reaches the extension with its id.
/// - Event: `shared` when a share comes while the page runs.
@objc(ShareInPlugin)
final class ShareInPlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "ShareInPlugin"
    let jsName = "ShareIn"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "take", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "offer", returnType: CAPPluginReturnPromise),
    ]

    /// What the suggestions told to iOS are filed under, so the next offer takes the last one's place.
    private static let group = "dev.cm4ker.meshnet.share"

    private var pending: [String: String]?

    override func load() {
        NotificationCenter.default.addObserver(self, selector: #selector(opened(_:)), name: .capacitorOpenURL, object: nil)
    }

    @objc private func opened(_ note: Notification) {
        guard let object = note.object as? [String: Any], let url = object["url"] as? URL,
              url.scheme == "ommesh", url.host == "share",
              let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems else { return }
        var shared: [String: String] = [:]
        for item in items where ["title", "text", "url", "chat"].contains(item.name) {
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

    @objc func offer(_ call: CAPPluginCall) {
        let chats = call.getArray("chats", JSObject.self) ?? []
        INInteraction.delete(with: Self.group) { _ in
            // The last told is the one iOS puts first.
            for chat in chats.reversed() {
                guard let id = chat["id"] as? String, let title = chat["title"] as? String else { continue }
                let intent = INSendMessageIntent(
                    recipients: nil, outgoingMessageType: .outgoingMessageText, content: nil,
                    speakableGroupName: INSpeakableString(spokenPhrase: title), conversationIdentifier: id,
                    serviceName: nil, sender: nil, attachments: nil)
                if let icon = chat["icon"] as? String, let data = Data(base64Encoded: icon) {
                    intent.setImage(INImage(imageData: data), forParameterNamed: \.speakableGroupName)
                }
                let interaction = INInteraction(intent: intent, response: nil)
                interaction.groupIdentifier = Self.group
                interaction.direction = .outgoing
                interaction.donate(completion: nil)
            }
            call.resolve()
        }
    }
}
