//! Reading and sending community coverage maps (lib/coverage/maps.ts). Some
//! endpoints answer only their own site's origin, so the webview's `fetch` is
//! refused (CORS) and the shell talks to them over HTTPS instead. Only the
//! hosts listed here are ever reached: the page cannot turn these commands into
//! a general HTTP proxy.
use serde::Serialize;
use std::time::Duration;

/// The hosts of the maps in lib/coverage/maps.ts that take uploads through the shell.
const UPLOAD_MAPS: &[&str] = &["meshcoretel.ru"];
/// The hosts in lib/coverage/maps.ts that the shell reads coverage cells from.
const READ_MAPS: &[&str] = &["nw.ommesh.ru"];

#[derive(Serialize)]
pub struct Answer {
    status: u16,
    body: String,
}

#[tauri::command]
pub async fn coverage_upload(url: String, body: String) -> Result<Answer, String> {
    let url = reqwest::Url::parse(&url).map_err(|e| e.to_string())?;
    if url.scheme() != "https" || !url.host_str().is_some_and(|host| UPLOAD_MAPS.contains(&host)) {
        return Err(format!("not a coverage map: {url}"));
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| crate::updates::with_causes(&e))?;
    let answer = client
        .post(url)
        .header("Content-Type", "application/json")
        .body(body)
        .send()
        .await
        .map_err(|e| crate::updates::with_causes(&e))?;
    let status = answer.status().as_u16();
    let body = answer.text().await.map_err(|e| crate::updates::with_causes(&e))?;
    Ok(Answer { status, body })
}

#[tauri::command]
pub async fn coverage_fetch(url: String) -> Result<Answer, String> {
    let url = reqwest::Url::parse(&url).map_err(|e| e.to_string())?;
    if url.scheme() != "https" || !url.host_str().is_some_and(|host| READ_MAPS.contains(&host)) {
        return Err(format!("not a coverage map: {url}"));
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| crate::updates::with_causes(&e))?;
    let answer = client
        .get(url)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| crate::updates::with_causes(&e))?;
    let status = answer.status().as_u16();
    let body = answer.text().await.map_err(|e| crate::updates::with_causes(&e))?;
    Ok(Answer { status, body })
}
