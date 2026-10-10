//! One radio, several clients, and the rules that let them share it: the same
//! rules as `RelayMux.java` and `MeshRelayMux.swift`, which this replaces.
//!
//! The firmware answers one command at a time, in order, and its answers do not
//! say which command they belong to. So commands wait in one queue and go to the
//! radio one at a time; every answer goes to whoever sent the command in flight,
//! and the next command goes when the answer is complete. Pushes (codes 0x80 and
//! up) go to every client.
//!
//! The mux reads the radio's message queue itself and keeps a copy of every
//! message for each client in an inbox; a client's "next message" is answered
//! from there. So a message is read off the radio even while no client is awake
//! to ask for it, and each client still gets all of them. A text or a channel
//! datagram (a reaction) the radio took from one client goes to the others as a
//! mirror push, kept in the inbox of a client that is away.

use std::collections::VecDeque;

use crate::codes::*;
use crate::{Client, Effect, Timer};

/// Messages kept per client at most; the oldest go first.
pub const INBOX_LIMIT: usize = 500;

/// What happened inside the mux that the rest of the core wants to know.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Event {
    /// A message read off the radio's queue, now in every inbox.
    Kept(Vec<u8>),
    /// A client took this message from its inbox.
    Taken(Client, Vec<u8>),
    /// A client's command went on the queue for the radio.
    Asked(Vec<u8>),
    /// The radio's answer to a command of the core's own ([`Mux::send_own`]).
    Answered(Vec<u8>),
    /// A command of the core's own got no answer.
    Unanswered,
}

/// Whose command it is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Source {
    Client(Client),
    /// The mux's own reading of the message queue.
    Queue,
    /// The core's own, as a survey's ask: its answer goes to no client.
    Core,
}

#[derive(Clone, Debug)]
struct Command {
    source: Source,
    frame: Vec<u8>,
    /// Told (`Effect::Written`) once the command is written to the radio, or dropped.
    write: Option<i64>,
}

pub(crate) struct Mux {
    attached: [bool; Client::COUNT],
    queue: VecDeque<Command>,
    in_flight: Option<Command>,
    /// Bumped per command sent, so a timer for an answered command does nothing.
    flight: i32,
    radio_ready: bool,
    draining: bool,
    drain_again: bool,
    inboxes: [Vec<Vec<u8>>; Client::COUNT],
    out: Vec<Effect>,
    events: Vec<Event>,
}

// `from_client` and `from_radio` as `RelayMux.java` names them: what came from where.
#[allow(clippy::wrong_self_convention)]
impl Mux {
    pub fn new(saved: Vec<(Client, Vec<Vec<u8>>)>) -> Self {
        let mut inboxes: [Vec<Vec<u8>>; Client::COUNT] = Default::default();
        for (client, frames) in saved {
            inboxes[client.index()] = frames;
        }
        Mux {
            attached: [false; Client::COUNT],
            queue: VecDeque::new(),
            in_flight: None,
            flight: 0,
            radio_ready: false,
            draining: false,
            drain_again: false,
            inboxes,
            out: Vec::new(),
            events: Vec::new(),
        }
    }

    pub fn inbox(&self, client: Client) -> &[Vec<u8>] {
        &self.inboxes[client.index()]
    }

    /// What the mux asks of its owner, and what happened, since the last call.
    pub fn take(&mut self) -> (Vec<Effect>, Vec<Event>) {
        (
            std::mem::take(&mut self.out),
            std::mem::take(&mut self.events),
        )
    }

    fn is_attached(&self, client: Client) -> bool {
        self.attached[client.index()]
    }

    fn tell(&mut self, client: Client, frame: Vec<u8>) {
        self.out.push(Effect::ToClient { client, frame });
    }

    // Clients

    pub fn attach(&mut self, client: Client) {
        self.attached[client.index()] = true;
        // Messages kept while it was away.
        if !self.inbox(client).is_empty() {
            self.tell(client, vec![PUSH_MSG_WAITING]);
        }
    }

