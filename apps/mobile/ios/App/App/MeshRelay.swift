import Capacitor
import CoreBluetooth
import Foundation
import MeshcoreCore
import UIKit
import UserNotifications

/// The app's link to its radio, and the radio shared with a computer nearby
/// through the phone.
///
/// The page talks to its radio through here, and the radio core
/// (`crates/meshcore-core`, `Radio`) decides whose command goes to the radio
/// when and whose an answer is, reads the radio's message queue into an inbox
/// per client, and announces what the page leaves unread while it sleeps: iOS
/// suspends the page's scripts soon after the app leaves the screen, while the
/// `bluetooth-central` background mode keeps the link up and wakes this code
/// for every frame the radio sends. Its notices are drawn as the page's are
/// (`MeshWatch.show`), with the page's tags and ids, so the page's own notice
/// for a chat takes the place of the core's.
///
/// Shared with a computer, the phone serves the same UART service the radio
/// does (Nordic UART, `6E400001…`), so a computer connects to the phone as if
/// it were the radio, with the client it already has, and the core takes turns
/// between the two (`bluetooth-peripheral` keeps that side up too). The
/// framing is BLE's own, one frame per write or notification.
///
/// The radio is held by this object's own central manager, on the link the
/// BLE plugin already made. The page's plugin stays connected (it is how the
/// page learns of a drop) but the page's frames come and go through here.
///
/// Both characteristics demand an encrypted link, so a computer has to be
/// paired with the phone first: iOS asks on its own screen.
final class MeshRelay: NSObject {
    static let shared = MeshRelay()

    private static let service = CBUUID(string: "6E400001-B5A3-F393-E0A9-E50E24DCCA9E")
    private static let rx = CBUUID(string: "6E400002-B5A3-F393-E0A9-E50E24DCCA9E")
    private static let tx = CBUUID(string: "6E400003-B5A3-F393-E0A9-E50E24DCCA9E")
    private static let inboxesKey = "meshnet.relay.inboxes"
    /// The page's notice settings and names for the core, and the signal its notices ring with.
    private static let watchKey = "meshnet.relay.watch"
    private static let soundKey = "meshnet.relay.sound"

    /// Told of every change: `{ linked, on, computer }` (`on`: shared).
    var onChange: (([String: Any]) -> Void)?
    /// Frames for the page.
    var onPageFrame: ((Data) -> Void)?

    private let core: Radio
    /// The page's writes waiting to hear they went, by the number the core knows them by.
    private var writes: [Int64: () -> Void] = [:]
    private var lastWrite: Int64 = 0
    /// Timers the core is waiting on, and the background time that lets them fire with the app out of sight.
    private var waiting = 0
    private var backgroundTask: UIBackgroundTaskIdentifier = .invalid

    private var server: CBPeripheralManager?
    private var central: CBCentralManager?
    private var served: CBMutableCharacteristic?
    private var published = false
    private var advertName = "Ommesh"
    private var sharing = false

    private var radioId: UUID?
    private var radio: CBPeripheral?
    private var radioRx: CBCharacteristic?

    private var computer: CBCentral?
    /// Notifications iOS had no room for; sent when it says it is ready again.
    private var backlog: [Data] = []

    /// Linked to a radio for the page.
    var isOn: Bool { radioId != nil }
    var isSharing: Bool { isOn && sharing }

