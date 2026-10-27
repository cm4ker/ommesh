//! The inboxes as the phone keeps them on disk, so they outlive the app: a
//! snapshot written now and then, and a log of what changed since it, appended
//! to. Saved whole on every change, thousands of messages would be rewritten for
//! each one that came; logged, a message costs its own bytes, and the snapshot
//! is written again only once the log has grown as big as it.
//!
//! The owner keeps two files and does what each effect says:
//! [`Effect::InboxLog`] appends to the log, [`Effect::InboxSnapshot`] puts the
//! snapshot in place of the old one and then empties the log. At start it hands
//! both back to [`crate::Core::restore`].
//!
//! Every record of the log carries the generation of the snapshot it follows,
//! so a log left from before the newest snapshot, by an app stopped between the
//! two writes, is passed over. A log cut short, by an app stopped in the middle
//! of a write, is read up to the cut.

use crate::{Client, Effect, Inbox};

const MAGIC: &[u8; 4] = b"MCI1";
/// A record that adds a frame at the end of a client's inbox.
const APPEND: u8 = 1;
/// A record that takes frames out of a client's inbox.
const REMOVE: u8 = 2;
/// The log grows to this much at least before a snapshot is written in its place.
const LOG_FLOOR: usize = 64 * 1024;

pub(crate) struct Store {
    /// The inboxes as the files hold them, snapshot and log together.
    disk: [Vec<Vec<u8>>; Client::COUNT],
    generation: u32,
    /// The bytes of the log since the snapshot.
    logged: usize,
    /// Whether the next save writes a snapshot in any case: none of this kind is on disk yet.
    fresh: bool,
}

impl Store {
    /// For inboxes kept another way, saved before this or not at all: the first save writes a snapshot.
    pub fn new(inboxes: &[Inbox]) -> Store {
        let mut disk: [Vec<Vec<u8>>; Client::COUNT] = Default::default();
        for inbox in inboxes {
            disk[inbox.client.index()] = inbox.frames.clone();
        }
        Store {
            disk,
            generation: 0,
            logged: 0,
            fresh: true,
        }
    }

    /// From the owner's two files. A snapshot that cannot be read counts as none.
    pub fn restore(snapshot: &[u8], log: &[u8]) -> (Store, Vec<Inbox>) {
        let mut store = match read_snapshot(snapshot) {
            Some((generation, disk)) => Store {
                disk,
                generation,
                logged: 0,
                fresh: false,
            },
            None => Store::new(&[]),
        };
        store.replay(log);
        let inboxes = Client::ALL
            .iter()
            .map(|&client| Inbox {
                client,
                frames: store.disk[client.index()].clone(),
            })
            .collect();
        (store, inboxes)
    }

    /// The log's records of this snapshot, up to the first that cannot be read. Records after
    /// one that cannot be read would be lost behind it, so a snapshot comes next.
    fn replay(&mut self, log: &[u8]) {
        let mut r = Reader { bytes: log, at: 0 };
        while r.left() > 0 {
            let start = r.at;
            if !self.apply(&mut r) {
                self.fresh = true;
                return;
            }
            self.logged += r.at - start;
        }
    }

    /// One record, if it can be read; it changes the inboxes only if it is of this snapshot.
    fn apply(&mut self, r: &mut Reader) -> bool {
        let (Some(generation), Some(kind), Some(client)) = (r.u32(), r.u8(), r.u8()) else {
            return false;
        };
        let ours = generation == self.generation && !self.fresh;
        let Some(inbox) = self.disk.get_mut(client as usize) else {
            return false;
        };
        match kind {
            APPEND => {
                let Some(frame) = r.frame() else { return false };
                if ours {
                    inbox.push(frame.to_vec());
                }
            }
            REMOVE => {
                let (Some(at), Some(count)) = (r.u32(), r.u32()) else {
                    return false;
                };
                let range = at as usize..at as usize + count as usize;
                if ours {
                    if range.end > inbox.len() {
                        return false;
                    }
                    inbox.drain(range);
                }
            }
            _ => return false,
        }
        true
    }

    /// What the owner writes for the inboxes as they are now; none when the files hold them already.
    pub fn save(&mut self, now: [Vec<&[u8]>; Client::COUNT]) -> Option<Effect> {
        let mut log = Vec::new();
        for client in Client::ALL {
            let before = log.len();
            self.diff(client, &now[client.index()], &mut log);
            if log.len() > before {
                self.disk[client.index()] =
                    now[client.index()].iter().map(|f| f.to_vec()).collect();
            }
        }
        if log.is_empty() && !self.fresh {
            return None;
        }
        let size: usize = now.iter().flatten().map(|f| f.len() + 2).sum();
        if self.fresh || self.logged + log.len() > size.max(LOG_FLOOR) {
            self.generation = self.generation.wrapping_add(1);
            self.logged = 0;
            self.fresh = false;
            return Some(Effect::InboxSnapshot {
                bytes: self.snapshot(),
            });
        }
        self.logged += log.len();
        Some(Effect::InboxLog { bytes: log })
    }

