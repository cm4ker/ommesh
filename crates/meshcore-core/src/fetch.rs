//! A link preview's fetch, for the phone's native code: the web view cannot
//! read another site, and the rules of what may be reached live once, in the
//! `link-fetch` crate the desktop calls as well. This only hands its answer
//! over in a shape the bindings carry.

/// What a link's address answered, or why nothing was fetched.
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct LinkFetched {
    /// The address that answered, after its redirects.
    pub url: String,
    pub status: u16,
    pub content_type: String,
    pub length: Option<u64>,
    pub disposition: Option<String>,
    /// The start of a page or a whole picture, else empty.
    pub body: Vec<u8>,
    pub cut: bool,
    /// Why nothing was fetched: `address`, `redirects`, `status 404`, `timeout` or `network: …`. None when something was.
    pub refused: Option<String>,
}

/// Fetches what `link` leads to: a page or a picture, or only a picture. It
/// blocks for up to ten seconds, so it is called off the main thread.
#[uniffi::export]
pub fn link_fetch(link: String, picture_only: bool) -> LinkFetched {
    let kind = if picture_only { link_fetch::Kind::Picture } else { link_fetch::Kind::Page };
    match link_fetch::fetch_blocking(&link, kind) {
        Ok(f) => LinkFetched { url: f.url, status: f.status, content_type: f.content_type, length: f.length, disposition: f.disposition, body: f.body, cut: f.cut, refused: None },
        Err(refusal) => LinkFetched { url: link, status: 0, content_type: String::new(), length: None, disposition: None, body: Vec::new(), cut: false, refused: Some(refusal.to_string()) },
    }
}