    override init() {
        // The inboxes outlive the app: the radio's copy of a message is gone once the core has read it.
        let saved = UserDefaults.standard.dictionary(forKey: MeshRelay.inboxesKey) as? [String: [Data]] ?? [:]
        var inboxes: [Inbox] = []
        for (name, frames) in saved {
            if let client = MeshRelay.client(named: name) { inboxes.append(Inbox(client: client, frames: frames)) }
        }
        core = Radio(inboxes: inboxes)
        super.init()
        if let watch = UserDefaults.standard.string(forKey: MeshRelay.watchKey) { run(core.configure(json: watch)) }
        let center = NotificationCenter.default
        center.addObserver(self, selector: #selector(wentToBackground), name: UIApplication.didEnterBackgroundNotification, object: nil)
        center.addObserver(self, selector: #selector(cameToFront), name: UIApplication.willEnterForegroundNotification, object: nil)
    }

    /// Where a client's inbox is saved, as before the core: `page` and `computer`.
    private static func name(of client: Client) -> String {
        client == .computer ? "computer" : "page"
    }

    private static func client(named name: String) -> Client? {
        switch name {
        case "page": return .page
        case "computer": return .computer
        default: return nil
        }
    }

    private func saveInboxes() {
        var saved: [String: [Data]] = [:]
        for inbox in core.inboxes() { saved[MeshRelay.name(of: inbox.client)] = inbox.frames }
        UserDefaults.standard.set(saved, forKey: MeshRelay.inboxesKey)
    }

    // MARK: the core asks; this does

    private func run(_ effects: [Effect]) {
        for effect in effects {
            switch effect {
            case let .toRadio(frame):
                writeRadio(frame)
            case let .toClient(client, frame):
                if client == .computer { toComputer(frame) } else { onPageFrame?(frame) }
            case let .written(write):
                writes.removeValue(forKey: write)?()
            case let .wait(timer, millis):
                wait(timer, millis: millis)
            case .inboxesChanged:
                saveInboxes()
            case let .post(notice):
                // A burst of news rings with its first notice only.
                let sound = notice.silent ? nil : UserDefaults.standard.string(forKey: MeshRelay.soundKey)
                let shown = PageNotice(id: Int(notice.id), tag: notice.tag, title: notice.title, body: notice.body, sound: sound, avatar: nil, thread: nil)
                MeshWatch.show(shown) { error in
                    if let error { NSLog("MeshRelay: a notice was not shown: %@", error.localizedDescription) }
                }
            case let .withdraw(_, id):
                let center = UNUserNotificationCenter.current()
                center.removePendingNotificationRequests(withIdentifiers: [String(id)])
                center.removeDeliveredNotifications(withIdentifiers: [String(id)])
            case let .log(line):
                NSLog("MeshRelay: %@", line)
            }
        }
    }

    /// A timer for the core. Out of sight, iOS lets the app run a little after each frame from the
    /// radio; background time covers the rest, so a notice is not left waiting for the next frame.
    private func wait(_ timer: MeshcoreCore.Timer, millis: Int64) {
        waiting += 1
        if backgroundTask == .invalid, UIApplication.shared.applicationState == .background {
            backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "radio core") { [weak self] in self?.endBackgroundTask() }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(Int(millis))) { [weak self] in
            guard let self else { return }
            self.run(self.core.timeout(timer: timer))
            self.waiting -= 1
            if self.waiting == 0 { self.endBackgroundTask() }
        }
    }

    private func endBackgroundTask() {
        guard backgroundTask != .invalid else { return }
        UIApplication.shared.endBackgroundTask(backgroundTask)
        backgroundTask = .invalid
    }

    @objc private func wentToBackground() {
        run(core.setBackground(background: true))
    }

    @objc private func cameToFront() {
        run(core.setBackground(background: false))
    }

    // MARK: the link

    /// Links to the radio the page is connected to (the BLE plugin's id), and shares it with a computer if `share`.
    func start(radio id: UUID, name: String, share: Bool) {
        advertName = String("Ommesh \(name)".prefix(20))
        if radioId != id {
            releaseRadio()
            radioId = id
        }
        if central == nil {
            central = CBCentralManager(delegate: self, queue: nil, options: [CBCentralManagerOptionShowPowerAlertKey: false])
        } else {
            attachRadio()
        }
        self.share(share)
    }

    /// Shares the linked radio with a computer, or stops.
    func share(_ on: Bool) {
        sharing = on
        if isSharing {
            if server == nil {
                server = CBPeripheralManager(delegate: self, queue: nil, options: [CBPeripheralManagerOptionShowPowerAlertKey: false])
            } else {
                publish()
            }
        } else {
            unpublish()
        }
        changed()
    }

    /// Lets go of the radio: no link, no sharing.
    func stop() {
        radioId = nil
        sharing = false
        unpublish()
        run(core.detach(client: .page))
        releaseRadio()
        changed()
    }

    var state: [String: Any] {
        ["linked": isOn, "on": isSharing, "computer": computer != nil]
    }

    private func changed() {
        onChange?(state)
    }

    // MARK: the page

    func attachPage() {
        run(core.attach(client: .page))
    }

    func detachPage() {
        run(core.detach(client: .page))
    }

    /// `dispatched` is called once the frame has gone to the radio, or been answered here.
    func fromPage(_ frame: Data, dispatched: @escaping () -> Void) {
        guard isOn else {
            dispatched()
            return
        }
        lastWrite += 1
        writes[lastWrite] = dispatched
        run(core.fromClient(client: .page, frame: frame, write: lastWrite))
    }

    /// The page's notice settings and names, as the JSON the core reads (`WatchConfig`), and the
    /// signal file its notices ring with; kept, for a start without the page.
    func configure(json: String, sound: String?) {
        UserDefaults.standard.set(json, forKey: MeshRelay.watchKey)
        UserDefaults.standard.set(sound, forKey: MeshRelay.soundKey)
        run(core.configure(json: json))
    }

    /// The page announced this tag itself.
    func announced(_ tag: String) {
        run(core.announced(tag: tag))
    }

    // MARK: the computer's side

    private func publish() {
        guard let server, server.state == .poweredOn, isSharing else { return }
        if published {
            advertise()
            return
        }
        let rx = CBMutableCharacteristic(type: MeshRelay.rx, properties: [.write, .writeWithoutResponse], value: nil, permissions: [.writeEncryptionRequired])
        let tx = CBMutableCharacteristic(type: MeshRelay.tx, properties: [.notifyEncryptionRequired], value: nil, permissions: [.readEncryptionRequired])
        let service = CBMutableService(type: MeshRelay.service, primary: true)
        service.characteristics = [rx, tx]
        served = tx
        published = true
        server.add(service)
    }

    private func unpublish() {
        server?.stopAdvertising()
        server?.removeAllServices()
        published = false
        served = nil
        dropComputer()
    }

    /// Only while no computer is connected: this serves one, as the firmware does.
    private func advertise() {
        guard let server, server.state == .poweredOn, isSharing, computer == nil, !server.isAdvertising else { return }
        server.startAdvertising([
            CBAdvertisementDataLocalNameKey: advertName,
            CBAdvertisementDataServiceUUIDsKey: [MeshRelay.service],
        ])
    }

    private func dropComputer() {
        guard computer != nil else { return }
        computer = nil
        backlog = []
        run(core.detach(client: .computer))
    }

    private func toComputer(_ frame: Data) {
        guard computer != nil else { return }
        if !backlog.isEmpty {
            backlog.append(frame)
            return
        }
        send(frame)
    }

    /// False when iOS's queue is full; the frame then waits in the backlog.
    @discardableResult
    private func send(_ frame: Data) -> Bool {
        guard let server, let served, let computer else { return true }
        if frame.count > computer.maximumUpdateValueLength {
            NSLog("MeshRelay: a %d-byte frame does not fit the computer's %d", frame.count, computer.maximumUpdateValueLength)
        }
        if server.updateValue(frame, for: served, onSubscribedCentrals: [computer]) { return true }
        backlog.insert(frame, at: 0)
        return false
    }

    // MARK: the radio's side

    private func attachRadio() {
        guard let central, central.state == .poweredOn, let radioId else { return }
        if let radio, radio.state == .connected || radio.state == .connecting { return }
        let peripheral = central.retrieveConnectedPeripherals(withServices: [MeshRelay.service]).first { $0.identifier == radioId }
            ?? central.retrievePeripherals(withIdentifiers: [radioId]).first
        guard let peripheral else { return }
        radio = peripheral
        radioRx = nil
        peripheral.delegate = self
        // To a radio the system is already connected to this answers at once;
        // to one out of range it waits, which is what a link that is on wants.
        central.connect(peripheral, options: nil)
    }

    private func releaseRadio() {
        run(core.radioDown())
        guard let radio else { return }
        self.radio = nil
        radioRx = nil
        central?.cancelPeripheralConnection(radio)
    }

    /// Only called while the radio is up: the core holds commands until then.
    private func writeRadio(_ frame: Data) {
        guard let radio, let radioRx, radio.state == .connected else {
            NSLog("MeshRelay: a frame for the radio with no radio")
            return
        }
        // With response, as the page writes: the characteristic demands encryption.
        radio.writeValue(frame, for: radioRx, type: .withResponse)
    }
}

extension MeshRelay: CBPeripheralManagerDelegate {
    func peripheralManagerDidUpdateState(_ peripheral: CBPeripheralManager) {
        if peripheral.state == .poweredOn {
            publish()
        } else {
            // A Bluetooth restart takes the published service with it.
            published = false
            served = nil
            if computer != nil {
                dropComputer()
                changed()
            }
        }
    }