    /// The records that make one client's inbox on disk the one now. An inbox only ever loses
    /// frames, wherever they are, and gains them at its end: what is on disk is walked along
    /// what is now, a frame that matches is kept, one that does not is taken out, and the
    /// frames past the last match are added.
    fn diff(&self, client: Client, now: &[&[u8]], log: &mut Vec<u8>) {
        let disk = &self.disk[client.index()];
        let mut matched = 0;
        let mut removing: Option<(usize, usize)> = None;
        for frame in disk {
            if matched < now.len() && frame.as_slice() == now[matched] {
                if let Some((at, count)) = removing.take() {
                    self.remove(client, at, count, log);
                }
                matched += 1;
            } else {
                // Taken out, the next frame comes to the same place.
                removing = Some(match removing {
                    Some((at, count)) => (at, count + 1),
                    None => (matched, 1),
                });
            }
        }
        if let Some((at, count)) = removing {
            self.remove(client, at, count, log);
        }
        for frame in &now[matched..] {
            self.record(client, APPEND, log);
            log.extend_from_slice(&(frame.len() as u16).to_le_bytes());
            log.extend_from_slice(frame);
        }
    }

    fn remove(&self, client: Client, at: usize, count: usize, log: &mut Vec<u8>) {
        self.record(client, REMOVE, log);
        log.extend_from_slice(&(at as u32).to_le_bytes());
        log.extend_from_slice(&(count as u32).to_le_bytes());
    }

    fn record(&self, client: Client, kind: u8, log: &mut Vec<u8>) {
        log.extend_from_slice(&self.generation.to_le_bytes());
        log.push(kind);
        log.push(client.index() as u8);
    }

    fn snapshot(&self) -> Vec<u8> {
        let mut bytes = MAGIC.to_vec();
        bytes.extend_from_slice(&self.generation.to_le_bytes());
        for client in Client::ALL {
            let frames = &self.disk[client.index()];
            bytes.push(client.index() as u8);
            bytes.extend_from_slice(&(frames.len() as u32).to_le_bytes());
            for frame in frames {
                bytes.extend_from_slice(&(frame.len() as u16).to_le_bytes());
                bytes.extend_from_slice(frame);
            }
        }
        bytes
    }
}

/// A snapshot's generation and inboxes; none for one that is missing, of another kind or cut short.
fn read_snapshot(bytes: &[u8]) -> Option<(u32, [Vec<Vec<u8>>; Client::COUNT])> {
    let mut r = Reader { bytes, at: 0 };
    if r.take(MAGIC.len())? != MAGIC {
        return None;
    }
    let generation = r.u32()?;
    let mut disk: [Vec<Vec<u8>>; Client::COUNT] = Default::default();
    for _ in Client::ALL {
        let client = r.u8()? as usize;
        let count = r.u32()?;
        let inbox = disk.get_mut(client)?;
        for _ in 0..count {
            inbox.push(r.frame()?.to_vec());
        }
    }
    Some((generation, disk))
}

struct Reader<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl<'a> Reader<'a> {
    fn left(&self) -> usize {
        self.bytes.len() - self.at
    }