    /// Its waiting commands are dropped; one in flight is still answered, to nobody.
    pub fn detach(&mut self, client: Client) {
        self.attached[client.index()] = false;
        let (dropped, kept): (VecDeque<Command>, VecDeque<Command>) =
            std::mem::take(&mut self.queue)
                .into_iter()
                .partition(|c| c.source == Source::Client(client));
        self.queue = kept;
        for command in dropped {
            if let Some(write) = command.write {
                self.out.push(Effect::Written { write });
            }
        }
    }

    /// A frame a client wrote; `write` is told when it reaches the radio, which for
    /// "next message" is at once, from the inbox.
    pub fn from_client(&mut self, client: Client, frame: Vec<u8>, write: Option<i64>) {
        if frame.is_empty() || frame[0] == CMD_SYNC_NEXT_MESSAGE {
            if let Some(write) = write {
                self.out.push(Effect::Written { write });
            }
            if !frame.is_empty() {
                self.answer_from_inbox(client);
            }
            return;
        }
        self.events.push(Event::Asked(frame.clone()));
        self.queue.push_back(Command {
            source: Source::Client(client),
            frame,
            write,
        });
        self.pump();
    }

    /// A command of the core's own, in its turn like a client's; [`Event::Answered`] brings its answer.
    pub fn send_own(&mut self, frame: Vec<u8>) {
        self.queue.push_back(Command {
            source: Source::Core,
            frame,
            write: None,
        });
        self.pump();
    }

    pub fn is_up(&self) -> bool {
        self.radio_ready
    }

    /// Mirrors kept for it go out as pushes first; then the next message is the answer.
    fn answer_from_inbox(&mut self, client: Client) {
        let mut answer = vec![RESP_NO_MORE_MESSAGES];
        let mut pushes = Vec::new();
        let mut changed = false;
        while !self.inboxes[client.index()].is_empty() {
            let frame = self.inboxes[client.index()].remove(0);
            changed = true;
            if frame[0] == PUSH_MIRROR {
                pushes.push(frame);
            } else {
                self.events.push(Event::Taken(client, frame.clone()));
                answer = frame;
                break;
            }
        }
        if changed {
            self.out.push(Effect::InboxesChanged);
        }
        for push in pushes {
            self.tell(client, push);
        }
        self.tell(client, answer);
    }

    // The radio

    pub fn radio_up(&mut self) {
        self.radio_ready = true;
        // Whatever arrived while nobody read the queue.
        self.drain();
        self.pump();
    }

    /// A command in flight is lost with the link; its sender times out on its own.
    /// The core's own do not wait for the radio's return: what they asked is stale by then.
    pub fn radio_down(&mut self) {
        self.radio_ready = false;
        if self
            .in_flight
            .as_ref()
            .is_some_and(|c| c.source == Source::Queue)
        {
            self.draining = false;
        }
        self.queue.retain(|c| c.source != Source::Core);
        self.in_flight = None;
        self.flight = self.flight.wrapping_add(1);
    }

    pub fn from_radio(&mut self, frame: &[u8]) {
        let Some(&code) = frame.first() else { return };
        if is_push(code) {
            if code == PUSH_MSG_WAITING {
                self.drain();
            } else {
                for client in Client::ALL {
                    if self.is_attached(client) {
                        self.tell(client, frame.to_vec());
                    }
                }
            }
            return;
        }
        // Late, for a command given up on.
        let Some(command) = self.in_flight.clone() else {
            return;
        };
        match command.source {
            Source::Queue => {
                if is_message(code) {
                    self.keep(frame);
                    self.queue.push_back(Command {
                        source: Source::Queue,
                        frame: vec![CMD_SYNC_NEXT_MESSAGE],
                        write: None,
                    });
                } else {
                    self.draining = false;
                    if self.drain_again {
                        self.drain_again = false;
                        self.drain();
                    }
                }
            }
            Source::Client(source) => {
                if self.is_attached(source) {
                    self.tell(source, frame.to_vec());
                }
                self.mirror(&command.frame, frame, source);
            }
            Source::Core => self.events.push(Event::Answered(frame.to_vec())),
        }
        if is_complete(&command.frame, code) {
            self.finish();
        } else {
            self.arm(&command); // a stream: each frame restarts the wait
        }
    }

