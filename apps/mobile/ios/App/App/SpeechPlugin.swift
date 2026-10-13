import AVFoundation
import Capacitor
import Foundation
import SpeechCore
import UIKit

/// Voice input (#89) for the web client's `lib/voiceInput.ts`: what is said into the microphone,
/// written down on the phone by Whisper (crates/speech, in the app's Rust library with the radio
/// core) and handed to the page phrase by phrase. The sound goes from the microphone to the
/// recogniser here, never through the page, and is forgotten once heard. The same methods and
/// events as Android's `SpeechPlugin.java`:
///
/// - `models()`: `{ models: [{ id, bytes, present }], unable }`, `unable` why this phone cannot hear
///   speech, or null. `download({ id })` with `progress` events `{ model, done, total }`;
///   `delete({ id })`; `unload()`.
/// - `start({ model, language, before })` turns the microphone on once the model is read in,
///   asking for it the first time. While it listens: `phrase` events `{ text }`, `level` events
///   `{ level, speaking }`, `quiet` after a long silence, `error` events `{ message }` for a failure
///   that turned it off. `stop()` answers `{ phrases }`, the last heard; `cancel()` drops them.
@objc(SpeechPlugin)
final class SpeechPlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "SpeechPlugin"
    let jsName = "Speech"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "models", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "download", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "delete", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "unload", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancel", returnType: CAPPluginReturnPromise),
    ]

    /// A quarter of a second at 16 kHz, so the text keeps close behind the speech.
    private static let piece = 4_000

    private var speech: SpeechInput!
    /// Reading a model in and hearing the last phrase, one at a time.
    private let work = DispatchQueue(label: "dev.cm4ker.meshnet.speech")
    /// Downloads, apart, so that one does not hold up listening with the model already here.
    private let fetches = DispatchQueue(label: "dev.cm4ker.meshnet.speech.fetch")
    /// The microphone's sound gathered and handed in, in the order it came.
    private let feeding = DispatchQueue(label: "dev.cm4ker.meshnet.speech.feed")

    /// The microphone while it is on; swapped under `lock`, as it is let go from more than one queue.
    private var engine: AVAudioEngine?
    private let lock = NSLock()
    /// Touched on `feeding` alone.
    private var gathered: [Float] = []
    private var listening = false
    /// The audio session as it was before listening, put back after.
    private var before: (AVAudioSession.Category, AVAudioSession.Mode, AVAudioSession.CategoryOptions)?

    override func load() {
        speech = SpeechInput(folder: Self.folder().path)
        NotificationCenter.default.addObserver(self, selector: #selector(away), name: UIApplication.didEnterBackgroundNotification, object: nil)
    }

    /// Where the models are kept, out of the phone's backups: a model is hundreds of megabytes, fetched again at will.
    private static func folder() -> URL {
        var url = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("voice", isDirectory: true)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? url.setResourceValues(values)
        return url
    }

    @objc func models(_ call: CAPPluginCall) {
        work.async {
            let models = self.speech.models().map { ["id": $0.id, "bytes": $0.bytes, "present": $0.present] as [String: Any] }
            call.resolve(["models": models, "unable": self.speech.unable() ?? NSNull()])
        }
    }

    @objc func download(_ call: CAPPluginCall) {
        let id = call.getString("id") ?? ""
        fetches.async {
            do {
                try self.speech.download(id: id, progress: Progress(plugin: self, model: id))
                call.resolve()
            } catch {
                call.reject(Self.text(error))
            }
        }
    }

    @objc func delete(_ call: CAPPluginCall) {
        let id = call.getString("id") ?? ""
        work.async {
            do {
                try self.speech.delete(id: id)
                call.resolve()
            } catch {
                call.reject(Self.text(error))
            }
        }
    }

    @objc func unload(_ call: CAPPluginCall) {
        stopMicrophone()
        work.async {
            self.speech.unload()
            call.resolve()
        }
    }

    @objc func start(_ call: CAPPluginCall) {
        let begin = { (granted: Bool) in
            if granted {
                self.begin(call)
            } else {
                call.reject("No access to the microphone", "denied")
            }
        }
        if #available(iOS 17.0, *) {
            AVAudioApplication.requestRecordPermission(completionHandler: begin)
        } else {
            AVAudioSession.sharedInstance().requestRecordPermission(begin)
        }
    }

    private func begin(_ call: CAPPluginCall) {
        stopMicrophone()
        let model = call.getString("model") ?? "small"
        let language = call.getString("language") ?? "ru"
        let before = call.getString("before") ?? ""
        work.async {
            do {
                try self.speech.start(model: model, language: language, before: before)
                try self.startMicrophone()
                call.resolve()
            } catch {
                self.stopMicrophone()
                self.speech.cancel()
                call.reject(Self.text(error))
            }
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        stopMicrophone()
        work.async {
            do {
                call.resolve(["phrases": try self.speech.finish()])
            } catch {
                call.reject(Self.text(error))
            }
        }
    }

    @objc func cancel(_ call: CAPPluginCall) {
        stopMicrophone()
        speech.cancel()
        call.resolve()
    }

    /// Out of sight, the microphone goes off: the app has no background audio.
    @objc private func away() {
        guard listening else { return }
        stopMicrophone()
        speech.cancel()
        notifyListeners("error", data: ["message": "The microphone went off with the app out of sight"])
    }

    private func startMicrophone() throws {
        let session = AVAudioSession.sharedInstance()
        before = (session.category, session.mode, session.categoryOptions)
        // Mode `measurement`: no processing for the recogniser to mind. Other sound is lowered meanwhile.
        try session.setCategory(.record, mode: .measurement, options: [.duckOthers])
        try session.setActive(true)
        let engine = AVAudioEngine()
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard let target = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16_000, channels: 1, interleaved: false),
              let converter = AVAudioConverter(from: format, to: target) else {
            throw NSError(domain: "Speech", code: 1, userInfo: [NSLocalizedDescriptionKey: "The microphone could not be opened"])
        }
        input.installTap(onBus: 0, bufferSize: 4_096, format: format) { [weak self] buffer, _ in
            self?.take(buffer, converter: converter, target: target)
        }
        engine.prepare()
        try engine.start()
        lock.lock()
        self.engine = engine
        listening = true
        lock.unlock()
    }

    /// The microphone's sound at 16 kHz mono, handed in a quarter of a second at a time.
    private func take(_ buffer: AVAudioPCMBuffer, converter: AVAudioConverter, target: AVAudioFormat) {
        let room = AVAudioFrameCount(Double(buffer.frameLength) * target.sampleRate / buffer.format.sampleRate) + 32
        guard let out = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: room) else { return }
        var given = false
        var failure: NSError?
        converter.convert(to: out, error: &failure) { _, status in
            if given {
                status.pointee = .noDataNow
                return nil
            }
            given = true
            status.pointee = .haveData
            return buffer
        }
        guard failure == nil, let channel = out.floatChannelData?[0] else { return }
        let samples = Array(UnsafeBufferPointer(start: channel, count: Int(out.frameLength)))
        feeding.async {
            guard self.listening else { return }
            self.gathered += samples
            guard self.gathered.count >= Self.piece else { return }
            let piece = self.gathered
            self.gathered = []
            self.feed(piece)
        }
    }

    private func feed(_ samples: [Float]) {
        do {
            let heard = try speech.feed(samples: samples)
            for phrase in heard.phrases {
                notifyListeners("phrase", data: ["text": phrase])
            }
            notifyListeners("level", data: ["level": Double(heard.level), "speaking": heard.speaking])
            if heard.ended {
                notifyListeners("quiet", data: [:])
            }
        } catch {
            guard listening else { return }
            listening = false
            DispatchQueue.main.async { self.stopMicrophone() }
            notifyListeners("error", data: ["message": Self.text(error)])
        }
    }

    /// Lets the microphone go, once what it gave last has been handed in.
    private func stopMicrophone() {
        lock.lock()
        let engine = self.engine
        self.engine = nil
        lock.unlock()
        guard let engine else { return }
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        feeding.sync {
            if listening, !gathered.isEmpty {
                let rest = gathered
                gathered = []
                feed(rest)
            }
            gathered = []
            listening = false
        }
        let session = AVAudioSession.sharedInstance()
        try? session.setActive(false, options: .notifyOthersOnDeactivation)
        if let before {
            try? session.setCategory(before.0, mode: before.1, options: before.2)
        }
        before = nil
    }

    private static func text(_ error: Error) -> String {
        if case let .Failed(message)? = error as? SpeechError {
            return message
        }
        return error.localizedDescription
    }

    /// Tells the page how far a download has got.
    private final class Progress: DownloadProgress, @unchecked Sendable {
        private weak var plugin: SpeechPlugin?
        private let model: String

        init(plugin: SpeechPlugin, model: String) {
            self.plugin = plugin
            self.model = model
        }

        func told(done: Int64, total: Int64) {
            plugin?.notifyListeners("progress", data: ["model": model, "done": done, "total": total])
        }
    }
}
