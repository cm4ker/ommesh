//! Which addresses a preview may reach. A link in a message is anyone's to
//! write, so the fetch it starts must never land on the reader's own network:
//! `http://192.168.1.1/reboot` would otherwise be a request from inside the
//! house, made by a stranger. Only the open internet, on the ports of the web,
//! is allowed, and the check runs on the link, on every redirect, and on every
//! address a name resolves to.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

use reqwest::Url;

/// Names that never leave a home or an office network, whatever they resolve to.
const LOCAL_NAMES: [&str; 11] = ["localhost", "local", "lan", "home", "internal", "intranet", "corp", "private", "localdomain", "home.arpa", "test"];

/// Whether `url` may be fetched: the web's schemes and ports, no credentials,
/// and a host that is a public address or a name that may be one.
pub fn url_allowed(url: &Url) -> bool {
    if !matches!(url.scheme(), "http" | "https") {
        return false;
    }
    if !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    if !matches!(url.port_or_known_default(), Some(80 | 443)) {
        return false;
    }
    match url.host() {
        Some(url::Host::Ipv4(ip)) => v4_public(ip),
        Some(url::Host::Ipv6(ip)) => v6_public(ip),
        Some(url::Host::Domain(name)) => name_allowed(name),
        None => false,
    }
}

/// Whether a host name may be looked up: it has a dot, and it is not one of
/// the names a local network keeps for itself.
pub fn name_allowed(name: &str) -> bool {
    let name = name.trim_end_matches('.').to_ascii_lowercase();
    if name.is_empty() || !name.contains('.') {
        return false;
    }
    !LOCAL_NAMES.iter().any(|local| name == *local || name.ends_with(&format!(".{local}")))
}

/// Whether `ip` is an address on the open internet.
pub fn is_public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => v4_public(ip),
        IpAddr::V6(ip) => v6_public(ip),
    }
}

fn v4_public(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    !(a == 0
        || a == 10
        || a == 127
        // Carrier-grade NAT, the operator's own network.
        || (a == 100 && (64..128).contains(&b))
        || (a == 169 && b == 254)
        || (a == 172 && (16..32).contains(&b))
        || (a == 192 && b == 0 && (c == 0 || c == 2))
        || (a == 192 && b == 168)
        || (a == 198 && (b == 18 || b == 19))
        || (a == 198 && b == 51 && c == 100)
        || (a == 203 && b == 0 && c == 113)
        // Multicast, reserved, and the broadcast address.
        || a >= 224)
}

fn v6_public(ip: Ipv6Addr) -> bool {
    if let Some(v4) = ip.to_ipv4_mapped() {
        return v4_public(v4);
    }
    let s = ip.segments();
    let embedded = |hi: u16, lo: u16| Ipv4Addr::new((hi >> 8) as u8, hi as u8, (lo >> 8) as u8, lo as u8);
    // Unspecified, loopback and the old IPv4-compatible block all start with six zero groups.
    if s[..6] == [0; 6] {
        return false;
    }
    // NAT64 hands an IPv4 address on, so it is judged as that address.
    if s[0] == 0x64 && s[1] == 0xff9b && s[2..6] == [0; 4] {
        return v4_public(embedded(s[6], s[7]));
    }
    // 6to4 likewise carries an IPv4 address in its second and third groups.
    if s[0] == 0x2002 {
        return v4_public(embedded(s[1], s[2]));
    }
    !((s[0] == 0x64 && s[1] == 0xff9b && s[2] == 1)
        // Unique local, link-local, the old site-local, and multicast.
        || (s[0] & 0xfe00) == 0xfc00
        || (s[0] & 0xffc0) == 0xfe80
        || (s[0] & 0xffc0) == 0xfec0
        || (s[0] & 0xff00) == 0xff00
        // Teredo hides an IPv4 address that cannot be judged; documentation and discard are nowhere.
        || (s[0] == 0x2001 && s[1] == 0)
        || (s[0] == 0x2001 && s[1] == 0x0db8)
        || (s[0] == 0x0100 && s[1..4] == [0; 3]))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn allowed(url: &str) -> bool {
        url_allowed(&Url::parse(url).unwrap())
    }

    #[test]
    fn the_open_web_is_allowed() {
        assert!(allowed("https://habr.com/ru/articles/812345/"));
        assert!(allowed("http://forum-lora.ru/t/4412"));
        assert!(allowed("https://youtu.be/xk3B9mWq2Zs"));
        assert!(allowed("https://xn--80aswg.xn--p1ai/"));
        assert!(allowed("https://93.184.215.14/"));
        assert!(allowed("https://[2606:4700::6810:84e5]/"));
        assert!(allowed("https://habr.com:443/"));
    }

    #[test]
    fn a_home_network_is_not() {
        for url in [
            "http://192.168.1.1/reboot",
            "http://10.0.0.1/",
            "http://172.16.5.4/",
            "http://172.31.255.255/",
            "http://127.0.0.1/",
            "http://127.1/",
            "http://0x7f000001/",
            "http://2130706433/",
            "http://0.0.0.0/",
            "http://169.254.169.254/latest/meta-data/",
            "http://100.64.0.1/",
            "http://[::1]/",
            "http://[::]/",
            "http://[fe80::1]/",
            "http://[fd12:3456::1]/",
            "http://[::ffff:192.168.0.1]/",
            "http://[64:ff9b::a00:1]/",
            "http://[2002:c0a8:0101::1]/",
            "http://224.0.0.1/",
            "http://255.255.255.255/",
        ] {
            assert!(!allowed(url), "{url}");
        }
    }

    #[test]
    fn local_names_are_not() {
        for url in ["http://localhost/", "http://localhost:8080/", "http://router/", "http://printer.local/", "http://nas.lan/", "http://box.home.arpa/", "http://wiki.corp/", "http://a.localhost/"] {
            assert!(!allowed(url), "{url}");
        }
    }

    #[test]
    fn only_the_webs_schemes_and_ports() {
        for url in ["ftp://example.com/", "file:///etc/passwd", "https://example.com:8443/", "http://example.com:5000/", "http://example.com:22/", "https://user:pass@example.com/", "https://user@example.com/"] {
            assert!(!allowed(url), "{url}");
        }
    }

    #[test]
    fn addresses_judged_one_by_one() {
        assert!(is_public("8.8.8.8".parse().unwrap()));
        assert!(is_public("2a00:1450:4010::8a".parse().unwrap()));
        assert!(!is_public("192.168.0.10".parse().unwrap()));
        assert!(!is_public("172.20.1.1".parse().unwrap()));
        assert!(is_public("172.32.0.1".parse().unwrap()));
        assert!(is_public("100.128.0.1".parse().unwrap()));
        assert!(!is_public("198.18.0.1".parse().unwrap()));
        assert!(is_public("64:ff9b::808:808".parse().unwrap()));
        assert!(!is_public("2001:db8::1".parse().unwrap()));
        assert!(!is_public("2001::1".parse().unwrap()));
    }
}
