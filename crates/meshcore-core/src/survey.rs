//! A coverage survey that goes on while the page sleeps.
//!
//! A survey is a drive with the radio: every so often the phone asks the
//! repeaters in direct range "who hears me" and keeps where it was and who
//! answered. Where the page stays awake it runs the survey itself
//! (`apps/web/src/lib/survey.ts`). A phone puts the page to sleep once the app
//! leaves the screen or the phone is locked, so there the survey runs here, in
//! front or not: the owner hands in the phone's position as it comes, the
//! survey asks through the mux in its turn, and the page shows what it kept.
//!
//! The rule is the page's (`surveyData.ts`, and the count of asks in
//! `hears.ts`): change both together.

use serde::{Deserialize, Serialize};

use crate::codes::*;
use crate::frames::{discover_ask, hex, is_discover_ask, read_discover_answer};
use crate::watch::fill;
use crate::{Effect, Timer, WatchConfig};

/// An ask every half minute at most: a repeater answers four in two minutes, whoever asks.
pub const PING_EVERY_MS: i64 = 30_000;
/// Standing still adds nothing to the map, so the next ask waits until the phone has moved this far.
pub const MOVE_M: f64 = 50.0;
/// A fix vaguer than this would put the point in the wrong street.
pub const FIX_M: f64 = 50.0;
/// A fix older than this is where the phone was, not where it is.
pub const FIX_AGE_MS: i64 = 20_000;
/// How long an ask's answers are listened for: each repeater answers after a random pause.
pub const LISTEN_MS: i64 = 10_000;
/// The asks a repeater answers in [`ASK_WINDOW_MS`].
const ASK_LIMIT: usize = 4;
const ASK_WINDOW_MS: i64 = 120_000;

/// What the survey is doing, in the page's names.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Phase {
    /// Waiting for a fix good enough.
    Gps,
    /// Waiting out the half minute.
    Wait,
    /// Waiting for the phone to move.
    Still,
    /// An ask is out.
    Listening,
    /// The radio is not there.
    Offline,
}

/// Where the phone is, as its location service says: degrees, metres either way, and when (ms).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Fix {
    pub lat: f64,
    pub lon: f64,
    pub accuracy: f64,
    pub at: i64,
}

/// One repeater's answer at a point: how it heard us and how we heard it, dB, and the signal's strength, dBm.
#[derive(Clone, Debug, PartialEq, Serialize)]
struct Reply {
    key: String,
    us: f64,
    them: f64,
    rssi: i32,
}

/// Where the phone was when it asked and who answered; none is a point too.
#[derive(Clone, Debug, PartialEq, Serialize)]
struct Point {
    at: i64,
    lat: f64,
    lon: f64,
    accuracy: f64,
    replies: Vec<Reply>,
}

/// What the page starts a survey with, as JSON: its own name for it, the radio and the time it
/// began, which are only kept for the page, and when "who hears me" was last asked from its button.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Start {
    id: String,
    #[serde(default)]
    radio: String,
    #[serde(default)]
    started_at: i64,
    #[serde(default)]
    asks: Vec<i64>,
}

/// The survey as the page reads it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Status<'a> {
    id: &'a str,
    radio: &'a str,
    started_at: i64,
    phase: Phase,
    last_ping_at: Option<i64>,
    /// How many points there are; `points` holds the last of them, or all.
    count: usize,
    points: &'a [Point],
    /// What a notice that stays up while the survey runs says, in the page's words: how many
    /// points, and the last of them or why none is being made.
    title: String,
    line: String,
}

/// An ask on its way or out: the point it will make, and the answers so far.
struct Ask {
    tag: u32,
    point: Point,
    /// The radio took it, and its answers are being listened for.
    sent: bool,
}

struct Run {
    id: String,
    radio: String,
    started_at: i64,
    phase: Phase,
    /// The time of the last fix: the core has no clock of its own.
    now: i64,
    /// When "who hears me" went out lately, from here or from a client.
    asks: Vec<i64>,
    last_ping_at: Option<i64>,
    points: Vec<Point>,
    ask: Option<Ask>,
}

pub(crate) struct Survey {
    run: Option<Run>,
    radio_up: bool,
    /// Bumped per ask, so the listening timer of one given up on does nothing.
    generation: i32,
    /// The last tag, to draw the next from.
    tag: u32,
    /// Asks for the radio, which the mux sends in their turn.
    frames: Vec<Vec<u8>>,
    effects: Vec<Effect>,
}

