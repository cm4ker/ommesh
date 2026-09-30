//! Bluetooth LE through Windows' own GATT API.
//!
//! The MeshCore firmware guards its UART characteristics with
//! `SECMODE_ENC_WITH_MITM`: they can only be used over a link encrypted with a
//! bond made by PIN pairing. Windows handles that on its own — the first
//! protected operation on a bonded device raises the link — but btleplug's
//! discovery of such a service on Windows times out and leaves the plugin
//! wedged, so on this platform the shell talks to WinRT directly.
//!
//! All of it happens on one worker thread that is a single-threaded apartment
//! with a message pump. Discovery of the encrypted service was found to hang
//! forever from a thread-pool (multi-threaded apartment) thread and to answer
//! at once from an apartment thread, which is what the PowerShell probe that
//! first got an answer out of the radio was running on. The worker owns the
//! WinRT objects; commands send it closures and await the answer.
//!
//! Frames arrive on a `Channel` the page hands to `connect`; a drop is
//! announced by an event. Every operation has a deadline, so a stack that
//! goes quiet is reported rather than waited on forever.
//!
//! A deadline only covers what is waited on here. A plain call into Windows
//! can block for good too: when a phone took its UART service down and put it
//! back, Windows' own close of the old service hung in a call to its Bluetooth
//! service, and the worker's `Close` of the same service waited behind it for
//! fourteen hours, with every reconnect queued up behind that. So the worker
//! is watched: one that shows no sign of life for `STALL` is left to its call,
//! and a new one takes over.

use std::cell::OnceCell;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager, State};
use windows::core::{RuntimeType, GUID};
use windows::Devices::Bluetooth::Advertisement::{
    BluetoothLEAdvertisementReceivedEventArgs, BluetoothLEAdvertisementWatcher, BluetoothLEScanningMode,
};
use windows::Devices::Bluetooth::GenericAttributeProfile::{
    GattCharacteristic, GattClientCharacteristicConfigurationDescriptorValue, GattCommunicationStatus,
    GattDeviceService, GattOpenStatus, GattSharingMode, GattValueChangedEventArgs,
};
use windows::core::HSTRING;
use windows::Devices::Bluetooth::{BluetoothCacheMode, BluetoothConnectionStatus, BluetoothLEDevice};
use windows::Devices::Enumeration::{
    DeviceAccessStatus, DeviceInformationCustomPairing, DevicePairingKinds, DevicePairingProtectionLevel, DevicePairingRequestedEventArgs,
    DevicePairingResultStatus, DeviceUnpairingResultStatus,
};
use windows::Foundation::TypedEventHandler;
use windows::Storage::Streams::{DataReader, DataWriter};
use windows::Win32::System::WinRT::{RoInitialize, RO_INIT_SINGLETHREADED};
use windows::Win32::UI::WindowsAndMessaging::{DispatchMessageW, PeekMessageW, TranslateMessage, MSG, PM_REMOVE};
use windows_future::{AsyncStatus, IAsyncOperation};

const SERVICE: GUID = GUID::from_u128(0x6e400001_b5a3_f393_e0a9_e50e24dcca9e);
const RX: GUID = GUID::from_u128(0x6e400002_b5a3_f393_e0a9_e50e24dcca9e);
const TX: GUID = GUID::from_u128(0x6e400003_b5a3_f393_e0a9_e50e24dcca9e);
const NAME_PREFIX: &str = "MeshCore-";
const GATT_DEADLINE: Duration = Duration::from_secs(20);
/// How long the worker may go without a sign of life before it is given up
/// on. Every wait pumps, and each pump counts, so only a single call into
/// Windows that does not return comes near this.
const STALL: Duration = Duration::from_secs(15);
/// What the page is told when the worker was given up on.
const STALLED: &str = "Windows stopped answering a Bluetooth call; the link starts afresh";

/// The event the page listens to for a dropped link.
pub const CLOSED_EVENT: &str = "winble:closed";

struct Link {
    /// Which link this is, so a close meant for an earlier one leaves it alone.
    id: u64,
    device: BluetoothLEDevice,
    service: GattDeviceService,
    rx: GattCharacteristic,
    tx: GattCharacteristic,
    /// Event registration tokens, which this crate version hands out as plain integers.
    value_token: i64,
    status_token: i64,
}

/// What lives on the worker thread and nowhere else.
#[derive(Default)]
struct Worker {
    link: Option<Link>,
    /// Links opened so far, which numbers them.
    opened: u64,
}

type Job = Box<dyn FnOnce(&mut Worker) + Send + 'static>;

/// What a worker shares with those waiting on it.
#[derive(Default)]
struct Life {
    /// Counted up by every pump on the worker's thread: its sign of life.
    beat: AtomicU64,
    /// Set once the worker is given up on. Should its call ever return, it
    /// runs nothing more: the jobs queued behind it are nobody's by then, and
    /// a late connect or unsubscribe would get in the new worker's way.
    retired: AtomicBool,
}

struct Handle {
    jobs: Sender<Job>,
    life: Arc<Life>,
}

thread_local! {
    /// The worker's own `Life`, for `pump` to count on; unset on other threads.
    static LIFE: OnceCell<Arc<Life>> = const { OnceCell::new() };
}