    func peripheralManager(_ peripheral: CBPeripheralManager, didAdd service: CBService, error: Error?) {
        if let error {
            NSLog("MeshRelay: the service was not published: %@", error.localizedDescription)
            published = false
            return
        }
        advertise()
    }

    func peripheralManager(_ peripheral: CBPeripheralManager, central: CBCentral, didSubscribeTo characteristic: CBCharacteristic) {
        guard characteristic.uuid == MeshRelay.tx, isSharing else { return }
        computer = central
        backlog = []
        peripheral.stopAdvertising()
        peripheral.setDesiredConnectionLatency(.low, for: central)
        run(core.attach(client: .computer))
        attachRadio()
        changed()
    }

    func peripheralManager(_ peripheral: CBPeripheralManager, central: CBCentral, didUnsubscribeFrom characteristic: CBCharacteristic) {
        guard characteristic.uuid == MeshRelay.tx, central.identifier == computer?.identifier else { return }
        dropComputer()
        advertise()
        changed()
    }

    func peripheralManager(_ peripheral: CBPeripheralManager, didReceiveWrite requests: [CBATTRequest]) {
        // A frame longer than the link's MTU comes as a long write, in pieces with offsets.
        var frame = Data()
        for request in requests where request.characteristic.uuid == MeshRelay.rx {
            if let value = request.value { frame.append(value) }
        }
        if let first = requests.first { peripheral.respond(to: first, withResult: .success) }
        if !frame.isEmpty, computer != nil { run(core.fromClient(client: .computer, frame: frame, write: nil)) }
    }

