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
//! - [`store`]: those messages in a database on the phone's disk, so they outlive the app.
//! - [`watch`]: notices for what the page leaves unread while it sleeps.
//! - [`survey`]: a coverage survey, asking who hears the radio as the phone moves.
//! - [`frames`]: the few frames they read.
//!
//! No Bluetooth, no clock, no threads. The owner (a shell's native code) hands
//! frames and events in, carries out the [`Effect`]s each call returns, runs
//! the timers they ask for and calls [`Core::timeout`] when one is due, all on
//! one thread. So the rules can be checked with `cargo test`, and every shell
//! runs the same ones. The one thing the core does itself is write its
//! database, inside the call: a message read off the radio has to be on disk
//! before the radio is asked for the next, and the core would not know when a
//! write it asked of the owner was done.

pub mod codes;
mod ffi;
pub mod frames;
mod legacy;
pub mod mux;
mod store;
pub mod survey;
pub mod watch;

pub use ffi::Radio;

pub use watch::{
    notice_id, Channel, ChatLevel, Contact, NodeLevel, Notice, NoticeKind, WatchConfig,
};

use mux::{Event, Mux};
use store::Store;
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
    /// The time a survey's check of one repeater is waited for.
    Check { generation: i32 },
    /// The moment the inboxes are saved, after a change ([`SAVE_MS`]).
    Save,
}

/// How long after a change the inboxes are saved, unless it was a message read off the radio,
/// which is saved at once: a burst of changes, as a page taking and saving what waited for it,
/// is written once. Lost meanwhile, what a client took comes to it once more, and it sets
/// aside what it has.
pub const SAVE_MS: i64 = 2000;

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

/// A client's messages kept by the core, as the owner kept them before the core's database.
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct Inbox {
    pub client: Client,
    pub frames: Vec<Vec<u8>>,
}

pub struct Core {
    mux: Mux,
    watch: Watch,
    survey: Survey,
    store: Store,
    /// Whether a save waits for its timer.
    saving: bool,
    /// What went wrong opening the database, told with the first call's effects.
    problems: Vec<String>,
}

impl Core {
    /// With the inboxes in the database at `path`, made there if new. A new one takes in the
    /// inboxes kept before it: the snapshot and log the owner wrote for the core, or, with no
    /// snapshot, `inboxes` from the owner's settings ([`store`]).
    pub fn open(path: &str, snapshot: &[u8], log: &[u8], inboxes: Vec<Inbox>) -> Self {
        let opened = Store::open(path, snapshot, log, inboxes);
        Core {
            mux: Mux::new(
                opened
                    .inboxes
                    .into_iter()
                    .map(|i| (i.client, i.frames))
                    .collect(),
            ),
            watch: Watch::new(),
            survey: Survey::new(),
            store: opened.store,
            saving: false,
            problems: opened.problems,
        }
    }

    /// With a database that lives as long as it does.
    #[cfg(test)]
    pub(crate) fn in_memory() -> Self {
        Core::open(":memory:", &[], &[], Vec::new())
    }

    /// Whether the inboxes are on disk: only then may the ways they were kept before go.
    pub fn on_disk(&self) -> bool {
        self.store.on_disk()
    }