    /// A timer the mux asked for is due.
    pub fn timeout(&mut self, flight: i32) {
        if flight != self.flight {
            return;
        }
        let Some(command) = &self.in_flight else {
            return;
        };
        match command.source {
            Source::Queue => self.draining = false,
            Source::Core => self.events.push(Event::Unanswered),
            Source::Client(_) => {}
        }
        let (_, silent) = patience(&command.frame);
        if !silent {
            self.out.push(Effect::Log {
                line: format!("command {} got no answer", command.frame[0]),
            });
        }
        self.finish();
    }

    // The queue

    fn drain(&mut self) {
        if self.draining {
            self.drain_again = true;
            return;
        }
        self.draining = true;
        self.queue.push_back(Command {
            source: Source::Queue,
            frame: vec![CMD_SYNC_NEXT_MESSAGE],
            write: None,
        });
        self.pump();
    }

    fn keep(&mut self, message: &[u8]) {
        for client in Client::ALL {
            self.add(message.to_vec(), client);
            if self.is_attached(client) {
                self.tell(client, vec![PUSH_MSG_WAITING]);
            }
        }
        self.events.push(Event::Kept(message.to_vec()));
        self.out.push(Effect::InboxesChanged);
    }

    /// A text or a channel datagram the radio took from one client, told to the others.
    fn mirror(&mut self, command: &[u8], answer: &[u8], sender: Client) {
        let taken = match command[0] {
            CMD_SEND_TXT_MSG => answer[0] == RESP_SENT,
            CMD_SEND_CHANNEL_TXT_MSG | CMD_SEND_CHANNEL_DATA => answer[0] == RESP_OK,
            _ => false,
        };
        if !taken || command.len() >= 256 {
            return;
        }
        let frame = [&[PUSH_MIRROR, command.len() as u8][..], command, answer].concat();
        let mut kept = false;
        for client in Client::ALL {
            if client == sender {
                continue;
            }
            if self.is_attached(client) {
                self.tell(client, frame.clone());
            } else {
                self.add(frame.clone(), client);
                kept = true;
            }
        }
        if kept {
            self.out.push(Effect::InboxesChanged);
        }
    }

    fn add(&mut self, frame: Vec<u8>, client: Client) {
        let inbox = &mut self.inboxes[client.index()];
        inbox.push(frame);
        if inbox.len() > INBOX_LIMIT {
            let excess = inbox.len() - INBOX_LIMIT;
            inbox.drain(..excess);
        }
    }

    fn pump(&mut self) {
        if !self.radio_ready || self.in_flight.is_some() {
            return;
        }
        let Some(command) = self.queue.pop_front() else {
            return;
        };
        self.out.push(Effect::ToRadio {
            frame: command.frame.clone(),
        });
        if let Some(write) = command.write {
            self.out.push(Effect::Written { write });
        }
        self.arm(&command);
        self.in_flight = Some(command);
    }

    fn finish(&mut self) {
        self.in_flight = None;
        self.flight = self.flight.wrapping_add(1);
        self.pump();
    }

    fn arm(&mut self, command: &Command) {
        self.flight = self.flight.wrapping_add(1);
        let (millis, _) = patience(&command.frame);
        self.out.push(Effect::Wait {
            timer: Timer::Command {
                flight: self.flight,
            },
            millis,
        });
    }
}

/// How long a command may wait for its answer (ms), and whether the radio answers it at all.
pub fn patience(frame: &[u8]) -> (i64, bool) {
    match frame.first() {
        Some(&CMD_REBOOT) => (1500, true),
        Some(&CMD_FACTORY_RESET) => (3000, true),
        // About this radio (no key after the code and three zeros): only a push answers it.
        Some(&CMD_SEND_TELEMETRY_REQ) if frame.len() <= 4 => (300, true),
        Some(&CMD_GET_CONTACTS) => (20000, false),
        // Some firmware writes its whole contacts file to flash before it answers these; an
        // answer after the wait would go to the next command (#78). The page waits as long.
        Some(&CMD_ADD_UPDATE_CONTACT | &CMD_RESET_PATH | &CMD_REMOVE_CONTACT) => (30000, false),
        _ => (8000, false),
    }
}

