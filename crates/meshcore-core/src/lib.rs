//! The radio's side of Meshnet, once for every shell: Android, iOS and the desktop.
//!
//! The client lives in a web view, and a phone puts a web view's scripts to
//! sleep soon after the app leaves the screen (Android a minute after, iOS
//! sooner), while the Bluetooth link stays up and the radio keeps talking. What
//! has to go on while the page sleeps is here:
//!
//! - [`mux`]: one radio shared by several clients (the page, a computer
//!   through the phone). The core reads the radio's message queue itself and
//!   keeps every message for each client until it asks.
//! - [`watch`]: notices for what the page leaves unread while it sleeps.
//! - [`frames`]: the few frames the two read.
//!
//! No Bluetooth, no clock, no threads. The owner (a shell's native code) hands
//! frames and events in, carries out the [`Effect`]s each call returns, runs
//! the timers they ask for and calls [`Core::timeout`] when one is due, all on
//! one thread. So the rules can be checked with `cargo test`, and every shell
//! runs the same ones.

pub mod codes;
mod ffi;
pub mod frames;
pub mod mux;
pub mod watch;

pub use ffi::Radio;

pub use watch::{
    notice_id, Channel, ChatLevel, Contact, NodeLevel, Notice, NoticeKind, WatchConfig,
};

use mux::{Event, Mux};
use watch::Watch;

uniffi::setup_scaffolding!();

/// Who talks to the radio through the core.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, uniffi::Enum)]
pub enum Client {
    /// The page of this app.
    Page,
    /// A computer connected to the phone, sharing its radio.
    Computer,
}

impl Client {
    pub const COUNT: usize = 2;
    pub const ALL: [Client; Client::COUNT] = [Client::Page, Client::Computer];

    pub(crate) fn index(self) -> usize {
        match self {
            Client::Page => 0,
            Client::Computer => 1,
        }
    }

    /// Its name where inboxes are saved.
    pub fn key(self) -> &'static str {
        match self {
            Client::Page => "page",
            Client::Computer => "computer",
        }
    }
}

/// A timer the core asked for; hand it back to [`Core::timeout`] when it is due.
#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum Timer {
    /// The wait for the answer to a command.
    Command { flight: i32 },
    /// The moment a message waits for an awake page to take it.
    Grace { generation: i32 },
    /// The wait for news to stop coming, which ends a burst of it (`watch::QUIET_MS`).
    Quiet { generation: i32 },
}

/// What the core asks its owner to do.
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum Effect {
    /// Write this frame to the radio.
    ToRadio {
        frame: Vec<u8>,
    },
    /// Hand this frame to a client.
    ToClient {
        client: Client,
        frame: Vec<u8>,
    },
    /// The client's write with this number went to the radio, or was dropped; its next may come.
    Written {
        write: i64,
    },
    /// Call [`Core::timeout`] with this timer after so many ms.
    Wait {
        timer: Timer,
        millis: i64,
    },
    /// The inboxes changed: save [`Core::inboxes`], so they outlive the app.
    InboxesChanged,
    /// Show this notice, in place of one out with its tag ([`notice_id`] of it).
    Post {
        notice: Notice,
    },
    /// Take down the notice with this tag, whose number is `id`.
    Withdraw {
        tag: String,
        id: i32,
    },
    Log {
        line: String,
    },
}

/// A client's messages kept by the core, as saved and handed back at start.
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct Inbox {
    pub client: Client,
    pub frames: Vec<Vec<u8>>,
}

pub struct Core {
    mux: Mux,
    watch: Watch,
}

impl Core {
    /// With the inboxes saved last time, if any.
    pub fn new(inboxes: Vec<Inbox>) -> Self {
        Core {
            mux: Mux::new(inboxes.into_iter().map(|i| (i.client, i.frames)).collect()),
            watch: Watch::new(),
        }
    }

    pub fn inboxes(&self) -> Vec<Inbox> {
        Client::ALL
            .iter()
            .map(|&client| Inbox {
                client,
                frames: self.mux.inbox(client).to_vec(),
            })
            .collect()
    }

    // Clients

    pub fn attach(&mut self, client: Client) -> Vec<Effect> {
        self.mux.attach(client);
        self.settle()
    }

    pub fn detach(&mut self, client: Client) -> Vec<Effect> {
        self.mux.detach(client);
        self.settle()
    }

    /// A frame a client wrote; [`Effect::Written`] with `write` says when it reached the radio.
    pub fn from_client(
        &mut self,
        client: Client,
        frame: Vec<u8>,
        write: Option<i64>,
    ) -> Vec<Effect> {
        self.mux.from_client(client, frame, write);
        self.settle()
    }

    // The radio

    pub fn radio_up(&mut self) -> Vec<Effect> {
        self.mux.radio_up();
        self.settle()
    }

    pub fn radio_down(&mut self) -> Vec<Effect> {
        self.mux.radio_down();
        self.settle()
    }

    pub fn from_radio(&mut self, frame: Vec<u8>) -> Vec<Effect> {
        if frame.first() == Some(&codes::PUSH_NEW_ADVERT) {
            self.watch.heard(&frame);
        }
        self.mux.from_radio(&frame);
        self.settle()
    }

    pub fn timeout(&mut self, timer: Timer) -> Vec<Effect> {
        match timer {
            Timer::Command { flight } => self.mux.timeout(flight),
            Timer::Grace { generation } => self.watch.timeout(generation),
            Timer::Quiet { generation } => self.watch.quiet(generation),
        }
        self.settle()
    }

    // The page and the app

    /// The reader's wishes and the names to use, from the page.
    pub fn configure(&mut self, config: WatchConfig) {
        self.watch.configure(config);
    }

    /// The app left the screen, or came back to it.
    pub fn set_background(&mut self, background: bool) -> Vec<Effect> {
        self.watch.set_background(background);
        self.settle()
    }

    /// The page announced this itself (its tag).
    pub fn announced(&mut self, tag: String) -> Vec<Effect> {
        self.watch.announced(&tag);
        self.settle()
    }

    /// Everything the last call asked for, the watch's part after the mux's.
    fn settle(&mut self) -> Vec<Effect> {
        let (mut effects, events) = self.mux.take();
        for event in events {
            match event {
                Event::Kept(frame) => self.watch.received(&frame),
                Event::Taken(Client::Page, frame) => self.watch.taken(&frame),
                Event::Taken(..) => {}
            }
        }
        effects.extend(self.watch.take());
        effects
    }
}
