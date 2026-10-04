//! Only the two project feeds may be selected. Downloading, signature verification
//! and installation remain the official updater plugin's responsibility.
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tauri::{Manager, Webview};
use tauri_plugin_updater::UpdaterExt;
use tauri_plugin_window_state::AppHandleExt;

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Channel {
    Stable,
    Dev,
}

#[tauri::command]
pub fn desktop_update_info(app: tauri::AppHandle) -> serde_json::Value {
    let version = &app.package_info().version;
    // No channel: every build starts on Stable until its user picks Dev (updates.ts).
    serde_json::json!({
        "version": version.to_string(),
        "supported": cfg!(windows),
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateMetadata {
    rid: tauri::ResourceId,
    current_version: String,
    version: String,
    body: Option<String>,
    raw_json: serde_json::Value,
}

#[tauri::command]
pub async fn desktop_check_update(
    webview: Webview,
    channel: Channel,
) -> Result<Option<UpdateMetadata>, String> {
    if !cfg!(windows) {
        return Err("In-app updates are currently available on Windows.".into());
    }
    let endpoint = match channel {
        Channel::Stable => "https://github.com/cm4ker/ommesh/releases/latest/download/latest.json",
        Channel::Dev => "https://github.com/cm4ker/ommesh/releases/download/dev/latest.json",
    };
    // The installer ends the process outright, with no quitting for the
    // window state plugin to hear, so the window is written down first. The
    // cleanup is what the plugin's own builder does here.
    let app = webview.app_handle().clone();
    let update = webview
        .updater_builder()
        .endpoints(vec![endpoint
            .parse()
            .map_err(|e| format!("Invalid update URL: {e}"))?])
        .map_err(|e| e.to_string())?
        .timeout(Duration::from_secs(15))
        .on_before_exit(move || {
            let _ = app.save_window_state(crate::WINDOW_STATE);
            app.cleanup_before_exit();
        })
        .build()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| with_causes(&e))?;
    Ok(update.map(|update| UpdateMetadata {
        current_version: update.current_version.clone(),
        version: update.version.clone(),
        body: update.body.clone(),
        raw_json: update.raw_json.clone(),
        rid: webview.resources_table().add(update),
    }))
}

/// reqwest's own message is only "error sending request for url (…)"; what
/// actually went wrong (a refused proxy, a bad certificate) is in the causes.
pub(crate) fn with_causes(error: &dyn std::error::Error) -> String {
    let mut text = error.to_string();
    let mut cause = error.source();
    while let Some(e) = cause {
        text.push_str(": ");
        text.push_str(&e.to_string());
        cause = e.source();
    }
    text
}
