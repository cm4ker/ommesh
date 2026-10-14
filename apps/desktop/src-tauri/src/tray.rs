//! The app's icon by the clock. Closing the window puts the app there rather
//! than ending it, so the radio stays connected and messages keep being
//! announced; a click on the icon brings the window back, and its menu is
//! where the app is quit.
//!
//! The icon carries a dot while anything is unread, told by the page
//! (`tray_unread`): red for a message from a person, amber for channels and
//! rooms only. Its tooltip names the radio and counts both; the window's
//! title names the radio too, which is how copies of the app opened for
//! different radios are told apart (`instance.rs`). Its words are the page's,
//! in the reader's language (`tray_words`), English until the page has said.
//!
//! The window's taskbar button carries the count as well: on Windows a badge
//! over the button's corner that the page draws (`badge`), elsewhere the
//! number the dock or launcher draws.

use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(windows)]
use std::sync::Mutex;

use tauri::image::Image;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{App, AppHandle, Manager, Runtime, WebviewWindow, Window, WindowEvent};
use tauri_plugin_window_state::AppHandleExt;

const ID: &str = "main";
const ICON: &[u8] = include_bytes!("../icons/32x32.png");

/// A message from a person: the one that matters most, so it wins the dot.
const DIRECT: [u8; 3] = [0xe5, 0x48, 0x4d];
/// Channels and rooms, with no message from a person among them.
const CHATS: [u8; 3] = [0xf5, 0xa5, 0x24];

/// Whether the icon is there. Where it could not be made (a Linux desktop
/// without an indicator area), closing the window ends the app as it always did.
static SHOWN: AtomicBool = AtomicBool::new(false);

/// The taskbar button's badge as the page drew it, a PNG, kept to be put back:
/// the button goes when the window goes to the tray, and comes back bare.
#[cfg(windows)]
static BADGE: Mutex<Option<Vec<u8>>> = Mutex::new(None);

/// Puts the icon by the clock. A failure leaves the app without one, and nothing else.
pub fn install(app: &App) {
    match build(app) {
        Ok(_) => SHOWN.store(true, Ordering::Relaxed),
        Err(error) => log::warn!("no tray icon: {error}"),
    }
}

fn menu<R: Runtime, M: Manager<R>>(app: &M, open: &str, another: &str, quit: &str) -> tauri::Result<Menu<R>> {
    let open = MenuItem::with_id(app, "open", open, true, None::<&str>)?;
    let another = MenuItem::with_id(app, "another", another, true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", quit, true, None::<&str>)?;
    Menu::with_items(app, &[&open, &another, &quit])
}

fn build(app: &App) -> tauri::Result<TrayIcon> {
    let menu = menu(app, "Open Ommesh", "Another window", "Quit")?;
    TrayIconBuilder::with_id(ID)
        .icon(Image::from_bytes(ICON)?)
        .tooltip(&app.package_info().name)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => bring_back(app),
            "another" => {
                if let Err(error) = crate::instance::open_another() {
                    log::warn!("no other window: {error}");
                }
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                bring_back(tray.app_handle());
            }
        })
        .build(app)
}

/// Whether the window can go to the tray, where there is one to go to.
pub fn available() -> bool {
    SHOWN.load(Ordering::Relaxed)
}

/// Sends the window to the tray, off the taskbar.
pub fn stow<R: Runtime>(window: &WebviewWindow<R>) {
    let _ = window.hide();
}

/// The window's close button, while there is a tray: the window hides and the app goes on.
/// Where it was is written down then, as the app may next end with the
/// computer, with no quitting of its own to write it at.
///
/// The taskbar badge goes back on the button whenever the window takes the
/// focus, as it does on coming back from the tray.
pub fn on_window_event<R: Runtime>(window: &Window<R>, event: &WindowEvent) {
    match event {
        WindowEvent::CloseRequested { api, .. } if available() && window.label() == ID => {
            api.prevent_close();
            let _ = window.app_handle().save_window_state(crate::WINDOW_STATE);
            let _ = window.hide();
        }
        #[cfg(windows)]
        WindowEvent::Focused(true) if window.label() == ID => {
            if let Some(window) = window.app_handle().get_webview_window(ID) {
                overlay(&window);
            }
        }
        _ => {}
    }
}

/// The window, shown, restored and in front.
pub fn bring_back<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window(ID) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// The menu's words, in the page's language.
#[tauri::command]
pub fn tray_words(app: AppHandle, open: String, another: String, quit: String) -> Result<(), String> {
    let Some(tray) = app.tray_by_id(ID) else {
        return Ok(());
    };
    let menu = menu(&app, &open, &another, &quit).map_err(|error| error.to_string())?;
    tray.set_menu(Some(menu)).map_err(|error| error.to_string())
}

