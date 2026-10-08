//! A link preview's fetch for the page (lib/linkFetch.ts). The webview cannot
//! read another site, and the rules of what a preview may reach live in the
//! `link-fetch` crate the iPhone uses as well: the open internet only, checked
//! after every name lookup and redirect, no cookies, small reads.
use base64::Engine;
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Fetched {
    url: String,
    status: u16,
    content_type: String,
    length: Option<u64>,
    disposition: Option<String>,
    /// In base64, as the page reads it.
    body: String,
    cut: bool,
}

/// What `url` leads to: a page or a picture, or with `picture` only a picture.
/// Fails with why nothing was fetched: `address`, `redirects`, `status 404`,
/// `timeout` or `network: …`.
#[tauri::command]
pub async fn link_fetch(url: String, picture: bool) -> Result<Fetched, String> {
    let kind = if picture { link_fetch::Kind::Picture } else { link_fetch::Kind::Page };
    let f = link_fetch::fetch(&url, kind).await.map_err(|refusal| refusal.to_string())?;
    Ok(Fetched {
        url: f.url,
        status: f.status,
        content_type: f.content_type,
        length: f.length,
        disposition: f.disposition,
        body: base64::engine::general_purpose::STANDARD.encode(&f.body),
        cut: f.cut,
    })
}