    func peripheralManagerIsReady(toUpdateSubscribers peripheral: CBPeripheralManager) {
        while !backlog.isEmpty {
            let frame = backlog.removeFirst()
            if !send(frame) { return }
        }
    }
}

extension MeshRelay: CBCentralManagerDelegate {
    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        if central.state == .poweredOn { attachRadio() }
    }

    func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        guard peripheral == radio else { return }
        peripheral.discoverServices([MeshRelay.service])
    }

    func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
        guard peripheral == radio else { return }
        radio = nil
        radioRx = nil
        run(core.radioDown())
    }

    func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
        guard peripheral == radio else { return }
        radioRx = nil
        run(core.radioDown())
        // Asked again: iOS keeps the request and connects when the radio is back, the app asleep or not.
        if isOn { central.connect(peripheral, options: nil) }
    }
}

extension MeshRelay: CBPeripheralDelegate {
    func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        for service in peripheral.services ?? [] where service.uuid == MeshRelay.service {
            peripheral.discoverCharacteristics([MeshRelay.rx, MeshRelay.tx], for: service)
        }
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        for characteristic in service.characteristics ?? [] {
            if characteristic.uuid == MeshRelay.rx {
                radioRx = characteristic
            } else if characteristic.uuid == MeshRelay.tx {
                peripheral.setNotifyValue(true, for: characteristic)
            }
        }
    }

    /// The radio is up once its TX notifies here: then the waiting commands go.
    func peripheral(_ peripheral: CBPeripheral, didUpdateNotificationStateFor characteristic: CBCharacteristic, error: Error?) {
        guard peripheral == radio, characteristic.uuid == MeshRelay.tx else { return }
        if let error {
            NSLog("MeshRelay: the radio's TX did not subscribe: %@", error.localizedDescription)
            return
        }
        if characteristic.isNotifying, radioRx != nil { run(core.radioUp()) }
    }

    func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
        guard error == nil, peripheral == radio, characteristic.uuid == MeshRelay.tx, let value = characteristic.value, !value.isEmpty else { return }
        run(core.fromRadio(frame: value))
    }

    func peripheral(_ peripheral: CBPeripheral, didWriteValueFor characteristic: CBCharacteristic, error: Error?) {
        if let error { NSLog("MeshRelay: a write to the radio failed: %@", error.localizedDescription) }
    }
}

