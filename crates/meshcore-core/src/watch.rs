//! Notices for what the radio hands over while the page sleeps.
//!
//! A phone puts the page's scripts to sleep soon after the app leaves the
//! screen, while the link stays up and the mux keeps reading the radio's queue
//! into the page's inbox. The page announces what it reads itself; the watch
//! announces what the page leaves unread, in the page's words
//! (`apps/web/src/lib/announce.ts`), so its notices read the same and carry the
//! same tags, and the page's own notice for a chat replaces the watch's.
//!
//! While the app is in the background, each message waits a moment
//! ([`GRACE_MS`]): a page that is awake takes it from its inbox by then, and the
//! watch stays quiet. What is still untaken is announced. A node heard for the
//! first time waits the same moment for the page to say it announced it
//! (`announced`). Back in front, the watch's notices are withdrawn: the page
//! reads its inbox and announces what is still unread.
//!
//! News that keeps coming, each within [`QUIET_MS`] of the last, is one burst:
//! a queue of a hundred messages read out after a time away is one, a chat
//! whose people write seconds apart is a burst per message. A burst rings once,
//! with its first notice; the notices after it only bring the count up to
//! date (gh #46).

use std::collections::HashMap;

use serde::Deserialize;

use crate::codes::*;
use crate::frames::{hex, read_message, read_new_advert, split_channel_text, Received};
use crate::{Effect, Timer};

/// How long a message waits for an awake page to take it, in ms.
pub const GRACE_MS: i64 = 5000;
/// How long news must stop for a burst of it to be over, in ms. The mux reads the radio's
/// queue at a message per 60–450 ms; people in a chat write seconds apart.
pub const QUIET_MS: i64 = 1500;
/// More chats than this with a notice each become one notice for all of them.
const SEPARATE: usize = 3;
/// The latest messages a chat's notice shows.
const LINES: usize = 3;
/// The chats the notice for all of them names.
const NAMED: usize = 4;
/// The tag of the notice for several chats, as the page's.
pub const ALL_CHATS: &str = "c:";

/// How much of a chat rings: a person's chat takes `All` or `Off` only.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChatLevel {
    All,
    Mentions,
    Off,
}

/// Which nodes heard for the first time ring: a person's radio, any, or none.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NodeLevel {
    People,
    All,
    Off,
}

/// A contact as the page knows it: its whole key in hex, its name, its advert type.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct Contact {
    pub key: String,
    #[serde(default)]
    pub name: String,
    #[serde(rename = "type", default)]
    pub kind: u8,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct Channel {
    pub index: u8,
    pub name: String,
}

/// What the page tells the watch: the reader's wishes (`noticePrefs.ts`) and the names to use.
/// The page sends it as JSON, in these names; what it leaves out keeps the page's default.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(default)]
pub struct WatchConfig {
    /// This radio's name, for the mentions of it (`@[name]`).
    pub me: String,
    pub direct: bool,
    /// Channels and rooms.
    pub chats: ChatLevel,
    pub nodes: NodeLevel,
    /// Chats with a level of their own, by conversation.
    pub chat: HashMap<String, ChatLevel>,
    pub contacts: Vec<Contact>,
    pub channels: Vec<Channel>,
    /// What the notices say, in the page's language.
    pub words: Words,
}

impl Default for WatchConfig {
    /// The page's defaults, for the time before it has said.
    fn default() -> Self {
        WatchConfig {
            me: String::new(),
            direct: true,
            chats: ChatLevel::All,
            nodes: NodeLevel::People,
            chat: HashMap::new(),
            contacts: Vec::new(),
            channels: Vec::new(),
            words: Words::default(),
        }
    }
}

/// A counted phrase: one form per plural category of the language (`one`, `few`, `many`, `other` …).
pub type Forms = HashMap<String, String>;

/// The words of the notices, from the page (`notices.core.*` in its `i18n`), `{placeholders}`
/// and all; English until the page has said. What the page leaves out stays English.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Words {
    pub new_contact: String,
    pub new_repeater: String,
    pub new_room: String,
    pub new_sensor: String,
    pub new_node: String,
    pub heard_first: String,
    pub unknown: String,
    pub channel: String,
    pub mentioned: String,
    pub mentioned_in: String,
    pub in_chat: String,
    pub chat_new: Forms,
    pub chat_new_mentioned: Forms,
    pub all_chats: String,
    pub new_messages: Forms,
    pub in_chats: Forms,
    /// The plural category of each count from 0 to 199 in the page's language; a larger count
    /// is taken as the one with its last two digits, past 100. Empty: English's.
    pub plurals: Vec<String>,
}

