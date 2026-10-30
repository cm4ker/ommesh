//! Text formatting as the page reads it (`apps/web/src/lib/textFormat.ts`): `**bold**`,
//! `__italic__`, `~~struck~~`, `` `mono` ``, `||hidden||`, a ``` block of lines and a
//! `$$formula$$`. A notice says the text without its markers and covers what is hidden, as the
//! page's own notice does, so a password put under `||` does not show on a locked phone. A formula
//! reads as its TeX. Change both together.
//!
//! Only doubled markers count. A pair needs text right inside it, no space on either inner edge,
//! and its partner; a block and a formula may start and end with spaces. Mentions, places and web
//! addresses come first: a marker inside one is part of it. Nothing is formatted inside mono text
//! or a formula, and `$$$` is no marker.

/// What a hidden stretch reads as where it cannot be opened.
const HIDDEN: &str = "▒▒▒";

#[derive(Clone, Copy, PartialEq)]
enum Kind {
    Block,
    Code,
    Bold,
    Italic,
    Strike,
    Spoiler,
    Math,
}

/// The markers, a block's ``` before mono's `.
const MARKS: [(&str, Kind); 7] = [
    ("```", Kind::Block),
    ("`", Kind::Code),
    ("**", Kind::Bold),
    ("__", Kind::Italic),
    ("~~", Kind::Strike),
    ("||", Kind::Spoiler),
    ("$$", Kind::Math),
];

/// Where a pair of markers stands: the opening one at `start`, the text between `inner` and `close`.
struct Span {
    start: usize,
    inner: usize,
    close: usize,
    end: usize,
    kind: Kind,
}

/// The text without its markers, a hidden stretch as ▒▒▒.
pub fn plain_text(text: &str) -> String {
    if !["**", "__", "~~", "||", "`", "$$"]
        .iter()
        .any(|m| text.contains(m))
    {
        return text.to_string();
    }
    let chars: Vec<char> = text.chars().collect();
    let guarded = protected_ranges(&chars);
    plain_range(&chars, 0, chars.len(), &guarded)
}

fn plain_range(t: &[char], from: usize, to: usize, guarded: &[(usize, usize)]) -> String {
    let mut out = String::new();
    let mut at = from;
    while at < to {
        let Some(span) = first_span(t, at, to, guarded) else {
            out.extend(&t[at..to]);
            break;
        };
        out.extend(&t[at..span.start]);
        match span.kind {
            Kind::Spoiler => out.push_str(HIDDEN),
            Kind::Code => out.extend(&t[span.inner..span.close]),
            Kind::Math => {
                let inner: String = t[span.inner..span.close].iter().collect();
                out.push_str(inner.trim());
            }
            Kind::Block => {
                let inner: String = t[span.inner..span.close].iter().collect();
                let inner = inner.strip_prefix('\n').unwrap_or(&inner);
                out.push_str(inner.strip_suffix('\n').unwrap_or(inner));
            }
            _ => out.push_str(&plain_range(t, span.inner, span.close, guarded)),
        }
        at = span.end;
    }
    out
}

fn find(t: &[char], mark: &[char], from: usize) -> Option<usize> {
    let last = t.len().checked_sub(mark.len())?;
    (from..=last).find(|&i| t[i..i + mark.len()] == *mark)
}

fn is_space(ch: Option<&char>) -> bool {
    ch.is_none_or(|c| c.is_whitespace())
}

/// The pair that opens first in `t` between `from` and `to`.
fn first_span(t: &[char], from: usize, to: usize, guarded: &[(usize, usize)]) -> Option<Span> {
    let clear = |at: usize, n: usize| !guarded.iter().any(|&(a, b)| a < at + n && at < b);
    // Mono's single backtick is not one of a block's three, and a formula's $$ is not part of $$$.
    let in_run = |kind: Kind, i: usize, n: usize| {
        let around =
            |ch: char| i.checked_sub(1).map(|k| t[k]) == Some(ch) || t.get(i + n) == Some(&ch);
        (kind == Kind::Code && around('`')) || (kind == Kind::Math && around('$'))
    };
    let loose = |kind: Kind| kind == Kind::Block || kind == Kind::Math;
    let mut best: Option<Span> = None;
    for (mark, kind) in MARKS {
        let mark: Vec<char> = mark.chars().collect();
        let n = mark.len();
        let mut next = find(t, &mark, from);
        while let Some(i) = next {
            if i + n > to || best.as_ref().is_some_and(|b| i >= b.start) {
                break;
            }
            next = find(t, &mark, i + 1);
            if in_run(kind, i, n) || !clear(i, n) {
                continue;
            }
            let inner = i + n;
            if !loose(kind) && is_space(t.get(inner)) {
                continue;
            }
            let mut close = None;
            let mut after = find(t, &mark, inner + 1);
            while let Some(j) = after {
                if j + n > to {
                    break;
                }
                after = find(t, &mark, j + 1);
                if in_run(kind, j, n) || !clear(j, n) {
                    continue;
                }
                if !loose(kind) && is_space(t.get(j - 1)) {
                    continue;
                }
                close = Some(j);
                break;
            }
            let Some(close) = close else { continue };
            // Mono text stays on its line; a block holds more than its line breaks.
            if kind == Kind::Code && t[inner..close].contains(&'\n') {
                continue;
            }
            if loose(kind) && t[inner..close].iter().all(|c| c.is_whitespace()) {
                continue;
            }
            best = Some(Span {
                start: i,
                inner,
                close,
                end: close + n,
                kind,
            });
            break;
        }
    }
    best
}

