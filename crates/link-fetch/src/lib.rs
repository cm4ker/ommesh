//! The fetch behind a link preview. A link in a message is fetched by the
//! reader's own app, so the fetch is built to give a stranger who writes the
//! link as little as possible:
//!
//! - it reaches only the open internet (see `vet`), checked on the link, on
//!   every redirect, and on each address a name resolves to; the connection is
//!   made to the addresses that were checked, so a name that answers with a
//!   public address once and a private one the next time gains nothing;
//! - it carries no cookies, no referrer and no proxy, and names no app;
//! - it reads the start of a page, enough for its title and picture, or a
//!   picture of at most 2 MiB, and nothing of any other kind of file;
//! - it gives up after 10 seconds and 3 redirects.
//!
//! What is read is handed back as bytes: the page is parsed by the client,
//! never run, and the picture is decoded by the web view.

pub mod vet;

use std::error::Error as StdError;
use std::fmt;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use reqwest::dns::{Addrs, Name, Resolve, Resolving};
use reqwest::redirect::Policy;
use reqwest::Url;

/// The start of a page: its head, where the title and the picture are named,
/// is almost always within it. Most heads end in the first tens of kilobytes
/// and the read stops there; YouTube's runs to about 720 KiB of scripts.
pub const PAGE_LIMIT: usize = 1024 * 1024;
/// A picture larger than this is not shown in a message.
pub const PICTURE_LIMIT: usize = 2 * 1024 * 1024;
const REDIRECTS: usize = 3;
const TIMEOUT: Duration = Duration::from_secs(10);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
/// A browser's shape without a browser's or this app's name, so that a site
/// sees neither a crawler to turn away nor which app its reader uses.
const AGENT: &str = "Mozilla/5.0 (compatible; LinkPreview/1.0)";

/// What is wanted at the address: a page or a picture, or only a picture, as for the picture a page names.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Page,
    Picture,
}

/// What the address answered, after its redirects.
#[derive(Clone, Debug, Default)]
pub struct Fetched {
    /// The address that answered, which a redirect may have changed.
    pub url: String,
    pub status: u16,
    /// The `Content-Type` header as sent, or empty.
    pub content_type: String,
    /// The `Content-Length` header, when there is one.
    pub length: Option<u64>,
    /// The `Content-Disposition` header as sent, which may name a file.
    pub disposition: Option<String>,
    /// The start of a page, or a whole picture; empty for anything else.
    pub body: Vec<u8>,
    /// The page went on past what was read, or the picture was too large to read.
    pub cut: bool,
}

/// Why nothing was fetched.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Refusal {
    /// The link, a redirect or a name's address leads somewhere a preview may not go.
    Address,
    Redirects,
    /// The site answered, but not with the page: 404, 403 and the like.
    Status(u16),
    Timeout,
    Network(String),
}

impl fmt::Display for Refusal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Refusal::Address => f.write_str("address"),
            Refusal::Redirects => f.write_str("redirects"),
            Refusal::Status(code) => write!(f, "status {code}"),
            Refusal::Timeout => f.write_str("timeout"),
            Refusal::Network(reason) => write!(f, "network: {reason}"),
        }
    }
}

/// The marks this crate leaves in reqwest's errors, found again by walking an error's sources.
#[derive(Debug)]
struct Blocked;
#[derive(Debug)]
struct TooManyRedirects;

impl fmt::Display for Blocked {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("not an address on the open internet")
    }
}
impl StdError for Blocked {}
impl fmt::Display for TooManyRedirects {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("too many redirects")
    }
}
impl StdError for TooManyRedirects {}

/// Resolves a name and hands on its addresses only when every one of them is
/// public; reqwest then connects to these and to nothing else.
struct PublicOnly;

impl Resolve for PublicOnly {
    fn resolve(&self, name: Name) -> Resolving {
        let host = name.as_str().to_owned();
        Box::pin(async move {
            if !vet::name_allowed(&host) {
                return Err(Box::new(Blocked) as Box<dyn StdError + Send + Sync>);
            }
            let addrs: Vec<SocketAddr> = tokio::net::lookup_host((host.as_str(), 0)).await?.collect();
            // One private address among public ones is enough to refuse: which
            // of them the connection would use is not up to the reader.
            if addrs.is_empty() || addrs.iter().any(|a| !vet::is_public(a.ip())) {
                return Err(Box::new(Blocked) as Box<dyn StdError + Send + Sync>);
            }
            Ok(Box::new(addrs.into_iter()) as Addrs)
        })
    }
}

fn client() -> Result<reqwest::Client, Refusal> {
    let redirects = Policy::custom(|attempt| {
        if attempt.previous().len() >= REDIRECTS {
            attempt.error(TooManyRedirects)
        } else if !vet::url_allowed(attempt.url()) {
            attempt.error(Blocked)
        } else {
            attempt.follow()
        }
    });
    reqwest::Client::builder()
        .dns_resolver(Arc::new(PublicOnly))
        .redirect(redirects)
        .no_proxy()
        .referer(false)
        .user_agent(AGENT)
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(TIMEOUT)
        .build()
        .map_err(|e| Refusal::Network(e.to_string()))
}