/// Whether `answer` is a command's last frame: an error always is, and so is any
/// single answer; only the contact list comes as a stream.
pub fn is_complete(command: &[u8], answer: u8) -> bool {
    if answer == RESP_ERR {
        return true;
    }
    if command[0] == CMD_GET_CONTACTS {
        return answer == RESP_END_OF_CONTACTS;
    }
    true
}

/// The same checks as `RelayMuxCheck.java` and the iOS app's `tests/relay-mux/main.swift`.
#[cfg(test)]
mod tests {
    use super::*;
    use Client::{Computer, Page};

    const SYNC: &[u8] = &[10];
    const NO_MORE: &[u8] = &[10];
    const OK: &[u8] = &[0];
    const MESSAGE: &[u8] = &[16, 1, 2, 3];

    /// A mux with what it did split out, and its timers run by hand.
    struct Rig {
        mux: Mux,
        radio: Vec<Vec<u8>>,
        page: Vec<Vec<u8>>,
        computer: Vec<Vec<u8>>,
        written: Vec<i64>,
        timers: Vec<i32>,
    }

    impl Rig {
        fn new() -> Self {
            Rig::with(Vec::new())
        }

        fn with(saved: Vec<(Client, Vec<Vec<u8>>)>) -> Self {
            Rig {
                mux: Mux::new(saved),
                radio: vec![],
                page: vec![],
                computer: vec![],
                written: vec![],
                timers: vec![],
            }
        }

        /// Moves what the mux did into the lists.
        fn run(&mut self) -> &mut Self {
            let (effects, _) = self.mux.take();
            for effect in effects {
                match effect {
                    Effect::ToRadio { frame } => self.radio.push(frame),
                    Effect::ToClient {
                        client: Page,
                        frame,
                    } => self.page.push(frame),
                    Effect::ToClient {
                        client: Computer,
                        frame,
                    } => self.computer.push(frame),
                    Effect::Written { write } => self.written.push(write),
                    Effect::Wait {
                        timer: Timer::Command { flight },
                        ..
                    } => self.timers.push(flight),
                    _ => {}
                }
            }
            self
        }

        fn attach(&mut self, c: Client) -> &mut Self {
            self.mux.attach(c);
            self.run()
        }

        fn up(&mut self) -> &mut Self {
            self.mux.radio_up();
            self.run()
        }

        fn radio_says(&mut self, frame: &[u8]) -> &mut Self {
            self.mux.from_radio(frame);
            self.run()
        }

        fn client_says(&mut self, c: Client, frame: &[u8]) -> &mut Self {
            self.mux.from_client(c, frame.to_vec(), None);
            self.run()
        }

        /// Fires every timer set so far.
        fn timeout(&mut self) -> &mut Self {
            for flight in std::mem::take(&mut self.timers) {
                self.mux.timeout(flight);
            }
            self.run()
        }

        fn clear(&mut self) -> &mut Self {
            self.radio.clear();
            self.page.clear();
            self.computer.clear();
            self
        }
    }

    fn v(frames: &[&[u8]]) -> Vec<Vec<u8>> {
        frames.iter().map(|f| f.to_vec()).collect()
    }

    #[test]
    fn up_with_an_empty_queue_reads_it_once_and_forwards_nothing() {
        let mut rig = Rig::new();
        rig.attach(Page).up();
        assert_eq!(rig.radio, v(&[SYNC]), "reads the radio's queue on start");
        rig.radio_says(NO_MORE);
        assert!(rig.page.is_empty(), "the relay's own answer goes to nobody");
    }

    #[test]
    fn commands_go_one_at_a_time_and_each_answer_to_its_sender() {
        let mut rig = Rig::new();
        rig.attach(Page)
            .attach(Computer)
            .up()
            .radio_says(NO_MORE)
            .clear();
        rig.client_says(Page, &[22, 3]).client_says(Computer, &[5]);
        assert_eq!(rig.radio, v(&[&[22, 3]]), "only the first command goes out");
        rig.radio_says(&[13, 9]);
        assert_eq!(rig.page, v(&[&[13, 9]]), "the answer goes to the page");
        assert!(rig.computer.is_empty(), "not to the computer");
        assert_eq!(
            rig.radio,
            v(&[&[22, 3], &[5]]),
            "then the computer's command goes out"
        );
        rig.radio_says(&[9, 1, 2, 3, 4]);
        assert_eq!(
            rig.computer,
            v(&[&[9, 1, 2, 3, 4]]),
            "its answer goes to the computer"
        );
    }

