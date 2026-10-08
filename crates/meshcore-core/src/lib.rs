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
//! - [`survey`]: a coverage survey, asking who hears the radio as the phone moves.
//! - [`frames`]: the few frames they read.
//! - `fetch` (with the `link-fetch` feature): a link preview's fetch, for the
//!   phone's native code; the one part that is not the radio's.
//!
//! No Bluetooth, no clock, no threads. The owner (a shell's native code) hands
//! frames and events in, carries out the [`Effect`]s each call returns, runs
//! the timers they ask for and calls [`Core::timeout`] when one is due, all on
//! one thread. So the rules can be checked with `cargo test`, and every shell
//! runs the same ones.

pub mod codes;
mod ffi;
#[cfg(feature = "link-fetch")]
pub mod fetch;
pub mod frames;
pub mod mux;
pub mod survey;
pub mod watch;

pub use ffi::Radio;

pub use watch::{
    notice_id, Channel, ChatLevel, Contact, NodeLevel, Notice, NoticeKind, WatchConfig,
};

use mux::{Event, Mux};
use survey::{Fix, Survey};
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
    /// The time a survey's ask is listened for (`survey::LISTEN_MS`).
    Listen { generation: i32 },
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
    /// The survey moved on: hand [`Core::survey`] to the page, and keep it, so its points outlive the app.
    SurveyChanged,
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
    survey: Survey,
}

impl Core {
    /// With the inboxes saved last time, if any.
    pub fn new(inboxes: Vec<Inbox>) -> Self {
        Core {
            mux: Mux::new(inboxes.into_iter().map(|i| (i.client, i.frames)).collect()),
            watch: Watch::new(),
            survey: Survey::new(),
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
        self.survey.radio(true);
        self.settle()
    }

    pub fn radio_down(&mut self) -> Vec<Effect> {
        self.mux.radio_down();
        self.survey.radio(false);
        self.settle()
    }

    pub fn from_radio(&mut self, frame: Vec<u8>) -> Vec<Effect> {
        match frame.first() {
            Some(&codes::PUSH_NEW_ADVERT) => self.watch.heard(&frame),
            Some(&codes::PUSH_CONTROL_DATA) => self.survey.heard(&frame),
            _ => {}
        }
        self.mux.from_radio(&frame);
        self.settle()
    }

    pub fn timeout(&mut self, timer: Timer) -> Vec<Effect> {
        match timer {
            Timer::Command { flight } => self.mux.timeout(flight),
            Timer::Grace { generation } => self.watch.timeout(generation),
            Timer::Quiet { generation } => self.watch.quiet(generation),
            Timer::Listen { generation } => self.survey.timeout(generation),
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

    // The coverage survey

    /// Starts the survey the page describes in `json` (its `id`, and the `radio`, `startedAt`
    /// and `asks` it has); `now` is the owner's clock, ms, as in every fix after it.
    pub fn survey_start(&mut self, json: String, now: i64) -> Vec<Effect> {
        self.survey.radio(self.mux.is_up());
        if let Err(error) = self.survey.start(&json, now) {
            return vec![Effect::Log {
                line: format!("the page's survey could not be read: {error}"),
            }];
        }
        self.settle()
    }

    /// Where the phone is, from its location service, as often as it says while a survey runs:
    /// degrees, metres either way, when the fix was taken and the time now, both ms.
    pub fn survey_fix(
        &mut self,
        lat: f64,
        lon: f64,
        accuracy: f64,
        at: i64,
        now: i64,
    ) -> Vec<Effect> {
        let fix = Fix {
            lat,
            lon,
            accuracy,
            at,
        };
        self.survey.fix(fix, now);
        self.settle()
    }

    pub fn survey_stop(&mut self) -> Vec<Effect> {
        self.survey.stop();
        self.settle()
    }

    /// The survey running, as JSON for the page: what it is doing and its points, all of them
    /// when `full` and only the last otherwise. None when none runs.
    pub fn survey(&self, full: bool) -> Option<String> {
        self.survey.status(full, self.watch.config())
    }

    /// Everything the last call asked for: the mux's part, then the watch's and the survey's.
    fn settle(&mut self) -> Vec<Effect> {
        let mut effects = Vec::new();
        loop {
            let (out, events) = self.mux.take();
            effects.extend(out);
            for event in events {
                match event {
                    Event::Kept(frame) => self.watch.received(&frame),
                    Event::Taken(Client::Page, frame) => self.watch.taken(&frame),
                    Event::Taken(..) => {}
                    Event::Asked(frame) => self.survey.asked(&frame),
                    Event::Answered(frame) => self.survey.answered(&frame),
                    Event::Unanswered => self.survey.unanswered(),
                }
            }
            // A survey's ask goes through the mux, which may have more to say for it.
            let asks = self.survey.take_frames();
            if asks.is_empty() {
                break;
            }
            for ask in asks {
                self.mux.send_own(ask);
            }
        }
        effects.extend(self.watch.take());
        effects.extend(self.survey.take());
        effects
    }
}