/// The page's side of its link to the radio: `start({ deviceId, name, share })`
/// with the radio the page is connected to, `share({ on })`, `stop()`,
/// `state()`, and a `state` event `{ linked, on, computer }` whenever one of
/// them changes. While `attach()`ed, the page talks to the radio through here:
/// `send({ data })` (base64), answered once the frame has gone to the radio,
/// and `frame` events `{ data }`. `configure({ json, sound })` hands the radio
/// core the page's notice settings and names, `announced({ tag })` what the
/// page announced itself.
@objc(MeshRelayPlugin)
final class MeshRelayPlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "MeshRelayPlugin"
    let jsName = "MeshRelay"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "share", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "state", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "attach", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "detach", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "send", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "configure", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "announced", returnType: CAPPluginReturnPromise),
    ]

    override func load() {
        MeshRelay.shared.onChange = { [weak self] state in
            self?.notifyListeners("state", data: state)
        }
        MeshRelay.shared.onPageFrame = { [weak self] frame in
            self?.notifyListeners("frame", data: ["data": frame.base64EncodedString()])
        }
    }

    @objc func start(_ call: CAPPluginCall) {
        guard let id = call.getString("deviceId").flatMap({ UUID(uuidString: $0) }) else {
            call.reject("start needs the radio's deviceId")
            return
        }
        let name = call.getString("name") ?? ""
        let share = call.getBool("share") ?? false
        DispatchQueue.main.async {
            MeshRelay.shared.start(radio: id, name: name, share: share)
            call.resolve(MeshRelay.shared.state)
        }
    }

    @objc func share(_ call: CAPPluginCall) {
        let on = call.getBool("on") ?? false
        DispatchQueue.main.async {
            MeshRelay.shared.share(on)
            call.resolve(MeshRelay.shared.state)
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            MeshRelay.shared.stop()
            call.resolve(MeshRelay.shared.state)
        }
    }

    @objc func state(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            call.resolve(MeshRelay.shared.state)
        }
    }

    @objc func attach(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            MeshRelay.shared.attachPage()
            call.resolve()
        }
    }

    @objc func detach(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            MeshRelay.shared.detachPage()
            call.resolve()
        }
    }

    @objc func send(_ call: CAPPluginCall) {
        guard let data = call.getString("data").flatMap({ Data(base64Encoded: $0) }) else {
            call.reject("send needs base64 data")
            return
        }
        DispatchQueue.main.async {
            MeshRelay.shared.fromPage(data) { call.resolve() }
        }
    }

    @objc func configure(_ call: CAPPluginCall) {
        guard let json = call.getString("json") else {
            call.reject("configure needs json")
            return
        }
        let sound = call.getString("sound")
        DispatchQueue.main.async {
            MeshRelay.shared.configure(json: json, sound: sound)
            call.resolve()
        }
    }

    @objc func announced(_ call: CAPPluginCall) {
        let tag = call.getString("tag") ?? ""
        DispatchQueue.main.async {
            MeshRelay.shared.announced(tag)
            call.resolve()
        }
    }
}