impl Survey {
    pub fn new() -> Self {
        Survey {
            run: None,
            radio_up: false,
            generation: 0,
            tag: 0,
            frames: Vec::new(),
            effects: Vec::new(),
        }
    }

    pub fn take(&mut self) -> Vec<Effect> {
        std::mem::take(&mut self.effects)
    }

    pub fn take_frames(&mut self) -> Vec<Vec<u8>> {
        std::mem::take(&mut self.frames)
    }

    /// Starts the survey the page describes; one already running under that name goes on as it is.
    pub fn start(&mut self, json: &str, now: i64) -> Result<(), serde_json::Error> {
        let start: Start = serde_json::from_str(json)?;
        if self.run.as_ref().is_some_and(|run| run.id == start.id) {
            return Ok(());
        }
        self.forget_ask();
        self.run = Some(Run {
            id: start.id,
            radio: start.radio,
            started_at: start.started_at,
            phase: if self.radio_up {
                Phase::Gps
            } else {
                Phase::Offline
            },
            now,
            asks: start.asks,
            last_ping_at: None,
            points: Vec::new(),
            ask: None,
        });
        self.effects.push(Effect::SurveyChanged);
        Ok(())
    }

    pub fn stop(&mut self) {
        self.forget_ask();
        self.run = None;
    }

    /// The survey as JSON for the page, with its last point only or with all of them; none when
    /// none runs. `config` has the words and names its notice is said in.
    pub fn status(&self, full: bool, config: &WatchConfig) -> Option<String> {
        let run = self.run.as_ref()?;
        let (title, line) = said(run, config);
        let from = if full {
            0
        } else {
            run.points.len().saturating_sub(1)
        };
        serde_json::to_string(&Status {
            id: &run.id,
            radio: &run.radio,
            started_at: run.started_at,
            phase: run.phase,
            last_ping_at: run.last_ping_at,
            count: run.points.len(),
            points: &run.points[from..],
            title,
            line,
        })
        .ok()
    }

    /// The radio came, or went: an ask out when it goes says nothing about the spot.
    pub fn radio(&mut self, up: bool) {
        self.radio_up = up;
        if self.run.is_none() {
            return;
        }
        if up {
            // The next fix says what is next.
            self.set_phase(Phase::Gps);
        } else {
            self.forget_ask();
            self.set_phase(Phase::Offline);
        }
    }

    /// The phone's position, as often as it comes: each one is the moment to ask, or not yet.
    pub fn fix(&mut self, fix: Fix, now: i64) {
        let radio_up = self.radio_up;
        let Some(run) = &mut self.run else { return };
        run.now = now;
        run.asks.retain(|at| now - at < ASK_WINDOW_MS);
        if run.ask.is_some() {
            return;
        }
        if !radio_up {
            return self.set_phase(Phase::Offline);
        }
        let phase = match step(now, &fix, run.last_ping_at, run.points.last()) {
            Step::Gps => Phase::Gps,
            Step::Wait => Phase::Wait,
            Step::Still => Phase::Still,
            Step::Ping => {
                // An ask already out, from the page's button, is let finish first; and
                // none goes that the repeaters would leave unanswered.
                let listening = run.asks.iter().any(|at| now - at < LISTEN_MS);
                if listening || run.asks.len() >= ASK_LIMIT {
                    Phase::Wait
                } else {
                    return self.ask(fix, now);
                }
            }
        };
        self.set_phase(phase);
    }

    fn ask(&mut self, fix: Fix, now: i64) {
        self.generation = self.generation.wrapping_add(1);
        let tag = self.next_tag(now);
        let Some(run) = &mut self.run else { return };
        run.ask = Some(Ask {
            tag,
            point: Point {
                at: now,
                lat: fix.lat,
                lon: fix.lon,
                accuracy: fix.accuracy,
                replies: Vec::new(),
            },
            sent: false,
        });
        run.last_ping_at = Some(now);
        run.asks.push(now);
        self.frames.push(discover_ask(tag));
        self.set_phase(Phase::Listening);
    }

    /// A number to know an ask's answers by; any will do that the asks before did not have.
    fn next_tag(&mut self, now: i64) -> u32 {
        let mut x = self.tag ^ (now as u32) ^ 0x9e37_79b9;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.tag = x;
        x
    }

