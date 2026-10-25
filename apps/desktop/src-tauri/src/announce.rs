//! A system notification for a message or a new node, while the window is
//! elsewhere. WebView2 has no notification of its own to draw, so the page
//! asks the shell for one, and takes it back once what it said is read.
//!
//! Every desktop can draw the notice; what the notification plugin cannot do
//! on Windows is say *who* is speaking, or give a notice a tag to replace or
//! withdraw it by. A toast is drawn on behalf of an AppUserModelID, and the
//! plugin sets none outside an installed build, so the notice would arrive as
//! "Windows PowerShell". So on Windows the toast is drawn here, for an ID that
//! is named in the registry here, always. (Sovabox's shell names it the same way.)

use tauri::AppHandle;

/// The event the page listens for, carrying the tag of the notice that was
/// clicked. The page remembers what the tag was about; the shell does not.
const OPENED: &str = "notification-opened";

/// The group every notice of this app is filed under in the notification centre.
#[cfg(windows)]
const GROUP: &str = "meshnet";

/// Draws one, in place of the one out with the same tag. A click on it, on
/// Windows, brings the window forward and hands the page the tag; elsewhere
/// the plugin has no click to report, and the notice is only a notice.
///
/// `avatar`, a PNG in base64, is who it is from (gh #25): Windows draws it
/// cropped round beside the text. `signal` is the app's sound, which plays
/// here (`notices::play`) while the toast itself stays silent, since a toast
/// from an app without a package can only take the system's own sounds.
///
/// `quiet`, while Do not disturb is on, puts the toast straight into the
/// notification centre without popping it up or playing the signal. Other
/// systems have no notice kept without popping up, so there it is left out.
#[tauri::command]
pub fn announce(app: AppHandle, title: String, body: String, tag: Option<String>, avatar: Option<String>, signal: Option<String>, quiet: Option<bool>) -> Result<(), String> {
    let quiet = quiet.unwrap_or(false);
    if quiet && !cfg!(windows) {
        return Ok(());
    }
    let picture = avatar.as_deref().and_then(|png| picture(&app, png));
    let shown = show(&app, &title, &body, tag, picture.as_deref(), quiet)?;
    if shown && !quiet && !crate::notices::quiet() {
        crate::notices::play(signal.as_deref().unwrap_or("none"));
    }
    Ok(())
}

/// The avatar as a file the notification platform can read, named by its
/// content so each circle is written once and found again.
fn picture(app: &AppHandle, base64: &str) -> Option<std::path::PathBuf> {
    use base64::Engine;
    use tauri::Manager;

    let bytes = base64::engine::general_purpose::STANDARD.decode(base64).ok()?;
    let hash = bytes.iter().fold(0xcbf2_9ce4_8422_2325_u64, |hash, byte| (hash ^ u64::from(*byte)).wrapping_mul(0x0000_0100_0000_01b3));
    let directory = app.path().app_local_data_dir().ok()?.join("avatars");
    let path = directory.join(format!("{hash:016x}.png"));
    if !path.exists() {
        std::fs::create_dir_all(&directory).ok()?;
        std::fs::write(&path, &bytes).ok()?;
    }
    Some(path)
}

/// Takes back the notice out with this tag, on Windows; the plugin elsewhere
/// has no way to, and the notice stays until it is dismissed.
#[tauri::command]
pub fn withdraw(app: AppHandle, tag: String) -> Result<(), String> {
    remove(&app, &tag)
}

/// Whether Windows will show it: a toast to an app whose notices are
/// turned off in Settings is dropped without a word, and then its sound
/// should not play either.
#[cfg(windows)]
fn show(app: &AppHandle, title: &str, body: &str, tag: Option<String>, picture: Option<&std::path::Path>, quiet: bool) -> Result<bool, String> {
    use windows::core::{IInspectable, HSTRING};
    use windows::Data::Xml::Dom::XmlDocument;
    use windows::Foundation::TypedEventHandler;
    use windows::UI::Notifications::{NotificationSetting, ToastNotification, ToastNotificationManager};

    let app_id = app.config().identifier.clone();
    register(app, &app_id, &app.package_info().name);

    // The circle beside the text, where Windows otherwise draws nothing; a file URI with forward slashes.
    let image = picture
        .map(|path| {
            let uri = format!("file:///{}", path.to_string_lossy().replace('\\', "/").replace(' ', "%20"));
            format!(r#"<image placement="appLogoOverride" hint-crop="circle" src="{}"/>"#, escape(&uri))
        })
        .unwrap_or_default();

    let clicked = app.clone();
    let draw = || -> windows::core::Result<bool> {
        let xml = XmlDocument::new()?;
        xml.LoadXml(&HSTRING::from(format!(
            r#"<toast><visual><binding template="ToastGeneric"><text>{}</text><text>{}</text>{}</binding></visual><audio silent="true"/></toast>"#,
            escape(title),
            escape(body),
            image
        )))?;
        let toast = ToastNotification::CreateToastNotification(&xml)?;
        if quiet {
            toast.SetSuppressPopup(true)?;
        }
        if let Some(tag) = &tag {
            toast.SetTag(&HSTRING::from(slot(tag)))?;
            toast.SetGroup(&HSTRING::from(GROUP))?;
        }
        // Fired on a thread of the notification platform's, while this
        // process runs. A toast clicked after the window has closed launches
        // nothing: that takes a COM activator an installer registers.
        let tag = tag.clone();
        toast.Activated(&TypedEventHandler::<ToastNotification, IInspectable>::new(move |_, _| {
            opened(&clicked, tag.clone());
            Ok(())
        }))?;
        let notifier = ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(&app_id))?;
        notifier.Show(&toast)?;
        Ok(notifier.Setting().map(|setting| setting == NotificationSetting::Enabled).unwrap_or(true))
    };
    draw().map_err(|error| error.to_string())
}