fn spawn_worker() -> Handle {
    let (jobs, receiver) = mpsc::channel::<Job>();
    let life = Arc::new(Life::default());
    let own = life.clone();
    std::thread::Builder::new()
        .name("winble".into())
        .spawn(move || worker_main(receiver, own))
        .expect("the BLE worker thread");
    Handle { jobs, life }
}

pub struct WinBle {
    worker: Mutex<Handle>,
    stall: Duration,
    /// Scans run on their own thread, so a scan in progress never holds up a
    /// frame; this is how a scan is told to stop early.
    scanning: Arc<AtomicBool>,
    /// Scans are serialised among themselves: one watcher at a time.
    scan_lock: Arc<Mutex<()>>,
}

impl Default for WinBle {
    fn default() -> Self {
        Self::with_stall(STALL)
    }
}

/// The worker went quiet inside a call and was replaced.
#[derive(Debug)]
struct Stalled;

impl WinBle {
    fn with_stall(stall: Duration) -> Self {
        Self {
            worker: Mutex::new(spawn_worker()),
            stall,
            scanning: Arc::new(AtomicBool::new(false)),
            scan_lock: Arc::new(Mutex::new(())),
        }
    }

    /// Runs `f` on the worker and waits for its answer, blocking the caller.
    fn run<T, F>(&self, f: F) -> Result<Result<T, String>, Stalled>
    where
        T: Send + 'static,
        F: FnOnce(&mut Worker) -> Result<T, String> + Send + 'static,
    {
        let (answer, waiting) = mpsc::channel::<Result<T, String>>();
        let life = {
            let Ok(worker) = self.worker.lock() else { return Ok(Err("worker lock".into())) };
            let job: Job = Box::new(move |worker| {
                let _ = answer.send(f(worker));
            });
            if worker.jobs.send(job).is_err() {
                return Ok(Err("the BLE worker is gone".into()));
            }
            worker.life.clone()
        };
        match await_answer(&waiting, &life, self.stall) {
            Ok(Some(answer)) => Ok(answer),
            Ok(None) => Ok(Err("the BLE worker dropped the job".into())),
            Err(Stalled) => {
                self.replace(&life);
                Err(Stalled)
            }
        }
    }

    /// Leaves the worker `life` belongs to in the call it is stuck in, and starts
    /// another. Several callers can find the same worker stuck; the first replaces it.
    fn replace(&self, life: &Arc<Life>) {
        let Ok(mut worker) = self.worker.lock() else { return };
        if !Arc::ptr_eq(&worker.life, life) {
            return;
        }
        log::warn!("winble: the worker made no progress in {:?}; starting another", self.stall);
        life.retired.store(true, Ordering::Relaxed);
        *worker = spawn_worker();
    }
}

/// The answer to a job, `None` if the worker dropped it, or `Stalled` once the
/// worker has shown no sign of life for `stall`. Quiet is counted in ticks
/// spent waiting, not by the clock, so a computer that slept in between does
/// not count its sleep against a worker that had no chance to run.
fn await_answer<T>(waiting: &Receiver<T>, life: &Life, stall: Duration) -> Result<Option<T>, Stalled> {
    let tick = Duration::from_millis(250);
    let mut last = life.beat.load(Ordering::Relaxed);
    let mut quiet = Duration::ZERO;
    loop {
        match waiting.recv_timeout(tick) {
            Ok(answer) => return Ok(Some(answer)),
            Err(RecvTimeoutError::Disconnected) => return Ok(None),
            Err(RecvTimeoutError::Timeout) => {
                let beat = life.beat.load(Ordering::Relaxed);
                if beat != last {
                    last = beat;
                    quiet = Duration::ZERO;
                } else {
                    quiet += tick;
                    if quiet >= stall {
                        return Err(Stalled);
                    }
                }
            }
        }
    }
}

fn worker_main(jobs: Receiver<Job>, life: Arc<Life>) {
    // SAFETY: called once, first thing, on a thread this module owns.
    if let Err(error) = unsafe { RoInitialize(RO_INIT_SINGLETHREADED) } {
        log::error!("winble: RoInitialize failed: {error}");
    }
    LIFE.with(|own| {
        let _ = own.set(life.clone());
    });
    let mut worker = Worker::default();
    loop {
        match jobs.recv_timeout(Duration::from_millis(10)) {
            Ok(_) if life.retired.load(Ordering::Relaxed) => break,
            Ok(job) => job(&mut worker),
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }
        pump();
    }
}