    /// A client's command went to the radio: its own "who hears me" counts with the survey's.
    pub fn asked(&mut self, frame: &[u8]) {
        if !is_discover_ask(frame) {
            return;
        }
        if let Some(run) = &mut self.run {
            run.asks.push(run.now);
        }
    }

    /// The radio's answer to the ask: taken, its answers are listened for; refused, it made no point.
    pub fn answered(&mut self, frame: &[u8]) {
        let generation = self.generation;
        let Some(ask) = self.run.as_mut().and_then(|run| run.ask.as_mut()) else {
            return;
        };
        if ask.sent {
            return;
        }
        if frame.first() != Some(&RESP_OK) {
            return self.unanswered();
        }
        ask.sent = true;
        self.effects.push(Effect::Wait {
            timer: Timer::Listen { generation },
            millis: LISTEN_MS,
        });
    }

    /// The ask never got to the air: the next waits its half minute all the same.
    pub fn unanswered(&mut self) {
        if self.run.as_ref().is_some_and(|run| run.ask.is_some()) {
            self.forget_ask();
            self.set_phase(Phase::Wait);
        }
    }

    /// A `CONTROL_DATA` push: a repeater's answer to the ask out is kept, its latest if it answers twice.
    pub fn heard(&mut self, frame: &[u8]) {
        let Some(ask) = self.run.as_mut().and_then(|run| run.ask.as_mut()) else {
            return;
        };
        let Some(answer) = read_discover_answer(frame) else {
            return;
        };
        if answer.tag != ask.tag || answer.kind != ADV_TYPE_REPEATER {
            return;
        }
        let reply = Reply {
            key: hex(&answer.key),
            us: f64::from(answer.heard_us) / 4.0,
            them: f64::from(answer.snr) / 4.0,
            rssi: i32::from(answer.rssi),
        };
        ask.point.replies.retain(|r| r.key != reply.key);
        ask.point.replies.push(reply);
    }

    /// The listening is over: the ask is a point, answered or not.
    pub fn timeout(&mut self, generation: i32) {
        if generation != self.generation {
            return;
        }
        let Some(run) = &mut self.run else { return };
        let Some(ask) = run.ask.take() else { return };
        run.points.push(ask.point);
        run.phase = Phase::Wait;
        self.effects.push(Effect::SurveyChanged);
    }

    fn forget_ask(&mut self) {
        self.generation = self.generation.wrapping_add(1);
        if let Some(run) = &mut self.run {
            run.ask = None;
        }
    }

    fn set_phase(&mut self, phase: Phase) {
        let Some(run) = &mut self.run else { return };
        if run.phase != phase {
            run.phase = phase;
            self.effects.push(Effect::SurveyChanged);
        }
    }
}

/// The survey's notice: its title, and the line under it.
fn said(run: &Run, config: &WatchConfig) -> (String, String) {
    let words = &config.words;
    let points = words.counted(&words.survey_points, run.points.len());
    let title = fill(&words.survey_title, &[("points", &points)]);
    let line = match (run.phase, run.points.last()) {
        (Phase::Offline, _) => words.survey_offline.clone(),
        (Phase::Gps, _) => words.survey_gps.clone(),
        (Phase::Still, _) => words.survey_still.clone(),
        (Phase::Listening, None) => words.survey_listening.clone(),
        (Phase::Wait, None) => words.survey_gps.clone(),
        (_, Some(point)) => match best(point) {
            None => words.survey_nobody.clone(),
            Some(reply) => {
                let name = config
                    .contacts
                    .iter()
                    .find(|c| c.key.starts_with(&reply.key) && !c.name.is_empty())
                    .map(|c| c.name.clone())
                    .unwrap_or_else(|| {
                        let id = reply.key.get(..8).unwrap_or(&reply.key);
                        fill(&words.repeater, &[("id", id)])
                    });
                fill(
                    &words.counted(&words.survey_heard, point.replies.len()),
                    &[("name", &name), ("snr", &signed(score(reply)))],
                )
            }
        },
    };
    (title, line)
}

/// How well a repeater and the radio hear each other: the worse of the two ways.
fn score(reply: &Reply) -> f64 {
    reply.us.min(reply.them)
}

/// The answer that makes the point: the repeater that both hears us and is heard best.
fn best(point: &Point) -> Option<&Reply> {
    point.replies.iter().reduce(|best, reply| {
        if score(reply) > score(best) {
            reply
        } else {
            best
        }
    })
}