impl Default for Words {
    fn default() -> Self {
        let forms = |one: &str, other: &str| {
            Forms::from([
                ("one".to_string(), one.to_string()),
                ("other".to_string(), other.to_string()),
            ])
        };
        Words {
            new_contact: "New contact: {name}".into(),
            new_repeater: "New repeater: {name}".into(),
            new_room: "New room: {name}".into(),
            new_sensor: "New sensor: {name}".into(),
            new_node: "New node: {name}".into(),
            heard_first: "Heard for the first time.".into(),
            unknown: "Unknown {prefix}".into(),
            channel: "Channel {index}".into(),
            mentioned: "{who} mentioned you".into(),
            mentioned_in: "{who} mentioned you in {chat}".into(),
            in_chat: "{sender} in {chat}".into(),
            chat_new: forms("{chat} · {count} new", "{chat} · {count} new"),
            chat_new_mentioned: forms(
                "{chat} · {count} new, you are mentioned",
                "{chat} · {count} new, you are mentioned",
            ),
            all_chats: "{messages} in {chats}".into(),
            new_messages: forms("{count} new message", "{count} new messages"),
            in_chats: forms("{count} chat", "{count} chats"),
            plurals: Vec::new(),
        }
    }
}

impl Words {
    fn category(&self, count: usize) -> &str {
        let at = if count < 200 {
            count
        } else {
            100 + count % 100
        };
        match self.plurals.get(at) {
            Some(category) => category,
            None if count == 1 => "one",
            None => "other",
        }
    }

    /// The form for `count`, with `{count}` filled.
    fn counted(&self, forms: &Forms, count: usize) -> String {
        let form = forms
            .get(self.category(count))
            .or_else(|| forms.get("other"))
            .map(String::as_str)
            .unwrap_or("{count}");
        fill(form, &[("count", &count.to_string())])
    }
}

/// A phrase with its `{placeholders}` filled.
fn fill(phrase: &str, values: &[(&str, &str)]) -> String {
    let mut text = phrase.to_string();
    for (name, value) in values {
        text = text.replace(&format!("{{{name}}}"), value);
    }
    text
}

/// Which channel a notice goes on, where the system has channels.
#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum NoticeKind {
    Direct,
    Chats,
    Nodes,
}

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct Notice {
    /// The page's tag: `c:<conversation>`, `c:` for several chats, `n:<key>` for a node.
    pub tag: String,
    /// The number the phone knows it by, [`notice_id`] of the tag.
    pub id: i32,
    pub title: String,
    pub body: String,
    pub kind: NoticeKind,
    /// Shown without the signal: a burst of news rings with its first notice only.
    pub silent: bool,
}

impl Notice {
    fn new(tag: String, title: String, body: String, kind: NoticeKind) -> Self {
        Notice {
            id: notice_id(&tag),
            tag,
            title,
            body,
            kind,
            silent: false,
        }
    }
}

/// The number the phone knows a notice by, the same as the page's `noticeId`: FNV-1a
/// over the tag's UTF-16 units, kept positive for Android's `int` ids.
pub fn notice_id(tag: &str) -> i32 {
    let mut hash: u32 = 0x811c_9dc5;
    for unit in tag.encode_utf16() {
        hash ^= unit as u32;
        hash = hash.wrapping_mul(0x0100_0193);
    }
    match (hash & 0x7fff_ffff) as i32 {
        0 => 1,
        id => id,
    }
}

/// One message of a chat's notice.
#[derive(Clone, Debug)]
struct Line {
    sender: Option<String>,
    /// Who sent it, by key prefix, to know a copy sent again.
    from: Option<String>,
    text: String,
    timestamp: u32,
    mention: bool,
}

/// A chat with messages announced since the app went to the background.
#[derive(Clone, Debug)]
struct Chat {
    conversation: String,
    title: String,
    direct: bool,
    lines: Vec<Line>,
}

enum Waiting {
    Message(Vec<u8>),
    Node(Notice),
}

pub(crate) struct Watch {
    config: WatchConfig,
    background: bool,
    waiting: Vec<Waiting>,
    /// The number of the grace and quiet timers; bumped to let ones that are running do nothing.
    grace: i32,
    armed: bool,
    /// A burst of news is coming: the quiet timer is set.
    busy: bool,
    /// News came since the quiet timer was set, so the burst goes on.
    busy_again: bool,
    /// The burst has not rung yet: its next notice rings.
    unrung: bool,
    chats: Vec<Chat>,
    /// Chats with a notice of their own out.
    out: Vec<String>,
    all_out: bool,
    nodes_out: Vec<String>,
    effects: Vec<Effect>,
}

impl Watch {
    pub fn new() -> Self {
        Watch {
            config: WatchConfig::default(),
            background: false,
            waiting: Vec::new(),
            grace: 0,
            armed: false,
            busy: false,
            busy_again: false,
            unrung: false,
            chats: Vec::new(),
            out: Vec::new(),
            all_out: false,
            nodes_out: Vec::new(),
            effects: Vec::new(),
        }
    }