/// The stretches no marker may fall into: mentions (`@[name]`), places (`geo:`, `m:`, `[WAY]`,
/// `[LOC]`) and web addresses, found from the left as the page's one pattern finds them.
fn protected_ranges(t: &[char]) -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < t.len() {
        if let Some(end) = mention(t, i).or_else(|| place(t, i)) {
            out.push((i, end));
            i = end;
        } else if let Some(end) = link(t, i) {
            out.push((i, i + bare_link(&t[i..end])));
            i = end;
        } else {
            i += 1;
        }
    }
    out
}

/// Whether `t` holds `word` at `at`, in any case.
fn word_at(t: &[char], at: usize, word: &str) -> bool {
    let mut k = at;
    for w in word.chars() {
        match t.get(k) {
            Some(c) if c.eq_ignore_ascii_case(&w) => k += 1,
            _ => return false,
        }
    }
    true
}

fn mention(t: &[char], at: usize) -> Option<usize> {
    if !word_at(t, at, "@[") {
        return None;
    }
    let name = at + 2;
    let stop = (name..t.len()).find(|&k| t[k] == ']' || t[k] == '\n')?;
    (t[stop] == ']' && (1..=32).contains(&(stop - name))).then_some(stop + 1)
}

/// A coordinate: `-?\d{1,3}(\.\d+)?`, its end.
fn number(t: &[char], at: usize) -> Option<usize> {
    let mut k = at + usize::from(t.get(at) == Some(&'-'));
    let digits = t[k.min(t.len())..]
        .iter()
        .take(3)
        .take_while(|c| c.is_ascii_digit())
        .count();
    if digits == 0 {
        return None;
    }
    k += digits;
    if t.get(k) == Some(&'.') && t.get(k + 1).is_some_and(char::is_ascii_digit) {
        k += 1;
        while t.get(k).is_some_and(char::is_ascii_digit) {
            k += 1;
        }
    }
    Some(k)
}

/// Two coordinates with a comma between, their end.
fn pair(t: &[char], at: usize) -> Option<usize> {
    let k = number(t, at)?;
    (t.get(k) == Some(&',')).then_some(())?;
    number(t, k + 1)
}

/// A number cut short ("73…", "73.3...") ends no place.
fn whole(t: &[char], at: usize) -> bool {
    let next = t.get(at);
    !(next.is_some_and(char::is_ascii_digit)
        || next == Some(&'…')
        || (next == Some(&'.')
            && t.get(at + 1)
                .is_some_and(|c| c.is_ascii_digit() || *c == '.')))
}

fn place(t: &[char], at: usize) -> Option<usize> {
    if word_at(t, at, "geo:") {
        let mut k = pair(t, at + 4)?;
        if !whole(t, k) {
            return None;
        }
        // Its parameters, `;name=value`.
        while t.get(k) == Some(&';') {
            let key = t[k + 1..]
                .iter()
                .take_while(|c| c.is_ascii_alphabetic() || **c == '-')
                .count();
            if key == 0 || t.get(k + 1 + key) != Some(&'=') {
                break;
            }
            k += 2 + key;
            while t.get(k).is_some_and(|c| *c != ';' && !c.is_whitespace()) {
                k += 1;
            }
        }
        return Some(k);
    }
    let word = |c: &char| c.is_ascii_alphanumeric() || *c == '_';
    if word_at(t, at, "m:") && !at.checked_sub(1).is_some_and(|k| word(&t[k])) {
        let k = pair(t, at + 2)?;
        (t.get(k) == Some(&'|')).then_some(())?;
        let stop = (k + 1..t.len()).find(|&j| t[j] == '|' || t[j] == '\n')?;
        (t[stop] == '|').then_some(())?;
        let kind = t[stop + 1..]
            .iter()
            .take_while(|c| c.is_ascii_alphabetic())
            .count();
        return (kind > 0).then_some(stop + 1 + kind);
    }
    if word_at(t, at, "[WAY]") || word_at(t, at, "[LOC]") {
        let k = pair(t, at + 5)?;
        return whole(t, k).then_some(k);
    }
    None
}