    fn take(&mut self, n: usize) -> Option<&'a [u8]> {
        let taken = self.bytes.get(self.at..self.at + n)?;
        self.at += n;
        Some(taken)
    }

    fn u8(&mut self) -> Option<u8> {
        Some(self.take(1)?[0])
    }

    fn u32(&mut self) -> Option<u32> {
        Some(u32::from_le_bytes(self.take(4)?.try_into().ok()?))
    }

    /// A frame after its length, two bytes.
    fn frame(&mut self) -> Option<&'a [u8]> {
        let len = u16::from_le_bytes(self.take(2)?.try_into().ok()?);
        self.take(len as usize)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The owner's two files, written as the effects say.
    #[derive(Default)]
    struct Disk {
        snapshot: Vec<u8>,
        log: Vec<u8>,
    }

    impl Disk {
        fn take(&mut self, effect: Option<Effect>) {
            match effect {
                Some(Effect::InboxLog { bytes }) => self.log.extend(bytes),
                Some(Effect::InboxSnapshot { bytes }) => {
                    self.snapshot = bytes;
                    self.log.clear();
                }
                Some(other) => panic!("not a save: {other:?}"),
                None => {}
            }
        }

        fn read(&self) -> Vec<Inbox> {
            Store::restore(&self.snapshot, &self.log).1
        }
    }

    fn frame(n: u16) -> Vec<u8> {
        let mut f = vec![16];
        f.extend_from_slice(&n.to_le_bytes());
        f
    }

    fn now<'a>(page: &'a [Vec<u8>], computer: &'a [Vec<u8>]) -> [Vec<&'a [u8]>; 2] {
        [
            page.iter().map(|f| f.as_slice()).collect(),
            computer.iter().map(|f| f.as_slice()).collect(),
        ]
    }

    fn frames(inboxes: &[Inbox], client: Client) -> Vec<Vec<u8>> {
        inboxes
            .iter()
            .find(|i| i.client == client)
            .unwrap()
            .frames
            .clone()
    }

    #[test]
    fn inboxes_kept_another_way_are_written_whole_at_the_first_save() {
        let page = vec![frame(1), frame(2)];
        let mut store = Store::new(&[Inbox {
            client: Client::Page,
            frames: page.clone(),
        }]);
        let mut disk = Disk::default();
        let effect = store.save(now(&page, &[]));
        assert!(matches!(effect, Some(Effect::InboxSnapshot { .. })));
        disk.take(effect);
        assert_eq!(frames(&disk.read(), Client::Page), page);
        assert_eq!(
            store.save(now(&page, &[])),
            None,
            "nothing new, nothing written"
        );
    }

    #[test]
    fn what_comes_and_goes_is_logged_and_read_back() {
        let mut store = Store::new(&[]);
        let mut disk = Disk::default();
        disk.take(store.save(now(&[], &[])));
        let mut page: Vec<Vec<u8>> = (0..10).map(frame).collect();
        let mut computer = vec![frame(100)];
        let effect = store.save(now(&page, &computer));
        let Some(Effect::InboxLog { ref bytes }) = effect else {
            panic!("{effect:?}")
        };
        assert!(bytes.len() < 200, "only the new frames: {}", bytes.len());
        disk.take(effect);

        // Taken from the front, an entry from the middle, more at the end.
        page.drain(0..3);
        page.remove(4);
        page.extend((10..13).map(frame));
        computer.clear();
        disk.take(store.save(now(&page, &computer)));
        let read = disk.read();
        assert_eq!(frames(&read, Client::Page), page);
        assert_eq!(frames(&read, Client::Computer), Vec::<Vec<u8>>::new());
    }

    #[test]
    fn the_same_frame_twice_is_kept_twice() {
        let mut store = Store::new(&[]);
        let mut disk = Disk::default();
        disk.take(store.save(now(&[], &[])));
        let mut page = vec![frame(1), frame(1), frame(2)];
        disk.take(store.save(now(&page, &[])));
        page.remove(1);
        page.push(frame(1));
        disk.take(store.save(now(&page, &[])));
        assert_eq!(frames(&disk.read(), Client::Page), page);
    }

    #[test]
    fn a_long_log_gives_way_to_a_snapshot() {
        let mut store = Store::new(&[]);
        let mut disk = Disk::default();
        disk.take(store.save(now(&[], &[])));
        let mut page = Vec::new();
        let mut snapshots = 0;
        for n in 0..20_000u16 {
            page.push(frame(n));
            if page.len() > 50 {
                page.remove(0);
            }
            let effect = store.save(now(&page, &[]));
            if matches!(effect, Some(Effect::InboxSnapshot { .. })) {
                snapshots += 1;
            }
            disk.take(effect);
        }
        assert!(snapshots > 0);
        assert!(disk.log.len() <= LOG_FLOOR + 64);
        assert_eq!(frames(&disk.read(), Client::Page), page);
    }

    #[test]
    fn a_log_from_before_the_snapshot_is_passed_over() {
        let mut store = Store::new(&[]);
        let mut disk = Disk::default();
        disk.take(store.save(now(&[], &[])));
        let page = vec![frame(1)];
        disk.take(store.save(now(&page, &[])));
        let old_log = disk.log.clone();
        // A snapshot written, and the app stopped before it emptied the log.
        store.fresh = true;
        disk.take(store.save(now(&page, &[])));
        disk.log = old_log;
        assert_eq!(frames(&disk.read(), Client::Page), page);
    }

    #[test]
    fn a_log_cut_short_is_read_up_to_the_cut() {
        let mut store = Store::new(&[]);
        let mut disk = Disk::default();
        disk.take(store.save(now(&[], &[])));
        disk.take(store.save(now(&[frame(1)], &[])));
        disk.take(store.save(now(&[frame(1), frame(2)], &[])));
        disk.log.truncate(disk.log.len() - 2);
        let (mut store, read) = Store::restore(&disk.snapshot, &disk.log);
        assert_eq!(frames(&read, Client::Page), vec![frame(1)]);
        // What is logged after the cut would not be read: the next save is a snapshot.
        let effect = store.save(now(&[frame(1), frame(2)], &[]));
        assert!(matches!(effect, Some(Effect::InboxSnapshot { .. })));
        disk.take(effect);
        assert_eq!(frames(&disk.read(), Client::Page), vec![frame(1), frame(2)]);
    }

    #[test]
    fn no_files_and_damaged_files_are_empty_inboxes() {
        assert!(Store::restore(&[], &[])
            .1
            .iter()
            .all(|i| i.frames.is_empty()));
        assert!(Store::restore(b"junk", b"more junk")
            .1
            .iter()
            .all(|i| i.frames.is_empty()));
    }
}