    pub fn take(&mut self) -> Vec<Effect> {
        std::mem::take(&mut self.effects)
    }

    pub fn configure(&mut self, config: WatchConfig) {
        self.config = config;
    }

    /// The app left the screen, or came back to it.
    pub fn set_background(&mut self, background: bool) {
        if background == self.background {
            return;
        }
        self.background = background;
        if !background {
            // The page reads its inbox now and announces what is still unread.
            for conversation in std::mem::take(&mut self.out) {
                self.withdraw(tag_of(&conversation));
            }
            if self.all_out {
                self.withdraw(ALL_CHATS.to_string());
            }
            for tag in std::mem::take(&mut self.nodes_out) {
                self.withdraw(tag);
            }
        }
        self.waiting.clear();
        self.chats.clear();
        self.all_out = false;
        self.armed = false;
        self.busy = false;
        self.busy_again = false;
        self.unrung = false;
        self.grace = self.grace.wrapping_add(1);
    }

    /// A message the mux read off the radio's queue.
    pub fn received(&mut self, frame: &[u8]) {
        if !self.background {
            return;
        }
        self.waiting.push(Waiting::Message(frame.to_vec()));
        self.news();
        self.arm();
    }

    /// The page took this message from its inbox: it is awake, and announces it itself.
    pub fn taken(&mut self, frame: &[u8]) {
        if let Some(at) = self
            .waiting
            .iter()
            .position(|w| matches!(w, Waiting::Message(f) if f == frame))
        {
            self.waiting.remove(at);
        }
    }

    /// A `NEW_ADVERT` push.
    pub fn heard(&mut self, frame: &[u8]) {
        if !self.background {
            return;
        }
        let Some(node) = read_new_advert(frame) else {
            return;
        };
        let wanted = match self.config.nodes {
            NodeLevel::All => true,
            NodeLevel::People => node.kind == ADV_TYPE_CHAT,
            NodeLevel::Off => false,
        };
        if !wanted {
            return;
        }
        let key = hex(&node.key);
        let name = if node.name.is_empty() {
            key[..12].to_string()
        } else {
            node.name
        };
        let words = &self.config.words;
        let title = match node.kind {
            ADV_TYPE_CHAT => &words.new_contact,
            ADV_TYPE_REPEATER => &words.new_repeater,
            ADV_TYPE_ROOM => &words.new_room,
            ADV_TYPE_SENSOR => &words.new_sensor,
            _ => &words.new_node,
        };
        let notice = Notice::new(
            format!("n:{key}"),
            fill(title, &[("name", &name)]),
            words.heard_first.clone(),
            NoticeKind::Nodes,
        );
        self.waiting.push(Waiting::Node(notice));
        self.news();
        self.arm();
    }

    /// The page announced this itself; the watch's notice for it waits no more.
    pub fn announced(&mut self, tag: &str) {
        self.waiting
            .retain(|w| !matches!(w, Waiting::Node(n) if n.tag == tag));
    }

    fn arm(&mut self) {
        if self.armed {
            return;
        }
        self.armed = true;
        self.effects.push(Effect::Wait {
            timer: Timer::Grace {
                generation: self.grace,
            },
            millis: GRACE_MS,
        });
    }

    /// News came. The first after a quiet starts a burst, which has not rung yet.
    fn news(&mut self) {
        if self.busy {
            self.busy_again = true;
            return;
        }
        self.busy = true;
        self.unrung = true;
        self.wait_for_quiet();
    }

    /// One timer at a time rather than one per message: a burst of a hundred would leave a
    /// hundred waiting. So the burst is over a whole quiet after its last news, at most two.
    fn wait_for_quiet(&mut self) {
        self.effects.push(Effect::Wait {
            timer: Timer::Quiet {
                generation: self.grace,
            },
            millis: QUIET_MS,
        });
    }

    /// The quiet timer is due: the burst goes on if news came meanwhile, and is over if not.
    pub fn quiet(&mut self, generation: i32) {
        if generation != self.grace || !self.busy {
            return;
        }
        if std::mem::take(&mut self.busy_again) {
            self.wait_for_quiet();
        } else {
            self.busy = false;
        }
    }

    /// Posts a notice: the burst's first rings, the rest bring what is out up to date quietly.
    fn post(&mut self, mut notice: Notice) {
        notice.silent = !std::mem::take(&mut self.unrung);
        self.effects.push(Effect::Post { notice });
    }

    /// The grace is over: what the page left is announced.
    pub fn timeout(&mut self, generation: i32) {
        if generation != self.grace || !self.armed {
            return;
        }
        self.armed = false;
        let mut fresh: Vec<String> = Vec::new();
        for waiting in std::mem::take(&mut self.waiting) {
            match waiting {
                Waiting::Node(notice) => {
                    self.nodes_out.push(notice.tag.clone());
                    self.post(notice);
                }
                Waiting::Message(frame) => {
                    if let Some(conversation) = self.add(&frame) {
                        if !fresh.contains(&conversation) {
                            fresh.push(conversation);
                        }
                    }
                }
            }
        }
        self.announce(fresh);
    }

