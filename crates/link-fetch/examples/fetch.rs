//! `cargo run --example fetch -- <link>...`: what a preview would get from each
//! link, or why it gets nothing. For trying the rules against real sites.

fn main() {
    for link in std::env::args().skip(1) {
        match link_fetch::fetch_blocking(&link, link_fetch::Kind::Page) {
            Ok(f) => {
                let text = String::from_utf8_lossy(&f.body);
                let title = text.split("<title").nth(1).and_then(|t| t.split('>').nth(1)).and_then(|t| t.split('<').next()).unwrap_or("").trim();
                println!("{link}\n  {} {} {} bytes{} -> {}\n  title: {title}", f.status, f.content_type, f.body.len(), if f.cut { " (cut)" } else { "" }, f.url);
            }
            Err(refusal) => println!("{link}\n  refused: {refusal}"),
        }
    }
}