    #[test]
    fn the_contact_list_is_a_stream() {
        let mut rig = Rig::new();
        rig.attach(Page)
            .attach(Computer)
            .up()
            .radio_says(NO_MORE)
            .clear();
        rig.client_says(Computer, &[4]).client_says(Page, &[20]);
        rig.radio_says(&[2, 2, 0, 0, 0]).radio_says(&[3, 0xaa]);
        assert_eq!(rig.radio, v(&[&[4]]), "waits while contacts arrive");
        rig.radio_says(&[3, 0xbb]).radio_says(&[4, 0, 0, 0, 0]);
        assert_eq!(rig.computer.len(), 4, "the computer gets the whole stream");
        assert_eq!(
            rig.radio,
            v(&[&[4], &[20]]),
            "the page's command goes after the end"
        );
    }

    #[test]
    fn an_error_ends_a_stream_too() {
        let mut rig = Rig::new();
        rig.attach(Computer).up().radio_says(NO_MORE).clear();
        rig.client_says(Computer, &[4])
            .client_says(Computer, &[5])
            .radio_says(&[1, 2]);
        assert_eq!(rig.radio, v(&[&[4], &[5]]), "an error is a whole answer");
    }

    #[test]
    fn pushes_go_to_both_and_message_waiting_to_neither() {
        let mut rig = Rig::new();
        rig.attach(Page)
            .attach(Computer)
            .up()
            .radio_says(NO_MORE)
            .clear();
        rig.radio_says(&[0x82, 1, 2, 3, 4]);
        assert_eq!(
            rig.page,
            v(&[&[0x82, 1, 2, 3, 4]]),
            "a push reaches the page"
        );
        assert_eq!(rig.computer, v(&[&[0x82, 1, 2, 3, 4]]), "and the computer");
        rig.radio_says(&[0x83]);
        assert_eq!(
            rig.radio,
            v(&[SYNC]),
            "message waiting makes the relay read the queue"
        );
        assert!(
            !rig.page.contains(&vec![0x83]),
            "and is not passed on as it is"
        );
    }

    #[test]
    fn a_message_lands_in_both_inboxes_and_each_reads_its_own_copy() {
        let mut rig = Rig::new();
        rig.attach(Page).attach(Computer).up().radio_says(MESSAGE);
        assert_eq!(rig.page, v(&[&[0x83]]), "the page is told a message waits");
        assert_eq!(rig.computer, v(&[&[0x83]]), "and so is the computer");
        assert_eq!(rig.radio, v(&[SYNC, SYNC]), "the relay reads on");
        rig.radio_says(NO_MORE).clear();
        rig.client_says(Page, SYNC);
        assert_eq!(rig.page, v(&[MESSAGE]), "the page reads its copy");
        rig.client_says(Page, SYNC);
        assert_eq!(rig.page, v(&[MESSAGE, NO_MORE]), "then nothing more");
        rig.client_says(Computer, SYNC);
        assert_eq!(
            rig.computer,
            v(&[MESSAGE]),
            "the computer still has its copy"
        );
        assert!(rig.radio.is_empty(), "none of that asks the radio");
    }

    #[test]
    fn a_client_away_keeps_its_copies_and_is_told_when_it_comes_back() {
        let mut rig = Rig::new();
        rig.attach(Page)
            .up()
            .radio_says(MESSAGE)
            .radio_says(NO_MORE);
        assert!(
            rig.computer.is_empty(),
            "an absent computer is told nothing"
        );
        rig.attach(Computer);
        assert_eq!(rig.computer, v(&[&[0x83]]), "and is told when it attaches");
        let saved = Client::ALL
            .iter()
            .map(|&c| (c, rig.mux.inbox(c).to_vec()))
            .collect();
        let mut again = Rig::with(saved);
        again.attach(Computer);
        assert_eq!(
            again.computer,
            v(&[&[0x83]]),
            "the inboxes survive a restart"
        );
    }