    /// Adds a message to its chat, if it should ring; its conversation, then.
    fn add(&mut self, frame: &[u8]) -> Option<String> {
        let (chat, line) = self.resolve(read_message(frame)?)?;
        let level = self
            .config
            .chat
            .get(&chat.conversation)
            .copied()
            .unwrap_or(if chat.direct {
                if self.config.direct {
                    ChatLevel::All
                } else {
                    ChatLevel::Off
                }
            } else {
                self.config.chats
            });
        let wanted = level == ChatLevel::All || (level == ChatLevel::Mentions && line.mention);
        if !wanted {
            return None;
        }
        let at = match self
            .chats
            .iter()
            .position(|c| c.conversation == chat.conversation)
        {
            Some(at) => at,
            None => {
                self.chats.push(chat);
                self.chats.len() - 1
            }
        };
        let lines = &mut self.chats[at].lines;
        // A sender that heard no acknowledgement sends the same message again, and the radio hands up every copy.
        if lines
            .iter()
            .any(|l| l.from == line.from && l.timestamp == line.timestamp && l.text == line.text)
        {
            return None;
        }
        lines.push(line);
        Some(self.chats[at].conversation.clone())
    }

    /// Where a message goes and who wrote it, by the names the page gave.
    fn resolve(&self, message: Received) -> Option<(Chat, Line)> {
        let find = |start: &str| {
            self.config
                .contacts
                .iter()
                .find(|c| c.key.starts_with(start))
        };
        let (chat, sender, from, text, timestamp) = match message {
            Received::Direct {
                sender_prefix,
                txt_type,
                timestamp,
                signer,
                text,
            } => {
                if txt_type == TXT_TYPE_CLI_DATA {
                    return None; // a console's answer, not a message
                }
                let prefix = hex(&sender_prefix);
                let contact = find(&prefix);
                // A room relays its members' posts signed with the author's key prefix.
                let signer = signer.map(|s| hex(&s));
                let sender = match &signer {
                    Some(s) => Some(
                        find(s)
                            .map(|a| a.name.clone())
                            .filter(|n| !n.is_empty())
                            .unwrap_or_else(|| s.clone()),
                    ),
                    None => contact.map(|c| c.name.clone()).filter(|n| !n.is_empty()),
                };
                let chat = match contact {
                    Some(c) => Chat {
                        conversation: format!("c:{}", c.key),
                        title: if c.name.is_empty() {
                            c.key.chars().take(12).collect()
                        } else {
                            c.name.clone()
                        },
                        direct: c.kind != ADV_TYPE_ROOM,
                        lines: Vec::new(),
                    },
                    None => Chat {
                        conversation: format!("p:{prefix}"),
                        title: fill(&self.config.words.unknown, &[("prefix", &prefix)]),
                        direct: true,
                        lines: Vec::new(),
                    },
                };
                (
                    chat,
                    sender,
                    Some(signer.unwrap_or(prefix)),
                    text,
                    timestamp,
                )
            }
            Received::Channel {
                index,
                timestamp,
                text,
                ..
            } => {
                let (sender, text) = split_channel_text(&text);
                let name = self
                    .config
                    .channels
                    .iter()
                    .find(|c| c.index == index)
                    .map(|c| c.name.clone())
                    .filter(|n| !n.is_empty());
                let chat = Chat {
                    conversation: format!("ch:{index}"),
                    title: name.unwrap_or_else(|| {
                        fill(&self.config.words.channel, &[("index", &index.to_string())])
                    }),
                    direct: false,
                    lines: Vec::new(),
                };
                (
                    chat,
                    sender.map(str::to_string),
                    sender.map(str::to_string),
                    text.to_string(),
                    timestamp,
                )
            }
        };
        let me = &self.config.me;
        let mention = !me.is_empty() && text.contains(&format!("@[{me}]"));
        Some((
            chat,
            Line {
                sender,
                from,
                text,
                timestamp,
                mention,
            },
        ))
    }

    fn announce(&mut self, fresh: Vec<String>) {
        if fresh.is_empty() {
            return;
        }
        let separate = self
            .out
            .iter()
            .chain(fresh.iter().filter(|c| !self.out.contains(c)))
            .count();
        if self.all_out || separate > SEPARATE {
            for conversation in std::mem::take(&mut self.out) {
                self.withdraw(tag_of(&conversation));
            }
            self.all_out = true;
            let notice = self.all_chats_notice();
            self.post(notice);
            return;
        }
        for conversation in fresh {
            let Some(chat) = self.chats.iter().find(|c| c.conversation == conversation) else {
                continue;
            };
            let notice = chat_notice(chat, &self.config.words);
            if !self.out.contains(&conversation) {
                self.out.push(conversation);
            }
            self.post(notice);
        }
    }

