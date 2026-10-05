//! Several copies of the app at once, each with a radio of its own (#12).
//!
//! Started the usual way, from the Start menu or at login, the app is one
//! copy: a second start brings its window back (`lib.rs`). Another copy is
//! opened from the app itself, with `--another`, and lives beside the first
//! with a window, a tray icon and a link of its own.
//!
//! Copies are numbered from 1, each holding a lock on a file of its number
//! for as long as it runs; a new copy takes the lowest number nobody holds.
//! The number is what keeps copies apart where they share a place: the page
//! keeps its link and its screens under it (`instance.ts`), and the window
//! state plugin its own file. So the second copy opened again finds the radio
//! it had last time, and the first copy never notices there was a second.

use std::fs::{File, OpenOptions};
use std::path::PathBuf;
use std::process::{Command, Stdio};

/// What a copy opened from the app is started with: no bringing back of the one already running.
pub const ANOTHER: &str = "--another";

/// Copies beyond this many all share the last number. Nobody has that many radios on one desk.
const MOST: u32 = 32;

/// This copy's number, taken as the process starts and held until it ends.
pub fn take(identifier: &str) -> u32 {
    let dir = std::env::var_os("XDG_RUNTIME_DIR").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
    for number in 1..MOST {
        let path = dir.join(format!("{identifier}.{number}.lock"));
        let Ok(file) = OpenOptions::new().create(true).truncate(false).write(true).open(&path) else {
            // Nowhere to write locks: every copy is the first, as before there were copies.
            return 1;
        };
        if file.try_lock().is_ok() {
            hold(file);
            return number;
        }
    }
    MOST
}

/// The system lets go of the lock when the process ends, however it ends; until then nothing closes the file.
fn hold(file: File) {
    std::mem::forget(file);
}

/// The window state plugin's file for this copy: the first keeps the name it always had.
pub fn window_state_file(number: u32) -> String {
    if number == 1 {
        tauri_plugin_window_state::DEFAULT_FILENAME.to_string()
    } else {
        format!(".window-state.{number}.json")
    }
}

/// Tells every page of this copy its number before any of the page's own code runs.
pub fn plugin<R: tauri::Runtime>(number: u32) -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("instance").js_init_script(format!("window.__OMMESH_COPY__ = {number};")).build()
}

/// Starts one more copy, for another radio.
pub fn open_another() -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|error| error.to_string())?;
    Command::new(exe)
        .arg(ANOTHER)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn desktop_open_another() -> Result<(), String> {
    open_another()
}