    #[test]
    fn message_waiting_during_a_read_makes_one_more_pass() {
        let mut rig = Rig::new();
        rig.up().radio_says(&[0x83]).radio_says(NO_MORE);
        assert_eq!(
            rig.radio,
            v(&[SYNC, SYNC]),
            "reads again after a push mid-read"
        );
        rig.radio_says(NO_MORE);
        assert_eq!(rig.radio.len(), 2, "and then stops");
    }

    #[test]
    fn a_command_never_answered_is_given_up_on() {
        let mut rig = Rig::new();
        rig.attach(Page).up().radio_says(NO_MORE).clear();
        rig.timers.clear();
        rig.client_says(Page, &[19]).client_says(Page, &[5]);
        assert!(patience(&[19]).0 < 2000, "a reboot is not waited on long");
        rig.timeout();
        assert_eq!(
            rig.radio,
            v(&[&[19], &[5]]),
            "the next command goes after the timeout"
        );
        rig.radio_says(&[9, 0, 0, 0, 0]);
        assert_eq!(rig.page, v(&[&[9, 0, 0, 0, 0]]), "and gets its answer");
    }

    #[test]
    fn a_stale_timer_does_nothing_to_the_next_command() {
        let mut rig = Rig::new();
        rig.attach(Page).up().radio_says(NO_MORE);
        rig.timers.clear();
        rig.clear();
        rig.client_says(Page, &[5]).radio_says(&[9, 0, 0, 0, 0]);
        rig.client_says(Page, &[20]).client_says(Page, &[22]);
        let first = rig.timers.remove(0);
        rig.mux.timeout(first);
        rig.run();
        assert_eq!(
            rig.radio,
            v(&[&[5], &[20]]),
            "the old command's timer leaves the new one waiting"
        );
    }

    #[test]
    fn commands_wait_while_the_radio_is_down() {
        let mut rig = Rig::new();
        rig.attach(Computer);
        rig.mux.from_client(Computer, vec![5], Some(7));
        rig.run();
        assert!(
            rig.radio.is_empty() && rig.written.is_empty(),
            "nothing goes before the radio is up"
        );
        rig.up();
        assert_eq!(rig.radio, v(&[&[5]]), "the command goes once it is up");
        assert_eq!(rig.written, vec![7], "and its sender hears it went");
        rig.radio_says(&[9, 0, 0, 0, 0]);
        assert_eq!(
            rig.radio,
            v(&[&[5], SYNC]),
            "then the relay reads the queue"
        );
        rig.radio_says(NO_MORE).client_says(Computer, &[20]).clear();
        rig.mux.radio_down();
        rig.radio_says(&[9, 0, 0, 0, 0]);
        assert!(
            rig.computer.is_empty(),
            "an answer after the drop belongs to nothing"
        );
    }

    #[test]
    fn a_detached_clients_waiting_commands_are_dropped() {
        let mut rig = Rig::new();
        rig.attach(Page)
            .attach(Computer)
            .up()
            .radio_says(NO_MORE)
            .clear();
        rig.client_says(Page, &[5])
            .client_says(Computer, &[20])
            .client_says(Page, &[22]);
        rig.mux.detach(Computer);
        rig.run().radio_says(&[9, 0, 0, 0, 0]);
        assert_eq!(
            rig.radio,
            v(&[&[5], &[22]]),
            "the computer's command never goes"
        );
    }