/// A web address with its scheme or `www.`, to the first space or quote: its end.
fn link(t: &[char], at: usize) -> Option<usize> {
    let start = ["https://", "http://", "www."]
        .iter()
        .find(|w| word_at(t, at, w))?
        .chars()
        .count();
    let rest = t[at + start..]
        .iter()
        .take_while(|c| !c.is_whitespace() && !"<>\"«»".contains(**c))
        .count();
    (rest > 0).then_some(at + start + rest)
}

/// How much of an address match is the address: without the sentence's punctuation and the
/// markers after it, in any order, as the page's `bareLink` takes them off.
fn bare_link(matched: &[char]) -> usize {
    let mut text = matched.len();
    loop {
        let mut next = link_text(&matched[..text]).unwrap_or(text);
        while let Some(mark) = ["**", "__", "~~", "||", "`"]
            .iter()
            .find(|m| ends_with(&matched[..next], m))
        {
            next -= mark.len();
        }
        if next == text {
            return text;
        }
        text = next;
    }
}

fn ends_with(t: &[char], mark: &str) -> bool {
    let n = mark.len();
    t.len() >= n && t[t.len() - n..].iter().copied().eq(mark.chars())
}

/// The page's `linkOf`: an address without the punctuation around it, or nothing when only the
/// scheme is left.
fn link_text(t: &[char]) -> Option<usize> {
    let mut len = t.len();
    while let Some(&last) = t[..len].last() {
        let open = match last {
            ')' => Some('('),
            ']' => Some('['),
            '}' => Some('{'),
            _ => None,
        };
        let count = |ch: char| t[..len].iter().filter(|&&c| c == ch).count();
        if ".,;:!?'…".contains(last) || open.is_some_and(|o| count(o) < count(last)) {
            len -= 1;
        } else {
            break;
        }
    }
    let shown: String = t[..len].iter().collect();
    let scheme = (shown.starts_with('H') || shown.starts_with('h'))
        && (shown[1..].starts_with("ttp://") || shown[1..].starts_with("ttps://"));
    let least = if scheme {
        shown.find("//").unwrap_or(0) + 2
    } else {
        4
    };
    (len > least).then_some(len)
}

#[cfg(test)]
mod tests {
    use super::plain_text;

    #[test]
    fn markers_go_and_hidden_text_is_covered() {
        assert_eq!(
            plain_text("Кто слышит репитер на **Лысой горе**?"),
            "Кто слышит репитер на Лысой горе?"
        );
        assert_eq!(plain_text("Пароль: ||сосна42||"), "Пароль: ▒▒▒");
        assert_eq!(plain_text("Так:\n```\nset tx 22\n```"), "Так:\nset tx 22");
        assert_eq!(
            plain_text("**жирный __и курсив__**, ~~Еду~~"),
            "жирный и курсив, Еду"
        );
        assert_eq!(plain_text("`**как есть**`"), "**как есть**");
    }

    #[test]
    fn a_formula_reads_as_its_tex_and_prices_stay() {
        assert_eq!(
            plain_text("Энергия $$ E=mc^2 $$, ясно"),
            "Энергия E=mc^2, ясно"
        );
        assert_eq!(plain_text(r"$$\frac{a}{**b**}$$"), r"\frac{a}{**b**}");
        assert_eq!(plain_text("**$$x$$**"), "x");
        for text in ["$5 и $10", "Кафе $$$, бар $$", "$$ $$", "$$$x$$$"] {
            assert_eq!(plain_text(text), text);
        }
    }

    #[test]
    fn single_markers_spaces_inside_and_lone_markers_stay() {
        for text in [
            "2*3*4",
            "*привет* всем _так_",
            "node_v2_final.txt ^_^",
            "** жирный **",
            "**без пары",
            "****",
            "`a\nb`",
            "```\n\n```",
        ] {
            assert_eq!(plain_text(text), text);
        }
    }

    #[test]
    fn addresses_places_and_mentions_keep_their_markers() {
        assert_eq!(
            plain_text("https://site.ru/a__b__c"),
            "https://site.ru/a__b__c"
        );
        assert_eq!(plain_text("@[Node__1__] привет"), "@[Node__1__] привет");
        assert_eq!(
            plain_text("m:55.75,37.61||WAY и ||тайна||"),
            "m:55.75,37.61||WAY и ▒▒▒"
        );
        assert_eq!(
            plain_text("и **https://meshcore.io**, пароль"),
            "и https://meshcore.io, пароль"
        );
        assert_eq!(
            plain_text("(**https://meshcore.io**)."),
            "(https://meshcore.io)."
        );
        assert_eq!(plain_text("`https://meshcore.io`"), "https://meshcore.io");
    }
}