fn refusal(error: reqwest::Error) -> Refusal {
    if error.is_timeout() {
        return Refusal::Timeout;
    }
    let mut source: Option<&(dyn StdError + 'static)> = Some(&error);
    while let Some(e) = source {
        if e.is::<Blocked>() {
            return Refusal::Address;
        }
        if e.is::<TooManyRedirects>() {
            return Refusal::Redirects;
        }
        source = e.source();
    }
    Refusal::Network(error.to_string())
}

fn mime(content_type: &str) -> String {
    content_type.split(';').next().unwrap_or("").trim().to_ascii_lowercase()
}

/// Whether a page's head has ended in `bytes`, so nothing further is needed.
fn head_ended(bytes: &[u8]) -> bool {
    bytes.windows(7).any(|w| w.eq_ignore_ascii_case(b"</head>")) || bytes.windows(6).any(|w| w.eq_ignore_ascii_case(b"<body>") || w.eq_ignore_ascii_case(b"<body "))
}

/// Fetches what `link` leads to, within the limits above. A page is read up to
/// the end of its head; a picture only whole and only when small enough.
pub async fn fetch(link: &str, kind: Kind) -> Result<Fetched, Refusal> {
    let url = Url::parse(link).map_err(|_| Refusal::Address)?;
    if !vet::url_allowed(&url) {
        return Err(Refusal::Address);
    }
    let accept = match kind {
        Kind::Page => "text/html,application/xhtml+xml;q=0.9,image/*;q=0.8,*/*;q=0.5",
        Kind::Picture => "image/webp,image/png,image/jpeg,image/gif;q=0.9",
    };
    let mut response = client()?.get(url).header(reqwest::header::ACCEPT, accept).send().await.map_err(refusal)?;
    let status = response.status();
    if !status.is_success() {
        return Err(Refusal::Status(status.as_u16()));
    }
    let header = |name: reqwest::header::HeaderName| response.headers().get(name).and_then(|v| v.to_str().ok()).map(str::to_owned);
    let content_type = header(reqwest::header::CONTENT_TYPE).unwrap_or_default();
    let disposition = header(reqwest::header::CONTENT_DISPOSITION);
    let mut fetched = Fetched { url: response.url().to_string(), status: status.as_u16(), length: response.content_length(), disposition, ..Default::default() };

    let kind_of = mime(&content_type);
    let page = kind == Kind::Page && matches!(kind_of.as_str(), "text/html" | "application/xhtml+xml");
    let picture = matches!(kind_of.as_str(), "image/jpeg" | "image/png" | "image/webp" | "image/gif");
    fetched.content_type = content_type;
    let limit = if page {
        PAGE_LIMIT
    } else if picture {
        PICTURE_LIMIT
    } else {
        // Any other file: what it is and how large is all a preview says, so none of it is read.
        return Ok(fetched);
    };
    if picture && fetched.length.is_some_and(|n| n > PICTURE_LIMIT as u64) {
        fetched.cut = true;
        return Ok(fetched);
    }

    while let Some(chunk) = response.chunk().await.map_err(refusal)? {
        let room = limit - fetched.body.len();
        if chunk.len() > room {
            fetched.body.extend_from_slice(&chunk[..room]);
            fetched.cut = true;
            break;
        }
        // The new chunk with the last few bytes before it, so a tag split between chunks is still seen.
        let from = fetched.body.len().saturating_sub(6);
        fetched.body.extend_from_slice(&chunk);
        if page && head_ended(&fetched.body[from..]) {
            fetched.cut = true;
            break;
        }
    }
    // Part of a picture shows nothing.
    if picture && fetched.cut {
        fetched.body.clear();
    }
    Ok(fetched)
}

/// `fetch` for a caller with no async runtime of its own, as the phones' native
/// code is: it runs on the calling thread, which should not be the main one.
pub fn fetch_blocking(link: &str, kind: Kind) -> Result<Fetched, Refusal> {
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().map_err(|e| Refusal::Network(e.to_string()))?;
    runtime.block_on(fetch(link, kind))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[test]
    fn a_head_ends_at_its_tag_or_the_body() {
        assert!(head_ended(b"<title>x</title></HEAD>"));
        assert!(head_ended(b"...<body class=\"a\">"));
        assert!(head_ended(b"<BODY>"));
        assert!(!head_ended(b"<meta property=\"og:title\" content=\"x\">"));
    }

    #[test]
    fn mime_drops_parameters() {
        assert_eq!(mime("text/html; charset=windows-1251"), "text/html");
        assert_eq!(mime("IMAGE/PNG"), "image/png");
    }

    #[tokio::test]
    async fn a_private_address_is_never_connected_to() {
        // A server on this machine that would answer: the fetch must not reach it.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let mut buf = [0u8; 1024];
                let _ = socket.read(&mut buf).await;
                let _ = socket.write_all(b"HTTP/1.1 200 OK\r\ncontent-type: text/html\r\ncontent-length: 5\r\n\r\nhello").await;
            }
        });
        assert_eq!(fetch(&format!("http://127.0.0.1:{port}/"), Kind::Page).await.unwrap_err(), Refusal::Address);
        assert_eq!(fetch("http://127.0.0.1/", Kind::Page).await.unwrap_err(), Refusal::Address);
        assert_eq!(fetch("http://localhost/", Kind::Page).await.unwrap_err(), Refusal::Address);
        assert_eq!(fetch("not a link", Kind::Page).await.unwrap_err(), Refusal::Address);
    }

    #[tokio::test]
    async fn a_name_is_refused_before_it_is_looked_up() {
        let resolving = PublicOnly.resolve("printer.local".parse().unwrap());
        assert!(resolving.await.is_err());
    }
}
