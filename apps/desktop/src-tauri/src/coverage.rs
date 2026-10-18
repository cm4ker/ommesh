//! A coverage survey sent to a community coverage map, after the reader has
//! agreed to it in the app. These maps answer only their own site's origin, so
//! the webview's `fetch` is refused (CORS) and the shell posts instead; a map
//! that answers any site (Ommesh's own) takes the page's post and is not here.
//! Only the maps the app lists (lib/coverage/maps.ts) are posted to, over
//! HTTPS: the page cannot turn this into a way to send anything anywhere.
use serde::Serialize;
use std::time::Duration;

/// The hosts of the maps in lib/coverage/maps.ts that answer only their own site.
const MAPS: &[&str] = &["meshcoretel.ru"];

#[derive(Serialize)]
pub struct Answer {
    status: u16,
    body: String,
}

#[tauri::command]
pub async fn coverage_upload(url: String, body: String) -> Result<Answer, String> {
    let url = reqwest::Url::parse(&url).map_err(|e| e.to_string())?;
    if url.scheme() != "https" || !url.host_str().is_some_and(|host| MAPS.contains(&host)) {
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