    /// Every chat with messages, busiest first.
    fn all_chats_notice(&self) -> Notice {
        let mut chats: Vec<&Chat> = self.chats.iter().filter(|c| !c.lines.is_empty()).collect();
        chats.sort_by_key(|c| std::cmp::Reverse(c.lines.len()));
        let total: usize = chats.iter().map(|c| c.lines.len()).sum();
        let mut named: Vec<String> = chats
            .iter()
            .take(NAMED)
            .map(|c| format!("{} {}", c.title, c.lines.len()))
            .collect();
        if chats.len() > NAMED {
            named.push("…".to_string());
        }
        let words = &self.config.words;
        let title = fill(
            &words.all_chats,
            &[
                ("messages", &words.counted(&words.new_messages, total)),
                ("chats", &words.counted(&words.in_chats, chats.len())),
            ],
        );
        Notice::new(
            ALL_CHATS.to_string(),
            title,
            named.join(", "),
            NoticeKind::Chats,
        )
    }

    fn withdraw(&mut self, tag: String) {
        self.effects.push(Effect::Withdraw {
            id: notice_id(&tag),
            tag,
        });
    }
}

fn tag_of(conversation: &str) -> String {
    format!("c:{conversation}")
}

/// A chat's notice: the one message, or how many and the latest few.
fn chat_notice(chat: &Chat, words: &Words) -> Notice {
    let title = &chat.title;
    let kind = if chat.direct {
        NoticeKind::Direct
    } else {
        NoticeKind::Chats
    };
    let tag = tag_of(&chat.conversation);
    let channel = chat.conversation.starts_with("ch:");
    let lines = &chat.lines;
    if let [line] = lines.as_slice() {
        let sender = line.sender.as_deref().filter(|s| !s.is_empty());
        let heading = if line.mention {
            let who = sender.unwrap_or(title);
            match sender {
                Some(s) if s != title => {
                    fill(&words.mentioned_in, &[("who", who), ("chat", title)])
                }
                _ => fill(&words.mentioned, &[("who", who)]),
            }
        } else if let (Some(s), true) = (sender, channel) {
            fill(&words.in_chat, &[("sender", s), ("chat", title)])
        } else {
            title.clone()
        };
        return Notice::new(tag, heading, line.text.clone(), kind);
    }
    let mentioned = lines.iter().any(|l| l.mention);
    let body = lines[lines.len().saturating_sub(LINES)..]
        .iter()
        .map(|l| match l.sender.as_deref() {
            Some(s) if !s.is_empty() && s != title => format!("{s}: {}", l.text),
            _ => l.text.clone(),
        })
        .collect::<Vec<_>>()
        .join("\n");
    let forms = if mentioned {
        &words.chat_new_mentioned
    } else {
        &words.chat_new
    };
    let heading = fill(&words.counted(forms, lines.len()), &[("chat", title)]);
    Notice::new(tag, heading, body, kind)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Client, Core};

    const ALICE: &str = "a1a2a3a4a5a6000000000000000000000000000000000000000000000000000000";
    const ROOM: &str = "b1b2b3b4b5b6000000000000000000000000000000000000000000000000000000";
    const BOB: &str = "c1c2c3c4000000000000000000000000000000000000000000000000000000000000";

    fn config() -> WatchConfig {
        WatchConfig {
            me: "Node-21".into(),
            contacts: vec![
                Contact {
                    key: ALICE.into(),
                    name: "Alice".into(),
                    kind: ADV_TYPE_CHAT,
                },
                Contact {
                    key: ROOM.into(),
                    name: "Club".into(),
                    kind: ADV_TYPE_ROOM,
                },
                Contact {
                    key: BOB.into(),
                    name: "Bob".into(),
                    kind: ADV_TYPE_CHAT,
                },
            ],
            channels: vec![
                Channel {
                    index: 0,
                    name: "Public".into(),
                },
                Channel {
                    index: 1,
                    name: "#test".into(),
                },
            ],
            ..WatchConfig::default()
        }
    }

    fn direct(prefix: &str, timestamp: u32, text: &str) -> Vec<u8> {
        let key: Vec<u8> = (0..6)
            .map(|i| u8::from_str_radix(&prefix[i * 2..i * 2 + 2], 16).unwrap())
            .collect();
        [
            &[16u8, 0, 0, 0][..],
            &key,
            &[0, 0],
            &timestamp.to_le_bytes(),
            text.as_bytes(),
        ]
        .concat()
    }

    fn room_post(signer: [u8; 4], text: &str) -> Vec<u8> {
        [
            &[16u8, 0, 0, 0][..],
            &[0xb1, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6],
            &[0, 2],
            &9u32.to_le_bytes(),
            &signer,
            text.as_bytes(),
        ]
        .concat()
    }

    fn channel(index: u8, text: &str) -> Vec<u8> {
        [
            &[17u8, 0, 0, 0, index, 0, 0][..],
            &3u32.to_le_bytes(),
            text.as_bytes(),
        ]
        .concat()
    }

    /// A core with the radio up and its queue read, the app in the background, the page attached.
    struct Rig {
        core: Core,
        grace: Vec<Timer>,
        quiet: Vec<Timer>,
        posted: Vec<Notice>,
        withdrawn: Vec<String>,
    }

    impl Rig {
        fn new(config: WatchConfig) -> Self {
            let mut rig = Rig {
                core: Core::new(Vec::new()),
                grace: vec![],
                quiet: vec![],
                posted: vec![],
                withdrawn: vec![],
            };
            rig.core.configure(config);
            let effects = [
                rig.core.attach(Client::Page),
                rig.core.radio_up(),
                rig.core.from_radio(vec![10]),
            ]
            .concat();
            rig.note(effects);
            let effects = rig.core.set_background(true);
            rig.note(effects);
            rig
        }

        fn note(&mut self, effects: Vec<Effect>) {
            for effect in effects {
                match effect {
                    Effect::Wait {
                        timer: timer @ Timer::Grace { .. },
                        ..
                    } => self.grace.push(timer),
                    Effect::Wait {
                        timer: timer @ Timer::Quiet { .. },
                        ..
                    } => self.quiet.push(timer),
                    Effect::Post { notice } => self.posted.push(notice),
                    Effect::Withdraw { tag, .. } => self.withdrawn.push(tag),
                    _ => {}
                }
            }
        }

        /// The radio pushes that a message waits, and the core reads it.
        fn arrives(&mut self, frame: Vec<u8>) -> &mut Self {
            let effects = [
                self.core.from_radio(vec![0x83]),
                self.core.from_radio(frame),
                self.core.from_radio(vec![10]),
            ]
            .concat();
            self.note(effects);
            self
        }

        fn page_reads(&mut self) -> &mut Self {
            let effects = self.core.from_client(Client::Page, vec![10], None);
            self.note(effects);
            self
        }

        fn grace_ends(&mut self) -> &mut Self {
            for timer in std::mem::take(&mut self.grace) {
                let effects = self.core.timeout(timer);
                self.note(effects);
            }
            self
        }

        /// News stops long enough for its burst to be over.
        fn quiet_comes(&mut self) -> &mut Self {
            while !self.quiet.is_empty() {
                for timer in std::mem::take(&mut self.quiet) {
                    let effects = self.core.timeout(timer);
                    self.note(effects);
                }
            }
            self
        }

        /// Whether each notice posted rang.
        fn rang(&self) -> Vec<bool> {
            self.posted.iter().map(|n| !n.silent).collect()
        }

        fn titles(&self) -> Vec<&str> {
            self.posted.iter().map(|n| n.title.as_str()).collect()
        }
    }

    #[test]
    fn reads_the_pages_config() {
        let config: WatchConfig = serde_json::from_str(
            r#"{"me":"Node-21","direct":false,"chats":"mentions","nodes":"all","chat":{"ch:1":"off"},
                "contacts":[{"key":"a1","name":"Alice","type":1}],"channels":[{"index":0,"name":"Public"}],"extra":1}"#,
        )
        .unwrap();
        assert_eq!(config.me, "Node-21");
        assert!(!config.direct);
        assert_eq!(config.chats, ChatLevel::Mentions);
        assert_eq!(config.nodes, NodeLevel::All);
        assert_eq!(config.chat.get("ch:1"), Some(&ChatLevel::Off));
        assert_eq!(config.contacts[0].kind, ADV_TYPE_CHAT);
        assert_eq!(config.channels[0].name, "Public");
        let empty: WatchConfig = serde_json::from_str("{}").unwrap();
        assert_eq!(
            empty,
            WatchConfig::default(),
            "what is left out keeps the default"
        );
    }

    #[test]
    fn notice_ids_match_the_pages() {
        assert_eq!(notice_id("c:ch:1"), 658017366);
        assert_eq!(notice_id("c:"), 220850104);
        assert_eq!(notice_id("c:p:a1b2c3d4e5f6"), 19831856);
        assert_eq!(
            notice_id("n:0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20"),
            1580405683
        );
    }

    #[test]
    fn a_message_the_sleeping_page_leaves_is_announced() {
        let mut rig = Rig::new(config());
        rig.arrives(direct(&ALICE[..12], 1, "hi"));
        assert!(rig.posted.is_empty(), "nothing before the grace is over");
        rig.grace_ends();
        assert_eq!(
            rig.posted,
            vec![Notice::new(
                format!("c:c:{ALICE}"),
                "Alice".into(),
                "hi".into(),
                NoticeKind::Direct
            )]
        );
    }

    #[test]
    fn a_message_the_awake_page_takes_is_left_to_it() {
        let mut rig = Rig::new(config());
        rig.arrives(direct(&ALICE[..12], 1, "hi"))
            .page_reads()
            .grace_ends();
        assert!(rig.posted.is_empty());
    }

    #[test]
    fn in_front_the_watch_is_quiet() {
        let mut rig = Rig::new(config());
        let effects = rig.core.set_background(false);
        rig.note(effects);
        rig.arrives(direct(&ALICE[..12], 1, "hi")).grace_ends();
        assert!(rig.posted.is_empty());
    }

    #[test]
    fn more_in_a_chat_count_up_in_its_one_notice() {
        let mut rig = Rig::new(config());
        rig.arrives(channel(0, "RM55: first")).grace_ends();
        assert_eq!(rig.titles(), vec!["RM55 in Public"]);
        rig.arrives(channel(0, "Wan8: second"))
            .arrives(channel(0, "third"))
            .grace_ends();
        let last = rig.posted.last().unwrap();
        assert_eq!(last.tag, "c:ch:0");
        assert_eq!(last.title, "Public · 3 new");
        assert_eq!(last.body, "RM55: first\nWan8: second\nthird");
        assert_eq!(last.kind, NoticeKind::Chats);
    }

    #[test]
    fn a_mention_says_so() {
        let mut rig = Rig::new(config());
        rig.arrives(channel(1, "Wan8: @[Node-21] ты тут?"))
            .grace_ends();
        assert_eq!(rig.titles(), vec!["Wan8 mentioned you in #test"]);
    }

    #[test]
    fn levels_decide_what_rings() {
        let mut quiet = config();
        quiet.chats = ChatLevel::Mentions;
        quiet.chat.insert(format!("c:{ALICE}"), ChatLevel::Off);
        let mut rig = Rig::new(quiet);
        rig.arrives(channel(0, "RM55: hello all"))
            .arrives(direct(&ALICE[..12], 1, "hi"))
            .grace_ends();
        assert!(
            rig.posted.is_empty(),
            "a channel at mentions and a chat turned off stay quiet"
        );
        rig.arrives(channel(0, "RM55: @[Node-21] hi")).grace_ends();
        assert_eq!(rig.titles(), vec!["RM55 mentioned you in Public"]);
    }

    #[test]
    fn a_rooms_post_is_named_after_its_author_and_rings_as_a_chat() {
        let mut config = config();
        config.direct = false;
        let mut rig = Rig::new(config);
        rig.arrives(room_post([0xc1, 0xc2, 0xc3, 0xc4], "posted"))
            .grace_ends();
        assert_eq!(rig.posted.len(), 1);
        assert_eq!(rig.posted[0].title, "Club");
        assert_eq!(rig.posted[0].kind, NoticeKind::Chats);
        rig.arrives(room_post([0xde, 0xad, 0xbe, 0xef], "again"))
            .grace_ends();
        assert_eq!(rig.posted[1].body, "Bob: posted\ndeadbeef: again");
    }

    #[test]
    fn an_unknown_sender_and_a_copy_sent_again() {
        let mut rig = Rig::new(config());
        rig.arrives(direct("0a0b0c0d0e0f", 5, "who"))
            .arrives(direct("0a0b0c0d0e0f", 5, "who"))
            .grace_ends();
        assert_eq!(rig.posted.len(), 1, "the second copy is not news");
        assert_eq!(rig.posted[0].title, "Unknown 0a0b0c0d0e0f");
        assert_eq!(rig.posted[0].tag, "c:p:0a0b0c0d0e0f");
    }

    #[test]
    fn many_chats_become_one_notice() {
        let mut rig = Rig::new(config());
        rig.arrives(channel(0, "a: 1"))
            .arrives(channel(1, "b: 2"))
            .arrives(direct(&ALICE[..12], 1, "3"))
            .grace_ends();
        assert_eq!(rig.posted.len(), 3);
        rig.arrives(direct(&BOB[..12], 2, "4"))
            .arrives(channel(0, "c: 5"))
            .grace_ends();
        assert_eq!(rig.withdrawn.len(), 3, "the three notices go");
        let all = rig.posted.last().unwrap();
        assert_eq!(all.tag, ALL_CHATS);
        assert_eq!(all.title, "5 new messages in 4 chats");
        assert_eq!(all.body, "Public 2, #test 1, Alice 1, Bob 1");
        rig.arrives(channel(2, "d: 6")).grace_ends();
        assert_eq!(
            rig.posted.last().unwrap().title,
            "6 new messages in 5 chats",
            "and it stays one"
        );
        assert!(rig.posted.last().unwrap().body.ends_with(", …"));
    }

    #[test]
    fn the_notices_speak_the_pages_language_and_count_in_it() {
        // As the page sends it: Russian, with its plural category of each count up to 199.
        let plurals: Vec<&str> = (0..200)
            .map(|n| match (n % 10, n % 100) {
                (1, m) if m != 11 => "one",
                (2..=4, m) if !(12..=14).contains(&m) => "few",
                _ => "many",
            })
            .collect();
        let words: Words = serde_json::from_value(serde_json::json!({
            "inChat": "{sender} в {chat}",
            "allChats": "{messages} в {chats}",
            "newMessages": { "one": "{count} новое сообщение", "few": "{count} новых сообщения", "many": "{count} новых сообщений", "other": "{count} нового сообщения" },
            "inChats": { "one": "{count} чате", "few": "{count} чатах", "many": "{count} чатах", "other": "{count} чата" },
            "plurals": plurals,
        }))
        .unwrap();
        assert_eq!(words.counted(&words.new_messages, 21), "21 новое сообщение");
        assert_eq!(
            words.counted(&words.new_messages, 212),
            "212 новых сообщений"
        );
        let mut rig = Rig::new(WatchConfig { words, ..config() });
        rig.arrives(channel(0, "a: 1")).grace_ends();
        assert_eq!(rig.posted[0].title, "a в Public");
        rig.arrives(channel(1, "b: 2"))
            .arrives(direct(&ALICE[..12], 1, "3"))
            .arrives(direct(&BOB[..12], 2, "4"))
            .arrives(channel(0, "c: 5"))
            .grace_ends();
        assert_eq!(
            rig.posted.last().unwrap().title,
            "5 новых сообщений в 4 чатах"
        );
    }

    #[test]
    fn back_in_front_the_watchs_notices_go() {
        let mut rig = Rig::new(config());
        rig.arrives(channel(0, "a: 1")).grace_ends();
        let effects = rig.core.set_background(false);
        rig.note(effects);
        assert_eq!(rig.withdrawn, vec!["c:ch:0".to_string()]);
    }

    #[test]
    fn a_new_node_rings_unless_the_page_announced_it() {
        let advert = |kind: u8, first: u8, name: &str| {
            let mut f = vec![PUSH_NEW_ADVERT, first];
            f.extend([0u8; 31]);
            f.push(kind);
            f.extend([0u8; 66]);
            let mut field = [0u8; 32];
            field[..name.len()].copy_from_slice(name.as_bytes());
            f.extend(field);
            f
        };
        let mut rig = Rig::new(config());
        let effects = [
            rig.core.from_radio(advert(ADV_TYPE_REPEATER, 1, "Relay")),
            rig.core.from_radio(advert(ADV_TYPE_CHAT, 2, "Vlan")),
        ]
        .concat();
        rig.note(effects);
        rig.grace_ends();
        assert_eq!(
            rig.titles(),
            vec!["New contact: Vlan"],
            "people only, by default"
        );
        let effects = rig.core.from_radio(advert(ADV_TYPE_CHAT, 3, ""));
        rig.note(effects);
        let tag = format!("n:03{}", "00".repeat(31));
        let effects = rig.core.announced(tag);
        rig.note(effects);
        rig.grace_ends();
        assert_eq!(rig.posted.len(), 1, "the page said it announced it");
    }

    #[test]
    fn a_queue_read_out_rings_once_however_long_it_takes() {
        let mut rig = Rig::new(config());
        for i in 0..10 {
            rig.arrives(channel(0, &format!("a: {i}")));
        }
        rig.grace_ends();
        for i in 10..20 {
            rig.arrives(channel(0, &format!("a: {i}")));
        }
        rig.arrives(direct(&ALICE[..12], 1, "hi")).grace_ends();
        assert_eq!(
            rig.rang(),
            vec![true, false, false],
            "the first rings, the counts after it come quietly"
        );
        assert_eq!(rig.posted[1].title, "Public · 20 new");
        rig.quiet_comes()
            .arrives(channel(0, "b: later"))
            .grace_ends();
        assert_eq!(
            rig.rang().last(),
            Some(&true),
            "news after a quiet rings again"
        );
    }

    #[test]
    fn messages_seconds_apart_ring_each() {
        let mut rig = Rig::new(config());
        rig.arrives(channel(0, "a: one")).quiet_comes().grace_ends();
        rig.arrives(channel(0, "b: two")).quiet_comes().grace_ends();
        rig.arrives(direct(&ALICE[..12], 1, "three"))
            .quiet_comes()
            .grace_ends();
        assert_eq!(rig.rang(), vec![true, true, true]);
    }

    #[test]
    fn a_burst_in_several_chats_rings_with_its_first_notice() {
        let mut rig = Rig::new(config());
        rig.arrives(channel(0, "a: 1"))
            .arrives(channel(1, "b: 2"))
            .grace_ends();
        assert_eq!(rig.rang(), vec![true, false]);
    }
}
