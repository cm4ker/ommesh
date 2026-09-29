import AudioToolbox
import Capacitor
import Foundation
import UIKit
import UserNotifications

/// The page's notices, drawn natively so they ring with the app's signal.
/// What arrives while the page sleeps is announced by the radio core behind
/// `MeshRelay`, which draws its notices here too.
enum MeshWatch {}

/// One of the page's own notices (`post`), as `lib/notify.ts` sends it.
struct PageNotice {
    let id: Int
    let tag: String
    let title: String
    let body: String
    /// `signal_<id>.wav` in Library/Sounds, or none for a quiet notice.
    let sound: String?
}

/// The page's notices, drawn here with the app's signal (gh #25).
extension MeshWatch {
    /// The signals ship in the web build (`public/sounds`); a notice's sound must be in the app's
    /// bundle root or in Library/Sounds, so they are copied there, once per build.
    static func installSounds() {
        let files = FileManager.default
        guard let from = Bundle.main.resourceURL?.appendingPathComponent("public/sounds"),
              let library = files.urls(for: .libraryDirectory, in: .userDomainMask).first,
              let names = try? files.contentsOfDirectory(atPath: from.path) else { return }
        let to = library.appendingPathComponent("Sounds")
        try? files.createDirectory(at: to, withIntermediateDirectories: true)
        for name in names where name.hasSuffix(".wav") {
            let source = from.appendingPathComponent(name)
            let target = to.appendingPathComponent(name)
            let size = { (url: URL) in (try? files.attributesOfItem(atPath: url.path)[.size] as? Int) ?? -1 }
            if size(source) == size(target) { continue }
            try? files.removeItem(at: target)
            try? files.copyItem(at: source, to: target)
        }
    }

    /// Posts the page's notice now, in place of the one out with its id. It is words alone: the
    /// writer's circle as its picture filled the screen of a watch the phone passed it on to.
    static func show(_ notice: PageNotice, done: @escaping (Error?) -> Void) {
        let content = UNMutableNotificationContent()
        content.title = notice.title
        content.body = notice.body
        content.sound = notice.sound.map { UNNotificationSound(named: UNNotificationSoundName($0)) }
        content.threadIdentifier = notice.tag
        // Where LocalNotifications keeps a notice's extra: its tap listener hands the tag to the page.
        content.userInfo = ["cap_extra": ["tag": notice.tag]]
        let request = UNNotificationRequest(identifier: String(notice.id), content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request, withCompletionHandler: done)
    }

    private static var sounds: [String: SystemSoundID] = [:]

    /// The signal for the page's banner, as an alert sound: the silent switch turns it into a buzz.
    static func chime(_ signal: String) {
        let name = "signal_\(signal)"
        if sounds[name] == nil {
            guard let url = Bundle.main.resourceURL?.appendingPathComponent("public/sounds/\(name).wav") else { return }
            var id: SystemSoundID = 0
            guard AudioServicesCreateSystemSoundID(url as CFURL, &id) == kAudioServicesNoError else { return }
            sounds[name] = id
        }
        if let id = sounds[name] { AudioServicesPlayAlertSound(id) }
    }
}

/// The page's notices on the iPhone: `post(notice)` draws one,
/// `chime({ signal })` plays the signal for the page's banner, and
/// `openSettings()` opens the system's notification settings for the app,
/// where sound and quiet hours are.
@objc(MeshWatchPlugin)
final class MeshWatchPlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "MeshWatchPlugin"
    let jsName = "MeshWatch"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "openSettings", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "post", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "chime", returnType: CAPPluginReturnPromise),
    ]

    @objc func openSettings(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            // The app's notification page from iOS 16; before it, the app's settings, one tap away from it.
            let page: String
            if #available(iOS 16.0, *) {
                page = UIApplication.openNotificationSettingsURLString
            } else {
                page = UIApplication.openSettingsURLString
            }
            if let url = URL(string: page) { UIApplication.shared.open(url) }
            call.resolve()
        }
    }

    @objc func post(_ call: CAPPluginCall) {
        guard let id = call.getInt("id") else {
            call.reject("A notice needs an id")
            return
        }
        let notice = PageNotice(
            id: id,
            tag: call.getString("tag") ?? "",
            title: call.getString("title") ?? "",
            body: call.getString("body") ?? "",
            // A burst of news rings with its first notice only.
            sound: call.getBool("silent") == true ? nil : call.getString("sound")
        )
        MeshWatch.show(notice) { error in
            if let error {
                call.reject("Could not show the notice", nil, error)
            } else {
                call.resolve()
            }
        }
    }

    @objc func chime(_ call: CAPPluginCall) {
        let signal = call.getString("signal") ?? "chirp"
        DispatchQueue.main.async {
            MeshWatch.chime(signal)
            call.resolve()
        }
    }
}
