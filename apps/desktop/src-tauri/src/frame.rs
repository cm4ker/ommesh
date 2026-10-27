//! The window's frame. The page draws the title bar itself, in the theme's
//! colours, with its own buttons on Windows and Linux; macOS keeps its
//! traffic lights over the page (`tauri.macos.conf.json`).
//!
//! On Windows 11 the system still draws the window's thin edge, rounded at
//! the corners, and lets an app colour it: the edge takes the theme's accent
//! while the window is in front, and a quiet colour of the theme while it is
//! not, both told by the page (`frame_colors`). Windows 10 keeps its own edge.

use std::sync::Mutex;

use tauri::{Runtime, Window, WindowEvent};

/// The edge's colours as the page last said them: in front, and behind.
static COLORS: Mutex<Option<([u8; 3], [u8; 3])>> = Mutex::new(None);

const ID: &str = "main";

/// `#rrggbb` to its three bytes.
fn rgb(hex: &str) -> Option<[u8; 3]> {
    let hex = hex.trim().strip_prefix('#')?;
    if hex.len() != 6 {
        return None;
    }
    let byte = |at: usize| u8::from_str_radix(&hex[at..at + 2], 16).ok();
    Some([byte(0)?, byte(2)?, byte(4)?])
}

/// The theme's colours for the edge, from the page, as it starts and on every change of theme.
#[tauri::command]
pub fn frame_colors<R: Runtime>(window: Window<R>, active: String, inactive: String) -> Result<(), String> {
    let (Some(active), Some(inactive)) = (rgb(&active), rgb(&inactive)) else {
        return Err("a colour is not #rrggbb".into());
    };
    *COLORS.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some((active, inactive));
    paint(&window, window.is_focused().unwrap_or(true));
    Ok(())
}

/// The edge follows the window in and out of focus.
pub fn on_window_event<R: Runtime>(window: &Window<R>, event: &WindowEvent) {
    if let WindowEvent::Focused(focused) = event {
        if window.label() == ID {
            paint(window, *focused);
        }
    }
}

#[cfg(windows)]
fn paint<R: Runtime>(window: &Window<R>, focused: bool) {
    use windows_sys::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMWA_BORDER_COLOR};
    let Some((active, inactive)) = *COLORS.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) else {
        return;
    };
    let Ok(hwnd) = window.hwnd() else {
        return;
    };
    let [r, g, b] = if focused { active } else { inactive };
    // COLORREF is 0x00bbggrr.
    let color: u32 = u32::from(r) | u32::from(g) << 8 | u32::from(b) << 16;
    // Windows 10 knows no such attribute and says so; its edge stays as it was.
    unsafe {
        DwmSetWindowAttribute(hwnd.0 as _, DWMWA_BORDER_COLOR as _, &color as *const u32 as _, size_of::<u32>() as u32);
    }
}

/// macOS and Linux have no edge of the system's to colour; the page draws its own on Linux.
#[cfg(not(windows))]
fn paint<R: Runtime>(_window: &Window<R>, _focused: bool) {}

#[cfg(test)]
mod tests {
    use super::rgb;

    #[test]
    fn reads_hex_colours() {
        assert_eq!(rgb("#74ade8"), Some([0x74, 0xad, 0xe8]));
        assert_eq!(rgb("#fff"), None);
        assert_eq!(rgb("rgb(1 2 3)"), None);
    }
}
