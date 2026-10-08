import Capacitor
import Foundation
import MeshcoreCore

/// A link preview's fetch: `window.Capacitor.Plugins.LinkFetch`, used by the web
/// client's `lib/linkFetch.ts`. The web view cannot read another site, so the
/// radio core's `linkFetch` does, with the rules of what a preview may reach
/// (no home network, no cookies, small reads); see `crates/link-fetch`.
///
/// - `fetch({ url, picture })`: answers `{ url, status, contentType, length?,
///   disposition?, body, cut }`, `body` in base64, or rejects with why nothing
///   was fetched (`address`, `redirects`, `status 404`, `timeout`, `network: …`).
///   With `picture`, only a picture is read.
@objc(LinkFetchPlugin)
final class LinkFetchPlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "LinkFetchPlugin"
    let jsName = "LinkFetch"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "fetch", returnType: CAPPluginReturnPromise),
    ]

    /// The core's fetch blocks for up to ten seconds; it runs here, never on the main thread.
    private let queue = DispatchQueue(label: "dev.cm4ker.meshnet.linkfetch", qos: .userInitiated, attributes: .concurrent)

    @objc func fetch(_ call: CAPPluginCall) {
        guard let url = call.getString("url"), !url.isEmpty else {
            call.reject("address")
            return
        }
        let picture = call.getBool("picture") ?? false
        queue.async {
            let fetched = linkFetch(link: url, pictureOnly: picture)
            if let refused = fetched.refused {
                call.reject(refused)
                return
            }
            var answer: [String: Any] = [
                "url": fetched.url,
                "status": Int(fetched.status),
                "contentType": fetched.contentType,
                "body": fetched.body.base64EncodedString(),
                "cut": fetched.cut,
            ]
            if let length = fetched.length { answer["length"] = Double(length) }
            if let disposition = fetched.disposition { answer["disposition"] = disposition }
            call.resolve(answer)
        }
    }
}
