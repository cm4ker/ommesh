//! The inboxes as the core kept them before its database (#105): a snapshot and
//! a log of what changed since it, in two files the owner wrote. Read once, when
//! the database is made, and never written again.
//!
//! Every record of the log carries the generation of the snapshot it follows,
//! so a log left from before the newest snapshot is passed over; a log cut
//! short is read up to the cut.

use crate::{Client, Inbox};

const MAGIC: &[u8; 4] = b"MCI1";
/// A record that adds a frame at the end of a client's inbox.
const APPEND: u8 = 1;
/// A record that takes frames out of a client's inbox.
const REMOVE: u8 = 2;

/// The inboxes in a snapshot and its log; none for a snapshot that is missing or cannot be read.
pub(crate) fn read(snapshot: &[u8], log: &[u8]) -> Option<Vec<Inbox>> {
    let (generation, mut inboxes) = read_snapshot(snapshot)?;
    let mut r = Reader { bytes: log, at: 0 };
    while r.left() > 0 && apply(&mut r, generation, &mut inboxes) {}
    Some(
        Client::ALL
            .iter()
            .map(|&client| Inbox {
                client,
                frames: std::mem::take(&mut inboxes[client.index()]),
            })
            .collect(),
    )
}

/// One record, if it can be read; it changes the inboxes only if it follows this snapshot.
fn apply(r: &mut Reader, generation: u32, inboxes: &mut [Vec<Vec<u8>>; Client::COUNT]) -> bool {
    let (Some(of), Some(kind), Some(client)) = (r.u32(), r.u8(), r.u8()) else {
        return false;
    };
    let ours = of == generation;
    let Some(inbox) = inboxes.get_mut(client as usize) else {
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

/// A snapshot's generation and inboxes; none for one that is missing, of another kind or cut short.
fn read_snapshot(bytes: &[u8]) -> Option<(u32, [Vec<Vec<u8>>; Client::COUNT])> {
    let mut r = Reader { bytes, at: 0 };
    if r.take(MAGIC.len())? != MAGIC {
        return None;
    }
    let generation = r.u32()?;
    let mut inboxes: [Vec<Vec<u8>>; Client::COUNT] = Default::default();
    for _ in Client::ALL {
        let client = r.u8()? as usize;
        let count = r.u32()?;
        let inbox = inboxes.get_mut(client)?;
        for _ in 0..count {
            inbox.push(r.frame()?.to_vec());
        }
    }
    Some((generation, inboxes))
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

/// The two files as the core had them written, for tests here and in [`crate::store`].
#[cfg(test)]
pub(crate) mod write {
    use super::*;

    pub fn snapshot(generation: u32, page: &[Vec<u8>], computer: &[Vec<u8>]) -> Vec<u8> {
        let mut bytes = MAGIC.to_vec();
        bytes.extend_from_slice(&generation.to_le_bytes());
        for (client, frames) in [page, computer].iter().enumerate() {
            bytes.push(client as u8);
            bytes.extend_from_slice(&(frames.len() as u32).to_le_bytes());
            for frame in *frames {
                bytes.extend_from_slice(&(frame.len() as u16).to_le_bytes());
                bytes.extend_from_slice(frame);
            }
        }
        bytes
    }

    pub fn append(log: &mut Vec<u8>, generation: u32, client: Client, frame: &[u8]) {
        log.extend_from_slice(&generation.to_le_bytes());
        log.extend_from_slice(&[APPEND, client.index() as u8]);
        log.extend_from_slice(&(frame.len() as u16).to_le_bytes());
        log.extend_from_slice(frame);
    }

    pub fn remove(log: &mut Vec<u8>, generation: u32, client: Client, at: u32, count: u32) {
        log.extend_from_slice(&generation.to_le_bytes());
        log.extend_from_slice(&[REMOVE, client.index() as u8]);
        log.extend_from_slice(&at.to_le_bytes());
        log.extend_from_slice(&count.to_le_bytes());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(n: u8) -> Vec<u8> {
        vec![16, n]
    }

    fn frames(inboxes: &[Inbox], client: Client) -> Vec<Vec<u8>> {
        inboxes[client.index()].frames.clone()
    }

    #[test]
    fn a_snapshot_and_its_log_are_read_together() {
        let snapshot = write::snapshot(7, &[frame(1), frame(2), frame(3)], &[frame(1)]);
        let mut log = Vec::new();
        write::remove(&mut log, 7, Client::Page, 0, 2);
        write::append(&mut log, 7, Client::Page, &frame(4));
        write::append(&mut log, 7, Client::Computer, &frame(2));
        let read = read(&snapshot, &log).unwrap();
        assert_eq!(frames(&read, Client::Page), vec![frame(3), frame(4)]);
        assert_eq!(frames(&read, Client::Computer), vec![frame(1), frame(2)]);
    }

    #[test]
    fn a_log_from_before_the_snapshot_is_passed_over() {
        let snapshot = write::snapshot(8, &[frame(1)], &[]);
        let mut log = Vec::new();
        write::append(&mut log, 7, Client::Page, &frame(1));
        let read = read(&snapshot, &log).unwrap();
        assert_eq!(frames(&read, Client::Page), vec![frame(1)]);
    }

    #[test]
    fn a_log_cut_short_is_read_up_to_the_cut() {
        let snapshot = write::snapshot(1, &[], &[]);
        let mut log = Vec::new();
        write::append(&mut log, 1, Client::Page, &frame(1));
        write::append(&mut log, 1, Client::Page, &frame(2));
        log.truncate(log.len() - 1);
        let read = read(&snapshot, &log).unwrap();
        assert_eq!(frames(&read, Client::Page), vec![frame(1)]);
    }

    #[test]
    fn no_snapshot_or_a_damaged_one_is_none() {
        assert!(read(&[], &[]).is_none());
        assert!(read(b"junk", b"more junk").is_none());
        let mut cut = write::snapshot(1, &[frame(1)], &[]);
        cut.pop();
        assert!(read(&cut, &[]).is_none());
    }
}