/// What is unread, from the page: messages from people, and in channels and rooms,
/// and how the tooltip says it (`detail`), in the page's words; the radio's name,
/// for the tooltip and the window's title, once the radio has said it; and the
/// taskbar button's badge, a PNG in base64, while anything is unread.
#[tauri::command]
pub fn tray_unread(
    app: AppHandle,
    direct: u32,
    chats: u32,
    detail: Option<String>,
    radio: Option<String>,
    badge: Option<String>,
) -> Result<(), String> {
    let name = match radio.as_deref().map(str::trim) {
        Some(radio) if !radio.is_empty() => format!("{radio} — {}", app.package_info().name),
        _ => app.package_info().name.clone(),
    };
    if let Some(window) = app.get_webview_window(ID) {
        let _ = window.set_title(&name);
        taskbar(&window, direct + chats, badge.as_deref());
    }
    let Some(tray) = app.tray_by_id(ID) else {
        return Ok(());
    };
    let detail = detail.unwrap_or_else(|| match (direct, chats) {
        (0, 0) => String::new(),
        (d, 0) => format!("{d} from people"),
        (0, c) => format!("{c} in chats"),
        (d, c) => format!("{d} from people, {c} in chats"),
    });
    let tooltip = if detail.is_empty() {
        name.clone()
    } else {
        format!("{name}: {detail}")
    };
    let dot = if direct > 0 {
        Some(DIRECT)
    } else if chats > 0 {
        Some(CHATS)
    } else {
        None
    };
    let icon = Image::from_bytes(ICON).map_err(|error| error.to_string())?;
    let icon = match dot {
        Some(color) => marked(&icon, color),
        None => icon,
    };
    tray.set_icon(Some(icon)).map_err(|error| error.to_string())?;
    tray.set_tooltip(Some(tooltip)).map_err(|error| error.to_string())
}

/// The count on the taskbar button. Windows has no number of its own there,
/// only a small picture over the button's corner, which the page draws;
/// a picture that does not decode leaves the button without one.
#[cfg(windows)]
fn taskbar<R: Runtime>(window: &WebviewWindow<R>, _count: u32, badge: Option<&str>) {
    use base64::Engine;
    let png = badge.and_then(|badge| base64::engine::general_purpose::STANDARD.decode(badge).ok());
    *BADGE.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = png;
    overlay(window);
}

/// The dock's number on macOS, the launcher's on Linux.
#[cfg(not(windows))]
fn taskbar<R: Runtime>(window: &WebviewWindow<R>, count: u32, _badge: Option<&str>) {
    let _ = window.set_badge_count((count > 0).then_some(count as i64));
}

/// Puts the kept badge on the button, or takes it off.
#[cfg(windows)]
fn overlay<R: Runtime>(window: &WebviewWindow<R>) {
    let png = BADGE.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone();
    let icon = png.and_then(|png| Image::from_bytes(&png).ok());
    if let Err(error) = window.set_overlay_icon(icon) {
        log::warn!("no taskbar badge: {error}");
    }
}

/// The icon with a dot in its lower right corner, ringed with clear pixels so
/// it reads on a light taskbar and a dark one alike. Edges are blended by how
/// much of each pixel the circle covers, sampled 4 × 4.
fn marked(icon: &Image<'_>, color: [u8; 3]) -> Image<'static> {
    let (width, height) = (icon.width(), icon.height());
    let mut rgba = icon.rgba().to_vec();
    let size = width.min(height) as f32;
    let radius = size * 0.24;
    let ring = size * 0.07;
    let (cx, cy) = (width as f32 - radius - ring * 0.5, height as f32 - radius - ring * 0.5);

    for y in 0..height {
        for x in 0..width {
            let (mut inside, mut near) = (0u32, 0u32);
            for sy in 0..4 {
                for sx in 0..4 {
                    let dx = x as f32 + (sx as f32 + 0.5) / 4.0 - cx;
                    let dy = y as f32 + (sy as f32 + 0.5) / 4.0 - cy;
                    let distance = (dx * dx + dy * dy).sqrt();
                    if distance <= radius {
                        inside += 1;
                    } else if distance <= radius + ring {
                        near += 1;
                    }
                }
            }
            if inside + near == 0 {
                continue;
            }
            let pixel = &mut rgba[((y * width + x) * 4) as usize..][..4];
            // The ring cuts the icon away; the dot is painted over what is left.
            let kept = 1.0 - (inside + near) as f32 / 16.0;
            let dot = inside as f32 / 16.0;
            let alpha = pixel[3] as f32 / 255.0 * kept;
            let out = alpha + dot;
            for channel in 0..3 {
                let under = pixel[channel] as f32 * alpha;
                let over = color[channel] as f32 * dot;
                pixel[channel] = if out > 0.0 { ((under + over) / out).round() as u8 } else { 0 };
            }
            pixel[3] = (out.min(1.0) * 255.0).round() as u8;
        }
    }
    Image::new_owned(rgba, width, height)
}
