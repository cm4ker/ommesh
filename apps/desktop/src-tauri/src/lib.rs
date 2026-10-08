//! The desktop shell: a window around the client, with the links a browser
//! cannot offer (BLE, the cable, a socket to a radio on Wi-Fi) and the
//! system's credential store for the node passwords it keeps. Everything else — the protocol, the state, the
//! screens — is the client's, and the same on every platform.

mod announce;
mod coverage;
mod instance;
mod notices;
mod preview;
mod secrets;
mod tcp;
mod tray;
mod updates;
#[cfg(windows)]
mod winble;

use tauri::Manager;
use tauri_plugin_window_state::StateFlags;

/// What the system passes when it starts the app at login: the window opens minimised.
const MINIMIZED: &str = "--minimized";

/// What of the window is kept between runs: where it was, its size, and
/// whether it was maximised. Whether it was shown is the tray's business.
pub(crate) const WINDOW_STATE: StateFlags =
    StateFlags::POSITION.union(StateFlags::SIZE).union(StateFlags::MAXIMIZED);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // `RUST_LOG=debug` from a terminal shows what the plugins do with the link.
    let _ = env_logger::try_init();
    let context = tauri::generate_context!();
    let copy = instance::take(&context.config().identifier);
    let mut builder = tauri::Builder::default();
    // The app lives in the tray with its window closed, so starting it
    // again, from the Start menu say, brings that window back rather
    // than a second app fighting the first for the radio. A copy opened for
    // another radio is the one start that does not. Registered first, as the plugin asks.
    if !std::env::args().any(|arg| arg == instance::ANOTHER) {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| tray::bring_back(app)));
    }
    let builder = builder
        .plugin(instance::plugin(copy))
        // Put back as the window is made, before `setup` sends it to the tray at login.
        // The plugin writes it down when the app quits; `tray` and `updates`
        // do so too where the app goes without saying.
        // The notices window places itself in a corner each time; kept, it would come back where it last was.
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_filename(instance::window_state_file(copy))
                .with_state_flags(WINDOW_STATE)
                .with_denylist(&[notices::LABEL])
                .build(),
        )
        // The entry keeps the name it had before the app became Ommesh, so an autostart
        // turned on back then still counts; the installer's hooks remove it by that name.
        .plugin(tauri_plugin_autostart::Builder::new().app_name("Meshnet").arg(MINIMIZED).build())
        .setup(|app| {
            tray::install(app);
            if std::env::args().any(|arg| arg == MINIMIZED) {
                if let Some(window) = app.get_webview_window("main") {
                    if tray::available() {
                        tray::stow(&window);
                    } else {
                        let _ = window.minimize();
                    }
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == notices::LABEL {
                notices::on_window_event(window, event);
            } else {
                tray::on_window_event(window, event);
            }
        })
        .plugin(tauri_plugin_blec::init())
        .plugin(tauri_plugin_serialplugin::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(tcp::Tcp::default())
        .manage(notices::Notices::default());

    #[cfg(windows)]
    let builder = builder.manage(winble::WinBle::default()).invoke_handler(tauri::generate_handler![
        updates::desktop_update_info,
        updates::desktop_check_update,
        instance::desktop_open_another,
        winble::winble_scan,
        winble::winble_stop_scan,
        winble::winble_pair,
        winble::winble_connect,
        winble::winble_send,
        winble::winble_disconnect,
        tcp::tcp_open,
        tcp::tcp_write,
        tcp::tcp_close,
        announce::announce,
        announce::withdraw,
        notices::notice_card,
        notices::notice_withdraw,
        notices::notice_ready,
        notices::notice_layout,
        notices::notice_open,
        notices::notice_act,
        notices::chime,
        tray::tray_unread,
        tray::tray_words,
        secrets::secret_get,
        secrets::secret_set,
        secrets::secret_delete,
        coverage::coverage_upload,
        preview::link_fetch,
    ]);
    #[cfg(not(windows))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        updates::desktop_update_info,
        updates::desktop_check_update,
        instance::desktop_open_another,
        tcp::tcp_open,
        tcp::tcp_write,
        tcp::tcp_close,
        announce::announce,
        announce::withdraw,
        notices::notice_card,
        notices::notice_withdraw,
        notices::notice_ready,
        notices::notice_layout,
        notices::notice_open,
        notices::notice_act,
        notices::chime,
        tray::tray_unread,
        tray::tray_words,
        secrets::secret_get,
        secrets::secret_set,
        secrets::secret_delete,
        coverage::coverage_upload,
        preview::link_fetch,
    ]);

    builder
        .run(context)
        .expect("error while running the desktop shell");
}