    #[test]
    fn a_text_one_sends_is_told_to_the_other() {
        let mut rig = Rig::new();
        rig.attach(Page)
            .attach(Computer)
            .up()
            .radio_says(NO_MORE)
            .clear();
        let dm: &[u8] = &[2, 0, 0, 1, 2, 3, 4, 9, 9, 9, 9, 9, 9, 104, 105];
        let sent: &[u8] = &[6, 0, 7, 7, 7, 7, 0xd0, 7, 0, 0];
        rig.client_says(Page, dm).radio_says(sent);
        assert_eq!(rig.page, v(&[sent]), "the sender gets the answer");
        assert_eq!(
            rig.computer,
            vec![[&[0xf0, dm.len() as u8][..], dm, sent].concat()],
            "the other gets the command and the answer"
        );
        rig.clear();
        let channel: &[u8] = &[3, 0, 1, 1, 2, 3, 4, 104, 105];
        rig.client_says(Computer, channel).radio_says(OK);
        assert_eq!(
            rig.page.first().map(|f| f[0]),
            Some(0xf0),
            "a channel text too, on OK"
        );
        rig.clear();
        let reaction: &[u8] = &[62, 0, 0xff, 0x0e, 0xff, 2, 1, 2, 3, 4, 5];
        rig.client_says(Computer, reaction).radio_says(OK);
        assert_eq!(
            rig.page,
            vec![[&[0xf0, reaction.len() as u8][..], reaction, OK].concat()],
            "and a channel datagram, which is how a reaction goes"
        );
        rig.clear();
        rig.client_says(Computer, channel).radio_says(&[1, 2]);
        assert!(rig.page.is_empty(), "not one the radio refused");
        rig.client_says(Computer, &[5]).radio_says(&[9, 0, 0, 0, 0]);
        assert!(rig.page.is_empty(), "nor any other command");
    }

    #[test]
    fn a_mirror_for_a_client_away_goes_ahead_of_its_next_message() {
        let mut rig = Rig::new();
        rig.attach(Page).up().radio_says(NO_MORE);
        rig.client_says(Page, &[3, 0, 0, 1, 2, 3, 4, 104])
            .radio_says(OK);
        rig.radio_says(&[0x83])
            .radio_says(MESSAGE)
            .radio_says(NO_MORE);
        rig.attach(Computer);
        assert_eq!(
            rig.computer,
            v(&[&[0x83]]),
            "the computer is told something waits"
        );
        rig.client_says(Computer, SYNC);
        assert_eq!(rig.computer.len(), 3);
        assert_eq!(rig.computer[1][0], 0xf0, "the mirror as a push");
        assert_eq!(rig.computer[2], MESSAGE, "then the message");
        rig.client_says(Computer, SYNC);
        assert_eq!(rig.computer.last().unwrap(), NO_MORE, "then nothing more");
    }

    #[test]
    fn only_mirrors_waiting_are_pushed_then_no_more() {
        let mut rig = Rig::new();
        rig.attach(Page).up().radio_says(NO_MORE);
        rig.client_says(Page, &[3, 0, 0, 1, 2, 3, 4, 104])
            .radio_says(OK);
        rig.attach(Computer).clear();
        rig.client_says(Computer, SYNC);
        assert_eq!(rig.computer.len(), 2);
        assert_eq!(rig.computer[0][0], 0xf0, "a mirror");
        assert_eq!(rig.computer[1], NO_MORE, "then no more");
    }

    #[test]
    fn a_command_that_saves_contacts_is_waited_on_longer() {
        for code in [9, 13, 15] {
            assert!(
                patience(&[code]).0 >= 30000,
                "command {code} rewrites the contacts file"
            );
        }
        assert_eq!(patience(&[27]).0, 8000, "a status request does not");
    }

    #[test]
    fn self_telemetry_is_answered_by_a_push_only() {
        assert!(
            patience(&[39, 0, 0, 0]).1,
            "self telemetry expects no answer"
        );
        assert!(
            !patience(&[39, 0, 0, 0, 1, 2, 3, 4, 5, 6]).1,
            "a contact's does"
        );
    }

    #[test]
    fn the_inbox_keeps_the_newest() {
        let mut rig = Rig::new();
        rig.up();
        for i in 0..(INBOX_LIMIT + 2) {
            rig.radio_says(&[16, (i % 256) as u8, (i / 256) as u8]);
        }
        assert_eq!(rig.mux.inbox(Page).len(), INBOX_LIMIT);
        assert_eq!(
            rig.mux.inbox(Page)[0],
            vec![16, 2, 0],
            "the oldest went first"
        );
    }
}