/// Delivers whatever the apartment has queued: completions and events for the objects it owns.
fn pump() {
    LIFE.with(|own| {
        if let Some(life) = own.get() {
            life.beat.fetch_add(1, Ordering::Relaxed);
        }
    });
    // SAFETY: plain message-loop calls on the thread that owns the queue.
    unsafe {
        let mut msg = MSG::default();
        while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
}

/// Runs `f` on the worker and awaits its answer. A worker given up on takes
/// its link with it, and the page is told the link dropped.
async fn on_worker<T, F>(app: &AppHandle, f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(&mut Worker) -> Result<T, String> + Send + 'static,
{
    let owner = app.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || owner.state::<WinBle>().run(f))
        .await
        .map_err(|e| e.to_string())?;
    outcome.unwrap_or_else(|Stalled| {
        let _ = app.emit(CLOSED_EVENT, STALLED);
        Err(STALLED.into())
    })
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Found {
    /// Twelve hex digits, no separators.
    address: String,
    name: String,
    rssi: i16,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Connected {
    name: String,
    /// The link's number, for `winble_disconnect`.
    link: u64,
}

fn hex_address(address: u64) -> String {
    format!("{address:012X}")
}

fn parse_address(text: &str) -> Result<u64, String> {
    let clean: String = text.chars().filter(|c| c.is_ascii_hexdigit()).collect();
    u64::from_str_radix(&clean, 16).map_err(|_| format!("not a Bluetooth address: {text}"))
}

fn err(context: &str, error: windows::core::Error) -> String {
    format!("{context}: {} (0x{:08X})", error.message(), error.code().0 as u32)
}

/// Only ATT authentication/encryption failures mean that an existing bond
/// needs repair. Marking an unreachable phone as NEEDS_PAIRING makes the
/// client discard its bond, including the identity behind its rotating address.
fn gatt_failure(what: &str, status: GattCommunicationStatus, protocol_error: Option<u8>) -> String {
    let att = protocol_error.map(|code| format!(", ATT 0x{code:02X}")).unwrap_or_default();
    let hint = if status == GattCommunicationStatus::ProtocolError && matches!(protocol_error, Some(0x05 | 0x08 | 0x0F)) {
        ". NEEDS_PAIRING"
    } else {
        ""
    };
    format!("{what}: {status:?}{att}{hint}")
}

/// Why a service Windows listed gave no link.
#[derive(Debug)]
enum Refusal {
    /// The device no longer keeps the service where Windows remembers it, so
    /// another listing of the same service may still answer.
    Moved(String),
    /// Anything else, which a second listing would meet as well.
    Failed(String),
}

impl From<String> for Refusal {
    fn from(error: String) -> Self {
        Refusal::Failed(error)
    }
}

/// A GATT failure, told apart by whether the handle was the trouble. Invalid
/// handle and attribute not found say nothing is there; write not permitted
/// and request not supported say that what is there is not the attribute
/// Windows took it for. A service in its place answers none of the four.
fn gatt_refusal(what: &str, status: GattCommunicationStatus, protocol_error: Option<u8>) -> Refusal {
    let error = gatt_failure(what, status, protocol_error);
    if status == GattCommunicationStatus::ProtocolError && matches!(protocol_error, Some(0x01 | 0x03 | 0x06 | 0x0A)) {
        Refusal::Moved(error)
    } else {
        Refusal::Failed(error)
    }
}

/// Waits for a WinRT operation on the worker, pumping the apartment meanwhile,
/// but not past the deadline: a stack that never completes is cancelled and
/// reported, with how long it took to give up.
fn wait<T: RuntimeType + 'static>(op: IAsyncOperation<T>, what: &str) -> Result<T, String> {
    let started = Instant::now();
    loop {
        let status = op.Status().map_err(|e| err(what, e))?;
        match status {
            AsyncStatus::Started => {
                if started.elapsed() > GATT_DEADLINE {
                    let _ = op.Cancel();
                    log::warn!("winble: {what} gave no answer in {:?}", started.elapsed());
                    return Err(format!("{what}: Windows gave no answer in {} s", GATT_DEADLINE.as_secs()));
                }
                pump();
                std::thread::sleep(Duration::from_millis(5));
            }
            AsyncStatus::Completed => {
                log::debug!("winble: {what} done in {:?}", started.elapsed());
                return op.GetResults().map_err(|e| err(what, e));
            }
            _ => {
                let code = op.ErrorCode().map(|c| c.0 as u32).unwrap_or(0);
                // 0x8065xxxx is the ATT error facility; 5, 8 and 0xF are the
                // radio saying the link is not encrypted or authenticated —
                // it is not paired with this computer, or no longer trusts
                // the bond.
                let hint = if code & 0xFFFF_0000 == 0x8065_0000 && matches!(code & 0xFFFF, 0x05 | 0x08 | 0x0F) {
                    " NEEDS_PAIRING"
                } else {
                    ""
                };
                return Err(format!("{what}: {status:?} 0x{code:08X}{hint}"));
            }
        }
    }
}

fn scan(timeout_ms: u64, keep_going: &AtomicBool) -> Result<Vec<Found>, String> {
    let found = std::sync::Arc::new(Mutex::new(std::collections::HashMap::<u64, Found>::new()));
    let watcher = BluetoothLEAdvertisementWatcher::new().map_err(|e| err("watcher", e))?;
    watcher
        .SetScanningMode(BluetoothLEScanningMode::Active)
        .map_err(|e| err("scanning mode", e))?;
    let sink = found.clone();
    let token = watcher
        .Received(&TypedEventHandler::new(
            move |_: windows::core::Ref<BluetoothLEAdvertisementWatcher>,
                  args: windows::core::Ref<BluetoothLEAdvertisementReceivedEventArgs>| {
                let Some(args) = args.as_ref() else { return Ok(()) };
                let address = args.BluetoothAddress()?;
                let rssi = args.RawSignalStrengthInDBm()?;
                let advert = args.Advertisement()?;
                let name = advert.LocalName().map(|n| n.to_string()).unwrap_or_default();
                let has_service = advert
                    .ServiceUuids()
                    .map(|uuids| uuids.into_iter().any(|u| u == SERVICE))
                    .unwrap_or(false);
                let mut map = sink.lock().expect("scan lock");
                match map.entry(address) {
                    std::collections::hash_map::Entry::Occupied(mut e) => {
                        let f = e.get_mut();
                        f.rssi = rssi;
                        if f.name.is_empty() && !name.is_empty() {
                            f.name = name;
                        }
                    }
                    std::collections::hash_map::Entry::Vacant(v) => {
                        if has_service || name.starts_with(NAME_PREFIX) {
                            v.insert(Found { address: hex_address(address), name, rssi });
                        }
                    }
                }
                Ok(())
            },
        ))
        .map_err(|e| err("watch", e))?;
    watcher.Start().map_err(|e| err("scan start", e))?;
    let until = Instant::now() + Duration::from_millis(timeout_ms.clamp(500, 30_000));
    while Instant::now() < until && keep_going.load(Ordering::Relaxed) {
        pump();
        std::thread::sleep(Duration::from_millis(20));
    }
    let _ = watcher.Stop();
    let _ = watcher.RemoveReceived(token);
    // A scan response with the name can land after the first advert; give it a moment.
    let until = Instant::now() + Duration::from_millis(300);
    while Instant::now() < until {
        pump();
        std::thread::sleep(Duration::from_millis(20));
    }
    let map = found.lock().expect("scan lock");
    let mut list: Vec<Found> = map.values().filter(|f| !f.name.is_empty()).cloned().collect();
    list.sort_by(|a, b| b.rssi.cmp(&a.rssi));
    Ok(list)
}

/// Radios advertising nearby, listened for over `timeout_ms`, or until `winble_stop_scan`.
#[tauri::command]
pub async fn winble_scan(state: State<'_, WinBle>, timeout_ms: u64) -> Result<Vec<Found>, String> {
    let keep_going = state.scanning.clone();
    let lock = state.scan_lock.clone();
    keep_going.store(true, Ordering::Relaxed);
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<Found>, String> {
        let _one_at_a_time = lock.lock().map_err(|_| "scan lock")?;
        // Its own apartment: the watcher's events are delivered by its pump.
        // SAFETY: first thing on this thread-pool thread; a second init is reported, not fatal.
        let _ = unsafe { RoInitialize(RO_INIT_SINGLETHREADED) };
        scan(timeout_ms, &keep_going)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Ends a scan in progress, so the adapter is free for a connection at once.
#[tauri::command]
pub async fn winble_stop_scan(state: State<'_, WinBle>) -> Result<(), String> {
    state.scanning.store(false, Ordering::Relaxed);
    Ok(())
}

/// Every UART service Windows lists for the device in this cache mode, each
/// with its handle. A UUID filter limits the results, but does not stop
/// Windows from discovering other apps' services on an Android phone.
fn uart_services(device: &BluetoothLEDevice, mode: BluetoothCacheMode) -> Result<Vec<(u16, GattDeviceService)>, String> {
    let result = wait(
        device
            .GetGattServicesForUuidWithCacheModeAsync(SERVICE, mode)
            .map_err(|e| err("services", e))?,
        "service discovery",
    )?;
    let status = result.Status().map_err(|e| err("services", e))?;
    if status != GattCommunicationStatus::Success {
        return Err(format!("service discovery: {status:?}"));
    }
    let list = result.Services().map_err(|e| err("services", e))?;
    Ok(list.into_iter().filter_map(|service| Some((service.AttributeHandle().ok()?, service))).collect())
}

/// Goes through the UART services Windows lists until one gives a link.
///
/// Windows' cache is asked first, and the device only when the cache has no
/// service, or none that still answers. An unresponsive vendor service on an
/// Android phone can stall a discovery on the device, so it is not forced on
/// every connection once Windows has found the UART service.
///
/// A phone hands its services out anew when its Bluetooth restarts, at other
/// handles, and does not tell a computer it is bonded with. Windows goes on
/// writing to the handles it remembers, and the phone answers that nothing is
/// there. Asked again, Windows lists the service a second time, where it is
/// now, beside the one that is gone: so every listing is tried, and one whose
/// characteristics Windows remembers before one it has to ask the device about.
fn link_through<S, L>(
    mut services: impl FnMut(BluetoothCacheMode) -> Result<Vec<(u16, S)>, String>,
    mut open: impl FnMut(&S, BluetoothCacheMode) -> Result<Option<L>, Refusal>,
) -> Result<L, String> {
    let mut seen: Vec<u16> = Vec::new();
    let mut moved: Option<String> = None;
    for mode in [BluetoothCacheMode::Cached, BluetoothCacheMode::Uncached] {
        let mut listed = services(mode)?;
        if mode == BluetoothCacheMode::Uncached {
            // Windows may have cached the phone before its app published the
            // UART service, so an empty cached list is not proof of absence.
            // And the answer to this question can itself come back empty and
            // still leave the service in the cache, which is where to look.
            log::debug!("winble: no UART service in the cache that answers; asked the device");
            listed.extend(services(BluetoothCacheMode::Cached)?);
        }
        let mut fresh: Vec<(u16, S)> = Vec::new();
        for (handle, service) in listed {
            if !seen.contains(&handle) {
                seen.push(handle);
                fresh.push((handle, service));
            }
        }
        let mut gone: Vec<u16> = Vec::new();
        for characteristics in [BluetoothCacheMode::Cached, BluetoothCacheMode::Uncached] {
            for (handle, service) in &fresh {
                if gone.contains(handle) {
                    continue;
                }
                match open(service, characteristics) {
                    Ok(Some(link)) => return Ok(link),
                    // Nothing cached for it; asked anew once the others have had their turn.
                    Ok(None) => {}
                    Err(Refusal::Moved(error)) => {
                        log::debug!("winble: the service at handle {handle} is no longer there: {error}");
                        gone.push(*handle);
                        moved = Some(error);
                    }
                    Err(Refusal::Failed(error)) => return Err(error),
                }
            }
        }
    }
    Err(moved.unwrap_or_else(|| "this device has no MeshCore UART service".into()))
}

fn characteristics_in(
    service: &GattDeviceService,
    mode: BluetoothCacheMode,
) -> Result<(Option<GattCharacteristic>, Option<GattCharacteristic>), Refusal> {
    let result = wait(
        service.GetCharacteristicsWithCacheModeAsync(mode).map_err(|e| err("characteristics", e))?,
        "characteristic discovery",
    )?;
    let status = result.Status().map_err(|e| err("characteristics", e))?;
    if status != GattCommunicationStatus::Success {
        return Err(gatt_refusal("characteristic discovery", status, result.ProtocolError().and_then(|e| e.Value()).ok()));
    }
    let mut rx = None;
    let mut tx = None;
    for c in &result.Characteristics().map_err(|e| err("characteristics", e))? {
        let uuid = c.Uuid().map_err(|e| err("characteristics", e))?;
        if uuid == RX {
            rx = Some(c);
        } else if uuid == TX {
            tx = Some(c);
        }
    }
    Ok((rx, tx))
}

/// A service with its UART characteristics, notifying: all of a link but the watch on the device.
struct Subscribed {
    service: GattDeviceService,
    rx: GattCharacteristic,
    tx: GattCharacteristic,
    value_token: i64,
}

/// Subscribes to the service's UART characteristics as this cache mode lists
/// them; `None` when the cache has none.
///
/// Asking the radio itself (`Uncached`) for the characteristics of a service
/// that demands encryption never returns on this stack once the device is
/// bonded — the encryption it starts in the middle of the discovery is never
/// finished — while the cache Windows filled at pairing answers at once and
/// the subscribe that follows raises the link without trouble. The radio is
/// only asked when the cache has nothing, which is the case before a bond.
fn subscribe_in(service: &GattDeviceService, mode: BluetoothCacheMode, on_frame: &Channel<Vec<u8>>) -> Result<Option<Subscribed>, Refusal> {
    // A cached service still needs access in this process. Open it for shared
    // use before enumerating its characteristics, and retain it in Link.
    let access = wait(service.RequestAccessAsync().map_err(|e| err("service access", e))?, "service access")?;
    if access != DeviceAccessStatus::Allowed {
        return Err(format!("service access: {access:?}").into());
    }
    let opened = wait(service.OpenAsync(GattSharingMode::SharedReadAndWrite).map_err(|e| err("service open", e))?, "service open")?;
    if opened != GattOpenStatus::Success && opened != GattOpenStatus::AlreadyOpened {
        return Err(format!("service open: {opened:?}").into());
    }
    let (rx, tx) = match characteristics_in(service, mode)? {
        (Some(rx), Some(tx)) => (rx, tx),
        _ if mode == BluetoothCacheMode::Cached => return Ok(None),
        // A service that has moved has nothing left under its old handle either.
        _ => return Err(Refusal::Moved("the UART service is missing its RX or TX characteristic".into())),
    };
    log::debug!("winble: characteristics found, {mode:?}");

    let sink = on_frame.clone();
    let value_token = tx
        .ValueChanged(&TypedEventHandler::new(
            move |_: windows::core::Ref<GattCharacteristic>, args: windows::core::Ref<GattValueChangedEventArgs>| {
                let Some(args) = args.as_ref() else { return Ok(()) };
                let buffer = args.CharacteristicValue()?;
                let len = buffer.Length()? as usize;
                let reader = DataReader::FromBuffer(&buffer)?;
                let mut bytes = vec![0u8; len];
                reader.ReadBytes(&mut bytes)?;
                log::trace!("winble: <- {len} bytes");
                let _ = sink.send(bytes);
                Ok(())
            },
        ))
        .map_err(|e| err("notify", e))?;

    let subscription = wait(
        tx.WriteClientCharacteristicConfigurationDescriptorWithResultAsync(GattClientCharacteristicConfigurationDescriptorValue::Notify)
            .map_err(|e| err("subscribe", e))?,
        "subscribe",
    )
    .map_err(Refusal::Failed)
    .and_then(|result| {
        let status = result.Status().map_err(|e| err("subscribe", e))?;
        if status == GattCommunicationStatus::Success {
            Ok(())
        } else {
            Err(gatt_refusal("subscribe", status, result.ProtocolError().and_then(|e| e.Value()).ok()))
        }
    });
    if let Err(refusal) = subscription {
        let _ = tx.RemoveValueChanged(value_token);
        return Err(refusal);
    }
    Ok(Some(Subscribed { service: service.clone(), rx, tx, value_token }))
}

fn close_link(link: Link) {
    let _ = link.tx.RemoveValueChanged(link.value_token);
    let _ = link.device.RemoveConnectionStatusChanged(link.status_token);
    if let Ok(op) = link
        .tx
        .WriteClientCharacteristicConfigurationDescriptorAsync(GattClientCharacteristicConfigurationDescriptorValue::None)
    {
        let _ = wait(op, "unsubscribe");
    }
    let _ = link.service.Close();
    let _ = link.device.Close();
    log::info!("winble: link closed");
}

fn open_link(app: AppHandle, id: u64, mac: u64, address: &str, on_frame: Channel<Vec<u8>>) -> Result<Link, String> {
    let device = wait(
        BluetoothLEDevice::FromBluetoothAddressAsync(mac).map_err(|e| err("device", e))?,
        "device lookup",
    )?;
    let name = device.Name().map(|n| n.to_string()).unwrap_or_default();
    log::info!(
        "winble: connecting to {name} ({address}), status {:?}",
        device.ConnectionStatus().map(|s| s.0).unwrap_or(-1)
    );

    // A radio with no bond here can fail in more ways than the ATT codes
    // `wait` knows — a refused discovery, or no answer at all — and the way
    // out of each is the same: pair.
    let paired = device.DeviceInformation().and_then(|i| i.Pairing()).and_then(|p| p.IsPaired()).unwrap_or(true);
    let unpaired = |e: String| if paired || e.contains("NEEDS_PAIRING") { e } else { format!("{e}. NEEDS_PAIRING") };

    let Subscribed { service, rx, tx, value_token } =
        link_through(|mode| uart_services(&device, mode), |service, mode| subscribe_in(service, mode, &on_frame)).map_err(unpaired)?;

    let status_token = device
        .ConnectionStatusChanged(&TypedEventHandler::new(
            move |sender: windows::core::Ref<BluetoothLEDevice>, _: windows::core::Ref<windows::core::IInspectable>| {
                if let Some(device) = sender.as_ref() {
                    if device.ConnectionStatus()? == BluetoothConnectionStatus::Disconnected {
                        let _ = app.emit(CLOSED_EVENT, "Bluetooth device disconnected");
                    }
                }
                Ok(())
            },
        ))
        .map_err(|e| err("status", e))?;

    log::info!("winble: link up to {name}");
    Ok(Link { id, device, service, rx, tx, value_token, status_token })
}

/// Bonds with the radio using the PIN its screen shows (or its configured
/// one). A bond that already exists is dropped first, since the only reason to
/// be here with one is that the radio no longer honours it.
fn pair(mac: u64, pin: &str) -> Result<String, String> {
    let device = wait(
        BluetoothLEDevice::FromBluetoothAddressAsync(mac).map_err(|e| err("device", e))?,
        "device lookup",
    )?;
    let name = device.Name().map(|n| n.to_string()).unwrap_or_default();
    let pairing = device
        .DeviceInformation()
        .and_then(|i| i.Pairing())
        .map_err(|e| err("pairing", e))?;
    if pairing.IsPaired().map_err(|e| err("pairing", e))? {
        log::info!("winble: dropping the old bond with {name}");
        let result = wait(pairing.UnpairAsync().map_err(|e| err("unpair", e))?, "unpair")?;
        let status = result.Status().map_err(|e| err("unpair", e))?;
        if status != DeviceUnpairingResultStatus::Unpaired {
            return Err(format!("unpair: {status:?}"));
        }
    }
    let custom: DeviceInformationCustomPairing = pairing.Custom().map_err(|e| err("pairing", e))?;
    let pin = HSTRING::from(pin.trim());
    let token = custom
        .PairingRequested(&TypedEventHandler::new(
            move |_: windows::core::Ref<DeviceInformationCustomPairing>, args: windows::core::Ref<DevicePairingRequestedEventArgs>| {
                let Some(args) = args.as_ref() else { return Ok(()) };
                let kind = args.PairingKind()?;
                log::debug!("winble: pairing asks for {kind:?}");
                if kind == DevicePairingKinds::ProvidePin {
                    args.AcceptWithPin(&pin)?;
                } else {
                    args.Accept()?;
                }
                Ok(())
            },
        ))
        .map_err(|e| err("pairing", e))?;
    let kinds = DevicePairingKinds::ProvidePin | DevicePairingKinds::ConfirmOnly | DevicePairingKinds::ConfirmPinMatch;
    let result = wait(
        custom
            .PairWithProtectionLevelAsync(kinds, DevicePairingProtectionLevel::EncryptionAndAuthentication)
            .map_err(|e| err("pairing", e))?,
        "pairing",
    );
    let _ = custom.RemovePairingRequested(token);
    let result = result?;
    let status = result.Status().map_err(|e| err("pairing", e))?;
    if status != DevicePairingResultStatus::Paired {
        return Err(format!("pairing {name}: {status:?}. Check the PIN on the radio's screen."));
    }
    log::info!("winble: paired with {name}");
    Ok(name)
}

/// Pairs with a radio by address, with its PIN. Answers with the radio's name.
#[tauri::command]
pub async fn winble_pair(app: AppHandle, address: String, pin: String) -> Result<String, String> {
    let mac = parse_address(&address)?;
    on_worker(&app, move |worker| {
        if let Some(old) = worker.link.take() {
            close_link(old);
        }
        pair(mac, &pin)
    })
    .await
}

/// Opens the link. Frames the radio sends arrive on `on_frame`; `winble:closed` says when it drops.
#[tauri::command]
pub async fn winble_connect(app: AppHandle, address: String, on_frame: Channel<Vec<u8>>) -> Result<Connected, String> {
    let mac = parse_address(&address)?;
    let events = app.clone();
    on_worker(&app, move |worker| {
        if let Some(old) = worker.link.take() {
            close_link(old);
        }
        worker.opened += 1;
        let id = worker.opened;
        let link = open_link(events, id, mac, &address, on_frame)?;
        let name = link.device.Name().map(|n| n.to_string()).unwrap_or_default();
        worker.link = Some(link);
        Ok(Connected { name, link: id })
    })
    .await
}

/// One frame, written with response so a refusal is heard rather than dropped.
#[tauri::command]
pub async fn winble_send(app: AppHandle, data: Vec<u8>) -> Result<(), String> {
    on_worker(&app, move |worker| {
        let link = worker.link.as_ref().ok_or("not connected")?;
        let writer = DataWriter::new().map_err(|e| err("write", e))?;
        writer.WriteBytes(&data).map_err(|e| err("write", e))?;
        let buffer = writer.DetachBuffer().map_err(|e| err("write", e))?;
        let result = wait(link.rx.WriteValueWithResultAsync(&buffer).map_err(|e| err("write", e))?, "write")?;
        let status = result.Status().map_err(|e| err("write", e))?;
        if status != GattCommunicationStatus::Success {
            return Err(format!("write: {status:?}"));
        }
        log::trace!("winble: -> {} bytes", data.len());
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn winble_disconnect(app: AppHandle, link: Option<u64>) -> Result<(), String> {
    on_worker(&app, move |worker| {
        // A connect given up on can finish after the next one has begun, and
        // its close then waits behind that connect: it must not take the new link down.
        if worker.link.as_ref().is_some_and(|open| link.is_none_or(|id| open.id == id)) {
            if let Some(open) = worker.link.take() {
                close_link(open);
            }
        }
        Ok(())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    const CACHED: BluetoothCacheMode = BluetoothCacheMode::Cached;
    const UNCACHED: BluetoothCacheMode = BluetoothCacheMode::Uncached;

    fn stale() -> Refusal {
        gatt_refusal("subscribe", GattCommunicationStatus::ProtocolError, Some(0x01))
    }

    #[test]
    fn a_cached_uart_does_not_query_the_device_again() {
        let link = link_through(
            |mode| {
                assert_eq!(mode, CACHED);
                Ok(vec![(265, "Android UART")])
            },
            |service, _| Ok(Some(*service)),
        )
        .unwrap();
        assert_eq!(link, "Android UART");
    }

    #[test]
    fn a_uart_published_after_the_cached_list_is_discovered_on_the_device() {
        let mut modes = Vec::new();
        let link = link_through(
            |mode| {
                modes.push(mode);
                Ok(if mode == UNCACHED { vec![(40, "iPhone UART")] } else { vec![] })
            },
            |service, _| Ok(Some(*service)),
        )
        .unwrap();
        assert_eq!(link, "iPhone UART");
        assert_eq!(modes, [CACHED, UNCACHED, CACHED]);
    }

    #[test]
    fn a_missing_uart_is_reported_only_after_uncached_discovery() {
        let mut modes = Vec::new();
        let result = link_through::<(), ()>(
            |mode| {
                modes.push(mode);
                Ok(vec![])
            },
            |_, _| unreachable!(),
        );
        assert_eq!(result.unwrap_err(), "this device has no MeshCore UART service");
        assert_eq!(modes, [CACHED, UNCACHED, CACHED]);
    }

    #[test]
    fn discovery_errors_are_preserved_without_an_extra_query() {
        for fail_at in [CACHED, UNCACHED] {
            let mut modes = Vec::new();
            let result = link_through::<(), ()>(
                |mode| {
                    modes.push(mode);
                    if mode == fail_at { Err("service discovery: unavailable".into()) } else { Ok(vec![]) }
                },
                |_, _| unreachable!(),
            );
            assert_eq!(result.unwrap_err(), "service discovery: unavailable");
            let expected = if fail_at == CACHED { 1 } else { 2 };
            assert_eq!(modes.len(), expected);
        }
    }

    #[test]
    fn a_service_the_phone_moved_is_found_where_it_is_now() {
        // What a realme did: Windows remembered the service at 302, the phone
        // had it at 265, and asking the phone came back empty but left both in the cache.
        let mut asked = 0;
        let mut opened = Vec::new();
        let link = link_through(
            |mode| {
                asked += 1;
                Ok(if mode == UNCACHED {
                    vec![]
                } else if asked == 1 {
                    vec![(302, "old")]
                } else {
                    vec![(265, "new"), (302, "old")]
                })
            },
            |service, mode| {
                opened.push((*service, mode));
                if *service == "old" { Err(stale()) } else { Ok(Some(*service)) }
            },
        )
        .unwrap();
        assert_eq!(link, "new");
        assert_eq!(opened, [("old", CACHED), ("new", CACHED)]);
    }

    #[test]
    fn a_listing_windows_remembers_in_full_goes_before_one_it_must_ask_about() {
        let mut opened = Vec::new();
        let link = link_through(
            |_| Ok(vec![(302, "old"), (265, "new")]),
            |service, mode| {
                opened.push((*service, mode));
                Ok(if *service == "new" { Some(*service) } else { None })
            },
        )
        .unwrap();
        assert_eq!(link, "new");
        assert_eq!(opened, [("old", CACHED), ("new", CACHED)]);
    }

    #[test]
    fn a_service_with_nothing_cached_is_asked_about_on_the_device() {
        let mut opened = Vec::new();
        let link = link_through(
            |_| Ok(vec![(14, "radio")]),
            |service, mode| {
                opened.push(mode);
                Ok(if mode == UNCACHED { Some(*service) } else { None })
            },
        )
        .unwrap();
        assert_eq!(link, "radio");
        assert_eq!(opened, [CACHED, UNCACHED]);
    }

    #[test]
    fn a_refusal_that_is_not_about_the_handle_ends_the_search() {
        let mut modes = Vec::new();
        let result = link_through::<_, ()>(
            |mode| {
                modes.push(mode);
                Ok(vec![(265, "phone"), (302, "phone")])
            },
            |_, _| Err(gatt_refusal("subscribe", GattCommunicationStatus::ProtocolError, Some(0x05))),
        );
        assert!(result.unwrap_err().contains("NEEDS_PAIRING"));
        assert_eq!(modes, [CACHED]);
    }

    #[test]
    fn a_service_gone_for_good_is_reported_as_the_phone_answered() {
        let result = link_through::<_, ()>(|_| Ok(vec![(302, "old")]), |_, _| Err(stale()));
        assert!(result.unwrap_err().contains("ATT 0x01"));
    }

    #[test]
    fn only_answers_about_the_handle_send_the_search_on() {
        for code in [0x01, 0x03, 0x06, 0x0A] {
            assert!(matches!(gatt_refusal("subscribe", GattCommunicationStatus::ProtocolError, Some(code)), Refusal::Moved(_)));
        }
        for code in [None, Some(0x05), Some(0x08), Some(0x0E), Some(0x0F)] {
            assert!(matches!(gatt_refusal("subscribe", GattCommunicationStatus::ProtocolError, code), Refusal::Failed(_)));
        }
        assert!(matches!(gatt_refusal("subscribe", GattCommunicationStatus::Unreachable, Some(0x01)), Refusal::Failed(_)));
    }

    #[test]
    fn temporary_gatt_failures_do_not_request_bond_repair() {
        for status in [GattCommunicationStatus::Unreachable, GattCommunicationStatus::AccessDenied] {
            assert!(!gatt_failure("characteristic discovery", status, None).contains("NEEDS_PAIRING"));
        }
        for code in [None, Some(0x01), Some(0x03), Some(0x0E)] {
            assert!(!gatt_failure("subscribe", GattCommunicationStatus::ProtocolError, code).contains("NEEDS_PAIRING"));
        }
    }

    #[test]
    fn a_worker_stuck_in_a_call_is_replaced_and_what_queued_behind_it_never_runs() {
        let ble = Arc::new(WinBle::with_stall(Duration::from_millis(300)));
        let (release, hold) = mpsc::channel::<()>();
        let stuck = {
            let ble = ble.clone();
            std::thread::spawn(move || {
                ble.run(move |_| {
                    let _ = hold.recv();
                    Ok(())
                })
            })
        };
        std::thread::sleep(Duration::from_millis(50));
        let ran = Arc::new(AtomicBool::new(false));
        let behind = {
            let (ble, ran) = (ble.clone(), ran.clone());
            std::thread::spawn(move || {
                ble.run(move |_| {
                    ran.store(true, Ordering::Relaxed);
                    Ok(())
                })
            })
        };
        assert!(stuck.join().unwrap().is_err());
        assert!(behind.join().unwrap().is_err());

        assert_eq!(ble.run(|_| Ok(7)).unwrap(), Ok(7));
        release.send(()).unwrap();
        std::thread::sleep(Duration::from_millis(100));
        assert!(!ran.load(Ordering::Relaxed));
    }

    #[test]
    fn a_long_wait_that_keeps_pumping_is_not_given_up_on() {
        let ble = WinBle::with_stall(Duration::from_millis(300));
        let answer = ble.run(|_| {
            let until = Instant::now() + Duration::from_millis(1000);
            while Instant::now() < until {
                pump();
                std::thread::sleep(Duration::from_millis(5));
            }
            Ok(1)
        });
        assert_eq!(answer.unwrap(), Ok(1));
    }

    #[test]
    fn att_security_failures_request_bond_repair_and_keep_the_error_code() {
        for code in [0x05, 0x08, 0x0F] {
            let error = gatt_failure("subscribe", GattCommunicationStatus::ProtocolError, Some(code));
            assert!(error.contains("NEEDS_PAIRING"));
            assert!(error.contains(&format!("ATT 0x{code:02X}")));
        }
    }
}