/// A signal-to-noise ratio as the page writes it (`formatSnr`): its sign, and no second zero.
fn signed(snr: f64) -> String {
    let text = format!("{:.2}", snr.abs());
    let text = text.strip_suffix('0').unwrap_or(&text);
    let sign = if snr > 0.0 {
        "+"
    } else if snr < 0.0 {
        "−"
    } else {
        ""
    };
    format!("{sign}{text}")
}

enum Step {
    Gps,
    Wait,
    Still,
    Ping,
}

/// What the survey does now: wait for a good fix, wait out the half minute, wait for the
/// phone to move, or ask. The first ask goes as soon as the fix is good.
fn step(now: i64, fix: &Fix, last_ping_at: Option<i64>, last: Option<&Point>) -> Step {
    if fix.accuracy > FIX_M || now - fix.at > FIX_AGE_MS {
        return Step::Gps;
    }
    if last_ping_at.is_some_and(|at| now - at < PING_EVERY_MS) {
        return Step::Wait;
    }
    if last.is_some_and(|p| distance_m(p.lat, p.lon, fix.lat, fix.lon) < MOVE_M) {
        return Step::Still;
    }
    Step::Ping
}

/// Metres between two places, along the great circle, as the page's `distanceKm` counts them.
fn distance_m(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    const EARTH_M: f64 = 6_371_008.8;
    let d_lat = (lat2 - lat1).to_radians();
    let d_lon = (lon2 - lon1).to_radians();
    let a = (d_lat / 2.0).sin().powi(2)
        + lat1.to_radians().cos() * lat2.to_radians().cos() * (d_lon / 2.0).sin().powi(2);
    2.0 * EARTH_M * a.sqrt().min(1.0).asin()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Client, Core};
    use serde_json::Value;

    const NO_MORE: &[u8] = &[10];
    const OK: &[u8] = &[0];
    /// Omsk, and a place about 70 m north of it.
    const HERE: (f64, f64) = (54.9893, 73.3682);
    const THERE: (f64, f64) = (54.98993, 73.3682);

    /// A core with a radio and a page, and what it did split out.
    struct Rig {
        core: Core,
        radio: Vec<Vec<u8>>,
        page: Vec<Vec<u8>>,
        listens: Vec<Timer>,
        changes: usize,
    }

    impl Rig {
        /// The radio up, its queue read, and a survey started at time 0.
        fn new() -> Self {
            let mut rig = Rig {
                core: Core::new(Vec::new()),
                radio: vec![],
                page: vec![],
                listens: vec![],
                changes: 0,
            };
            let effects = rig.core.attach(Client::Page);
            rig.run(effects);
            let effects = rig.core.radio_up();
            rig.run(effects);
            rig.radio_says(NO_MORE);
            rig.start(r#"{"id":"s1","radio":"ab12","startedAt":5}"#);
            rig.radio.clear();
            rig
        }

        fn run(&mut self, effects: Vec<Effect>) {
            for effect in effects {
                match effect {
                    Effect::ToRadio { frame } => self.radio.push(frame),
                    Effect::ToClient {
                        client: Client::Page,
                        frame,
                    } => self.page.push(frame),
                    Effect::Wait {
                        timer: timer @ Timer::Listen { .. },
                        millis,
                    } => {
                        assert_eq!(millis, LISTEN_MS);
                        self.listens.push(timer);
                    }
                    Effect::SurveyChanged => self.changes += 1,
                    _ => {}
                }
            }
        }

        fn start(&mut self, json: &str) {
            let effects = self.core.survey_start(json.into(), 0);
            self.run(effects);
        }

        fn radio_says(&mut self, frame: &[u8]) {
            let effects = self.core.from_radio(frame.to_vec());
            self.run(effects);
        }

        /// A sharp fix at `place`, taken at `now`.
        fn fix(&mut self, place: (f64, f64), now: i64) {
            self.fix_of(place, 8.0, now, now);
        }

        fn fix_of(&mut self, place: (f64, f64), accuracy: f64, at: i64, now: i64) {
            let effects = self.core.survey_fix(place.0, place.1, accuracy, at, now);
            self.run(effects);
        }

        /// The tag of the ask on the radio last.
        fn tag(&self) -> [u8; 4] {
            let ask = self.radio.last().expect("an ask went to the radio");
            assert!(is_discover_ask(ask), "the last frame is an ask");
            ask[3..7].try_into().unwrap()
        }

        /// A repeater whose key starts with `key` answers the ask with `tag`.
        fn answer(&mut self, tag: [u8; 4], key: u8, heard_us: i8, snr: i8) {
            let mut frame = vec![PUSH_CONTROL_DATA, snr as u8, (-90i8) as u8, 0];
            frame.extend([0x92, heard_us as u8]);
            frame.extend(tag);
            frame.extend([key; 32]);
            self.radio_says(&frame);
        }

        /// The listening runs out.
        fn listened(&mut self) {
            for timer in std::mem::take(&mut self.listens) {
                let effects = self.core.timeout(timer);
                self.run(effects);
            }
        }

        /// An ask from `place` at `now`, taken by the radio and listened out with no answer.
        fn point(&mut self, place: (f64, f64), now: i64) {
            let before = self.radio.len();
            self.fix(place, now);
            assert_eq!(self.radio.len(), before + 1, "an ask went out at {now}");
            self.radio_says(OK);
            self.listened();
        }

        fn status(&self, full: bool) -> Value {
            serde_json::from_str(&self.core.survey(full).expect("a survey runs")).unwrap()
        }

        fn phase(&self) -> String {
            self.status(false)["phase"].as_str().unwrap().to_string()
        }
    }

    #[test]
    fn the_first_ask_goes_with_the_first_good_fix() {
        let mut rig = Rig::new();
        assert_eq!(rig.phase(), "gps");
        rig.fix_of(HERE, 80.0, 1000, 1000);
        assert!(rig.radio.is_empty(), "a vague fix is waited out");
        rig.fix_of(HERE, 8.0, 1000, 30_000);
        assert!(rig.radio.is_empty(), "and one that is old");
        assert_eq!(rig.phase(), "gps");
        rig.fix(HERE, 31_000);
        assert_eq!(rig.radio.len(), 1);
        assert!(is_discover_ask(&rig.radio[0]));
        assert_eq!(rig.phase(), "listening");
        assert_eq!(rig.status(false)["lastPingAt"], 31_000);
        rig.fix(THERE, 32_000);
        assert_eq!(rig.radio.len(), 1, "no second ask while the first is out");
    }

    #[test]
    fn the_answers_make_the_point() {
        let mut rig = Rig::new();
        rig.fix(HERE, 1000);
        let tag = rig.tag();
        rig.radio_says(OK);
        assert!(
            rig.page.is_empty(),
            "the radio's answer to the ask goes to no client"
        );
        assert_eq!(
            rig.listens.len(),
            1,
            "listening starts once the radio took the ask"
        );
        rig.answer(tag, 0xaa, -14, 21);
        rig.answer([9, 9, 9, 9], 0xbb, 40, 40);
        rig.answer(tag, 0xaa, -10, 22);
        rig.answer(tag, 0xcc, 8, 4);
        assert_eq!(rig.page.len(), 4, "the page hears the answers as any push");
        assert_eq!(
            rig.status(false)["count"],
            0,
            "no point until the listening is over"
        );
        rig.listened();
        let status = rig.status(false);
        assert_eq!(status["phase"], "wait");
        assert_eq!(status["count"], 1);
        let point = &status["points"][0];
        assert_eq!(point["at"], 1000);
        assert_eq!(point["lat"], HERE.0);
        assert_eq!(point["accuracy"], 8.0);
        let replies = point["replies"].as_array().unwrap();
        assert_eq!(
            replies.len(),
            2,
            "one answer a repeater, and none to another ask"
        );
        assert_eq!(replies[0]["key"], "aa".repeat(32));
        assert_eq!(replies[0]["us"], -2.5, "its latest answer");
        assert_eq!(replies[0]["them"], 5.5);
        assert_eq!(replies[0]["rssi"], -90);
        assert_eq!(replies[1]["us"], 2.0);
    }

    #[test]
    fn the_next_ask_waits_half_a_minute_and_fifty_metres() {
        let mut rig = Rig::new();
        rig.point(HERE, 1000);
        rig.fix(THERE, 20_000);
        assert_eq!(rig.phase(), "wait");
        rig.fix(HERE, 40_000);
        assert_eq!(rig.phase(), "still");
        assert!(rig.radio.len() == 1, "neither asks");
        rig.fix(THERE, 41_000);
        assert_eq!(rig.radio.len(), 2, "moved and waited: the next ask");
        assert_ne!(
            rig.radio[0][3..7],
            rig.radio[1][3..7],
            "under a tag of its own"
        );
    }

    #[test]
    fn nothing_is_asked_while_the_radio_is_away() {
        let mut rig = Rig::new();
        rig.fix(HERE, 1000);
        rig.radio_says(OK);
        let effects = rig.core.radio_down();
        rig.run(effects);
        assert_eq!(rig.phase(), "offline");
        rig.listened();
        assert_eq!(
            rig.status(false)["count"],
            0,
            "an ask the radio dropped under makes no point"
        );
        rig.fix(THERE, 60_000);
        assert_eq!(rig.radio.len(), 1);
        assert_eq!(rig.phase(), "offline");
        let effects = rig.core.radio_up();
        rig.run(effects);
        rig.radio_says(NO_MORE);
        rig.fix(THERE, 61_000);
        assert!(
            is_discover_ask(rig.radio.last().unwrap()),
            "asked again once it is back"
        );
    }

    #[test]
    fn an_ask_the_radio_refuses_makes_no_point() {
        let mut rig = Rig::new();
        rig.fix(HERE, 1000);
        rig.radio_says(&[1, 2]);
        assert_eq!(rig.phase(), "wait");
        assert!(rig.listens.is_empty());
        rig.fix(HERE, 20_000);
        assert_eq!(
            rig.radio.len(),
            1,
            "the next waits its half minute all the same"
        );
        rig.fix(HERE, 32_000);
        assert_eq!(
            rig.radio.len(),
            2,
            "and goes from the same spot: no point was made there"
        );
    }

    #[test]
    fn the_buttons_asks_count_with_the_surveys() {
        let mut rig = Rig::new();
        rig.start(r#"{"id":"s2","asks":[1000,2000,3000]}"#);
        rig.fix(HERE, 20_000);
        assert_eq!(rig.radio.len(), 1, "the fourth ask in two minutes goes");
        rig.radio_says(OK);
        rig.listened();
        rig.fix(THERE, 60_000);
        assert_eq!(rig.radio.len(), 1, "a fifth would not be answered");
        assert_eq!(rig.phase(), "wait");
        rig.fix(THERE, 121_500);
        assert_eq!(
            rig.radio.len(),
            2,
            "one goes once the first is two minutes old"
        );
        rig.radio_says(OK);
        rig.listened();

        // The page's button, while the survey waits: the survey's next ask lets it finish.
        rig.fix(HERE, 200_000);
        rig.radio_says(OK);
        rig.listened();
        rig.fix(HERE, 229_000);
        let effects = rig.core.from_client(Client::Page, discover_ask(7), None);
        rig.run(effects);
        rig.radio_says(OK);
        assert_eq!(
            rig.page.last().unwrap(),
            OK,
            "the page's ask is answered to the page"
        );
        let asked = rig.radio.len();
        rig.fix(THERE, 231_000);
        assert_eq!(rig.radio.len(), asked, "its answers are still coming");
        rig.fix(THERE, 240_000);
        assert_eq!(rig.radio.len(), asked + 1);
    }

    #[test]
    fn the_page_reads_the_last_point_or_all() {
        let mut rig = Rig::new();
        assert_eq!(rig.status(true)["points"].as_array().unwrap().len(), 0);
        rig.point(HERE, 1000);
        rig.point(THERE, 40_000);
        let last = rig.status(false);
        assert_eq!(last["id"], "s1");
        assert_eq!(last["radio"], "ab12");
        assert_eq!(last["startedAt"], 5);
        assert_eq!(last["count"], 2);
        assert_eq!(last["points"].as_array().unwrap().len(), 1);
        assert_eq!(last["points"][0]["at"], 40_000);
        assert_eq!(rig.status(true)["points"].as_array().unwrap().len(), 2);
        assert!(rig.changes >= 4, "the owner is told of each step");

        rig.start(r#"{"id":"s1"}"#);
        assert_eq!(
            rig.status(false)["count"],
            2,
            "started again under its name, it goes on"
        );
        let effects = rig.core.survey_stop();
        rig.run(effects);
        assert_eq!(rig.core.survey(true), None);
        rig.fix(HERE, 90_000);
        assert_eq!(rig.radio.len(), 2, "stopped, it asks no more");
    }

    #[test]
    fn an_ask_waits_its_turn_behind_a_clients_command() {
        let mut rig = Rig::new();
        let effects = rig.core.from_client(Client::Page, vec![22, 3], None);
        rig.run(effects);
        rig.fix(HERE, 1000);
        assert_eq!(
            rig.radio,
            vec![vec![22, 3]],
            "the page's command is still in flight"
        );
        rig.radio_says(&[13, 9]);
        assert_eq!(rig.page, vec![vec![13, 9]]);
        assert!(
            is_discover_ask(rig.radio.last().unwrap()),
            "then the ask goes"
        );
        assert!(
            rig.listens.is_empty(),
            "and is listened for from when the radio takes it"
        );
        rig.radio_says(OK);
        assert_eq!(rig.listens.len(), 1);
    }

    #[test]
    fn the_notice_says_how_it_goes_in_the_pages_words() {
        let mut rig = Rig::new();
        let said = |rig: &Rig| {
            let status = rig.status(false);
            let text = |key: &str| status[key].as_str().unwrap().to_string();
            (text("title"), text("line"))
        };
        assert_eq!(
            said(&rig),
            ("Survey running · 0 points".into(), "Waiting for GPS".into()),
            "English until the page has said"
        );

        let words = r#"{"surveyTitle":"Идёт замер · {points}",
            "surveyPoints":{"one":"{count} точка","few":"{count} точки","many":"{count} точек","other":"{count} точки"},
            "surveyHeard":{"one":"Слышит {count} · лучший {name} {snr} дБ","other":"Слышат {count} · лучший {name} {snr} дБ"},
            "surveyNobody":"Никто не ответил","surveyStill":"Стоим на месте","surveyGps":"Ждём GPS",
            "surveyListening":"Слушаем ответы…","surveyOffline":"Радио не на связи","repeater":"Репитер {id}",
            "plurals":["many","one","few","few","few","many"]}"#;
        let known = "aa".repeat(32);
        let config = format!(
            r#"{{"contacts":[{{"key":"{known}","name":"PKIO","type":2}}],"words":{words}}}"#
        );
        rig.core.configure(serde_json::from_str(&config).unwrap());
        assert_eq!(
            said(&rig),
            ("Идёт замер · 0 точек".into(), "Ждём GPS".into())
        );

        rig.fix(HERE, 1000);
        assert_eq!(said(&rig).1, "Слушаем ответы…");
        let tag = rig.tag();
        rig.radio_says(OK);
        rig.answer(tag, 0xaa, 50, 46);
        rig.answer(tag, 0xbb, 60, -8);
        rig.listened();
        assert_eq!(
            said(&rig),
            (
                "Идёт замер · 1 точка".into(),
                "Слышат 2 · лучший PKIO +11.5 дБ".into()
            ),
            "the best by the worse of its two ways, by its contact's name"
        );

        rig.fix(HERE, 40_000);
        assert_eq!(said(&rig).1, "Стоим на месте");
        rig.fix(THERE, 41_000);
        let tag = rig.tag();
        rig.radio_says(OK);
        assert_eq!(
            said(&rig).1,
            "Слышат 2 · лучший PKIO +11.5 дБ",
            "the last point stands while the next is listened for"
        );
        rig.answer(tag, 0xcc, -14, 4);
        rig.listened();
        assert_eq!(
            said(&rig),
            (
                "Идёт замер · 2 точки".into(),
                "Слышит 1 · лучший Репитер cccccccc −3.5 дБ".into()
            ),
            "a repeater that is no contact goes by the start of its key"
        );

        rig.point(HERE, 80_000);
        assert_eq!(said(&rig).1, "Никто не ответил");
        let effects = rig.core.radio_down();
        rig.run(effects);
        assert_eq!(
            said(&rig),
            ("Идёт замер · 3 точки".into(), "Радио не на связи".into())
        );
    }

    #[test]
    fn a_bad_start_is_said_and_starts_nothing() {
        let mut core = Core::new(Vec::new());
        let effects = core.survey_start("{".into(), 0);
        assert!(matches!(effects.as_slice(), [Effect::Log { .. }]));
        assert_eq!(core.survey(true), None);
    }

    #[test]
    fn metres_as_the_page_counts_them() {
        let d = distance_m(HERE.0, HERE.1, THERE.0, THERE.1);
        assert!((d - 70.05).abs() < 0.1, "{d}");
    }
}
