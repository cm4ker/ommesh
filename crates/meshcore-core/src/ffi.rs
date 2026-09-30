//! The core as Kotlin and Swift see it (uniffi): [`Core`] behind a lock, since
//! the bindings share one object between calls. The owner still makes every
//! call from one thread, and carries out the effects each returns in order.

use std::sync::{Arc, Mutex, MutexGuard};

use crate::{Client, Core, Effect, Inbox, Timer, WatchConfig};

#[derive(uniffi::Object)]
pub struct Radio {
    core: Mutex<Core>,
}

#[uniffi::export]
impl Radio {
    /// With the inboxes saved last time, if any.
    #[uniffi::constructor]
    pub fn new(inboxes: Vec<Inbox>) -> Arc<Self> {
        Arc::new(Radio {
            core: Mutex::new(Core::new(inboxes)),
        })
    }

    pub fn inboxes(&self) -> Vec<Inbox> {
        self.core().inboxes()
    }

    pub fn attach(&self, client: Client) -> Vec<Effect> {
        self.core().attach(client)
    }

    pub fn detach(&self, client: Client) -> Vec<Effect> {
        self.core().detach(client)
    }

    pub fn from_client(&self, client: Client, frame: Vec<u8>, write: Option<i64>) -> Vec<Effect> {
        self.core().from_client(client, frame, write)
    }

    pub fn radio_up(&self) -> Vec<Effect> {
        self.core().radio_up()
    }

    pub fn radio_down(&self) -> Vec<Effect> {
        self.core().radio_down()
    }

    pub fn from_radio(&self, frame: Vec<u8>) -> Vec<Effect> {
        self.core().from_radio(frame)
    }

    pub fn timeout(&self, timer: Timer) -> Vec<Effect> {
        self.core().timeout(timer)
    }

    /// The page's notice settings and names, as the JSON it sends (see [`WatchConfig`]).
    pub fn configure(&self, json: String) -> Vec<Effect> {
        match serde_json::from_str::<WatchConfig>(&json) {
            Ok(config) => {
                self.core().configure(config);
                Vec::new()
            }
            Err(error) => vec![Effect::Log {
                line: format!("the page's notice settings could not be read: {error}"),
            }],
        }
    }

    pub fn set_background(&self, background: bool) -> Vec<Effect> {
        self.core().set_background(background)
    }

    pub fn announced(&self, tag: String) -> Vec<Effect> {
        self.core().announced(tag)
    }

    /// Starts the coverage survey the page describes in `json`; `now` is the phone's clock, ms.
    pub fn survey_start(&self, json: String, now: i64) -> Vec<Effect> {
        self.core().survey_start(json, now)
    }

    /// A fix from the phone's location service while a survey runs.
    pub fn survey_fix(&self, lat: f64, lon: f64, accuracy: f64, at: i64, now: i64) -> Vec<Effect> {
        self.core().survey_fix(lat, lon, accuracy, at, now)
    }

    pub fn survey_stop(&self) -> Vec<Effect> {
        self.core().survey_stop()
    }

    /// The survey running, as JSON for the page, with all its points or only the last.
    pub fn survey(&self, full: bool) -> Option<String> {
        self.core().survey(full)
    }
}

impl Radio {
    /// A call that panicked leaves the lock poisoned; the core is still whole, so it goes on.
    fn core(&self) -> MutexGuard<'_, Core> {
        self.core
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}