    pub fn inboxes(&self) -> Vec<Inbox> {
        Client::ALL
            .iter()
            .map(|&client| Inbox {
                client,
                frames: self.mux.kept(client),
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
            Some(&codes::PUSH_TRACE_DATA) => self.survey.traced(&frame),
            _ => {}
        }
        self.mux.from_radio(&frame);
        self.settle()
    }

    /// A timer is due, at `now` on the owner's clock, ms: Do not disturb goes by it.
    pub fn timeout(&mut self, timer: Timer, now: i64) -> Vec<Effect> {
        match timer {
            Timer::Command { flight } => self.mux.timeout(flight),
            Timer::Grace { generation } => self.watch.timeout(generation, now),
            Timer::Quiet { generation } => self.watch.quiet(generation),
            Timer::Listen { generation } => self.survey.timeout(generation),
            Timer::Check { generation } => self.survey.check_timeout(generation),
            Timer::Save => {
                self.saving = false;
                return self.save().into_iter().collect();
            }
        }
        self.settle()
    }

    /// The inboxes written as they are now; what went wrong, if anything.
    fn save(&mut self) -> Option<Effect> {
        let now = Client::ALL.map(|client| self.mux.kept_frames(client).collect());
        let error = self.store.save(now).err()?;
        Some(Effect::Log {
            line: format!("the inboxes could not be saved: {error}"),
        })
    }

    /// Messages read off the radio written at once, at the end of every inbox as the mux keeps
    /// them; the whole inboxes when the store cannot be sure of its database.
    fn save_read(&mut self, read: &[Vec<u8>]) -> Option<Effect> {
        if self.store.is_stale() {
            return self.save();
        }
        let error = self.store.append(read).err()?;
        Some(Effect::Log {
            line: format!("messages read off the radio could not be saved: {error}"),
        })
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
        let mut effects: Vec<Effect> = self
            .problems
            .drain(..)
            .map(|line| Effect::Log { line })
            .collect();
        // A message read off the radio is gone from it: on disk before the owner reads the next.
        let mut read = Vec::new();
        let mut changed = false;
        loop {
            let (out, events) = self.mux.take();
            effects.extend(out);
            for event in events {
                match event {
                    Event::Kept(frame) => {
                        self.watch.received(&frame);
                        read.push(frame);
                    }
                    Event::Taken(Client::Page, frame) => self.watch.taken(&frame),
                    Event::Taken(..) => {}
                    // What the computer read is no news on the phone either.
                    Event::Entry(Client::Computer, frame) => {
                        if let Some(mark) = frames::read_mark(&frame) {
                            self.watch.read_elsewhere(&mark);
                        }
                    }
                    Event::Entry(..) => {}
                    Event::Asked(frame) => self.survey.asked(&frame),
                    Event::Answered(frame) => self.survey.answered(&frame),
                    Event::Unanswered => self.survey.unanswered(),
                    Event::InboxesChanged => changed = true,
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
        if !read.is_empty() {
            effects.extend(self.save_read(&read));
        }
        // Whatever else changed, as an inbox over its limit losing its oldest, is written in time.
        if changed && !self.saving {
            self.saving = true;
            effects.push(Effect::Wait {
                timer: Timer::Save,
                millis: SAVE_MS,
            });
        }
        effects.extend(self.watch.take());
        effects.extend(self.survey.take());
        effects
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use codes::{RESP_CONTACT_MSG_RECV_V3, RESP_NO_MORE_MESSAGES};

    fn save_timers(effects: &[Effect]) -> usize {
        effects
            .iter()
            .filter(|e| {
                matches!(
                    e,
                    Effect::Wait {
                        timer: Timer::Save,
                        ..
                    }
                )
            })
            .count()
    }

    /// The inboxes as another hand opening the database finds them now.
    fn on_disk(path: &str) -> Vec<Inbox> {
        Core::open(path, &[], &[], Vec::new()).inboxes()
    }

    fn count(inboxes: &[Inbox]) -> [usize; Client::COUNT] {
        Client::ALL.map(|client| inboxes[client.index()].frames.len())
    }

    #[test]
    fn a_message_read_off_the_radio_is_on_disk_before_the_next_read() {
        let path = store::scratch("read-off-radio");
        let mut core = Core::open(&path, &[], &[], Vec::new());
        assert!(core.on_disk());
        core.radio_up();
        for n in 0..3 {
            let effects = core.from_radio(vec![RESP_CONTACT_MSG_RECV_V3, n]);
            assert!(effects.iter().any(|e| matches!(e, Effect::ToRadio { frame } if frame[0] == codes::CMD_SYNC_NEXT_MESSAGE)));
            assert_eq!(count(&on_disk(&path)), [n as usize + 1; 2]);
        }
        core.from_radio(vec![RESP_NO_MORE_MESSAGES]);
        assert_eq!(on_disk(&path), core.inboxes());
    }

    #[test]
    fn what_a_page_took_and_saved_leaves_the_disk_after_the_wait() {
        let path = store::scratch("taken-and-saved");
        let mut core = Core::open(&path, &[], &[], Vec::new());
        core.radio_up();
        for n in 0..3 {
            core.from_radio(vec![RESP_CONTACT_MSG_RECV_V3, n]);
        }
        core.from_radio(vec![RESP_NO_MORE_MESSAGES]);
        assert!(
            core.timeout(Timer::Save, 0).is_empty(),
            "nothing more to write"
        );

        let mut effects = core.attach(Client::Page);
        effects.extend(core.from_client(
            Client::Page,
            vec![codes::PEER, codes::PEER_KEEP, 0],
            None,
        ));
        for _ in 0..3 {
            effects.extend(core.from_client(
                Client::Page,
                vec![codes::CMD_SYNC_NEXT_MESSAGE],
                None,
            ));
        }
        effects.extend(core.from_client(
            Client::Page,
            vec![codes::PEER, codes::PEER_SAVED, 3, 0, 0, 0],
            None,
        ));
        assert_eq!(save_timers(&effects), 1, "one save for all of it");
        assert_eq!(
            count(&on_disk(&path)),
            [3, 3],
            "kept until the wait is over"
        );

        assert!(core.timeout(Timer::Save, 0).is_empty());
        assert_eq!(count(&on_disk(&path)), [0, 3]);
        assert_eq!(on_disk(&path), core.inboxes());
    }

    #[test]
    fn a_problem_opening_the_database_is_told_with_the_first_effects() {
        let path = store::scratch("problem");
        std::fs::write(
            &path,
            b"not a database at all, and long enough to be read as one",
        )
        .unwrap();
        let mut core = Core::open(&path, &[], &[], Vec::new());
        let effects = core.radio_up();
        assert!(
            matches!(&effects[0], Effect::Log { line } if line.contains("could not be opened"))
        );
        assert!(!core
            .radio_down()
            .iter()
            .any(|e| matches!(e, Effect::Log { .. })));
    }
}