#[cfg(windows)]
fn remove(app: &AppHandle, tag: &str) -> Result<(), String> {
    use windows::core::HSTRING;
    use windows::UI::Notifications::ToastNotificationManager;

    let app_id = app.config().identifier.clone();
    ToastNotificationManager::History()
        .and_then(|history| history.RemoveGroupedTagWithId(&HSTRING::from(slot(tag)), &HSTRING::from(GROUP), &HSTRING::from(app_id)))
        .map_err(|error| error.to_string())
}

/// A toast's tag holds 64 characters at most, and a conversation's tag
/// carries a 64-digit key: so the toast is tagged with a hash of it, FNV-1a.
#[cfg(windows)]
fn slot(tag: &str) -> String {
    let hash = tag.bytes().fold(0xcbf2_9ce4_8422_2325_u64, |hash, byte| (hash ^ u64::from(byte)).wrapping_mul(0x0000_0100_0000_01b3));
    format!("{hash:016x}")
}

/// Text for the toast's XML.
#[cfg(windows)]
fn escape(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;").replace('\'', "&apos;")
}

/// macOS notifies on behalf of a bundle and the plugin names it; Linux names
/// the sender in the notice. The plugin is right there as it is.
#[cfg(not(windows))]
fn show(app: &AppHandle, title: &str, body: &str, _tag: Option<String>, _picture: Option<&std::path::Path>, _quiet: bool) -> Result<bool, String> {
    use tauri_plugin_notification::NotificationExt;

    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map(|_| false)
        .map_err(|error| error.to_string())
}

#[cfg(not(windows))]
fn remove(_app: &AppHandle, _tag: &str) -> Result<(), String> {
    Ok(())
}

/// Brings the main window forward on what a notice was about: a toast's click, or a click on one of the app's own cards.
pub(crate) fn opened(app: &AppHandle, tag: Option<String>) {
    use tauri::{Emitter, Manager};

    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
    let _ = app.emit_to("main", OPENED, serde_json::json!({ "tag": tag }));
}

/// Says what this AppUserModelID is called, once per run, installed or not:
/// a name and an icon under `HKCU\Software\Classes\AppUserModelId\<id>`,
/// which is where the notification centre looks for both. Where the key
/// exists it wins over the installer's shortcut, and it outlives the build
/// that wrote it, so every build writes the name it has now and an icon kept
/// in the application's own data, never a path into a checkout.
///
/// Failure is silent: a notice that a message arrived should not come with
/// one that a registry key could not be written.
#[cfg(windows)]
fn register(app: &AppHandle, app_id: &str, name: &str) {
    use std::sync::Once;

    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        let Some(icon) = icon_file(app) else {
            return;
        };
        // The per-user notification service (`WpnUserService`) keeps the name
        // and icon it found the first time, so a change shows after that
        // service restarts, which a sign-out does.
        let _ = describe(app_id, name, &icon.to_string_lossy());
    });
}

/// The window's icon, written where the notification platform can read it.
/// Joined one segment at a time: a path with both kinds of separator in it
/// draws no icon at all.
#[cfg(windows)]
fn icon_file(app: &AppHandle) -> Option<std::path::PathBuf> {
    use tauri::Manager;

    const ICON: &[u8] = include_bytes!("../icons/128x128.png");

    let directory = app.path().app_local_data_dir().ok()?;
    let path = directory.join("notification.png");
    if std::fs::read(&path).ok().as_deref() != Some(ICON) {
        std::fs::create_dir_all(&directory).ok()?;
        std::fs::write(&path, ICON).ok()?;
    }
    Some(path)
}

#[cfg(windows)]
fn describe(app_id: &str, name: &str, icon: &str) -> Result<(), u32> {
    use windows_sys::Win32::Foundation::ERROR_SUCCESS;
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegCreateKeyExW, RegSetValueExW, HKEY, HKEY_CURRENT_USER, KEY_WRITE, REG_OPTION_NON_VOLATILE, REG_SZ,
    };

    /// UTF-16 with a terminating null, which the registry counts in the length.
    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(std::iter::once(0)).collect()
    }

    let path = wide(&format!(r"Software\Classes\AppUserModelId\{app_id}"));
    let mut key: HKEY = std::ptr::null_mut();
    let opened = unsafe {
        RegCreateKeyExW(
            HKEY_CURRENT_USER,
            path.as_ptr(),
            0,
            std::ptr::null_mut(),
            REG_OPTION_NON_VOLATILE,
            KEY_WRITE,
            std::ptr::null(),
            &mut key,
            std::ptr::null_mut(),
        )
    };
    if opened != ERROR_SUCCESS {
        return Err(opened);
    }

    let set = |value: &str, content: &str| {
        let value = wide(value);
        let content = wide(content);
        unsafe { RegSetValueExW(key, value.as_ptr(), 0, REG_SZ, content.as_ptr() as *const u8, (content.len() * 2) as u32) }
    };
    let named = set("DisplayName", name);
    let pictured = set("IconUri", icon);
    unsafe { RegCloseKey(key) };

    match (named, pictured) {
        (ERROR_SUCCESS, ERROR_SUCCESS) => Ok(()),
        (ERROR_SUCCESS, failed) | (failed, _) => Err(failed),
    }
}
