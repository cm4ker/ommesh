//! The inboxes on the phone's disk, so they outlive the app: one SQLite table,
//! a row for each frame kept for a client, in the order kept.
//!
//! The core writes them itself, inside the call that changed them, rather than
//! through an effect: a message read off the radio is gone from the radio, so it
//! is on disk before the owner sends the radio the next read. Each commit is
//! synced (WAL, `synchronous = FULL`), so a phone that dies or is switched off
//! right after still has it.
//!
//! The store keeps the rows as the database holds them. A message read off the
//! radio is added at once at the end of every client's inbox, as the mux keeps
//! it ([`Store::append`]); everything else waits for a save ([`Store::save`]),
//! which writes what differs from the inboxes now. An inbox only loses frames,
//! wherever they are, and gains them at its end, so the rows are walked along
//! what is now: a row that matches stays, those that do not are deleted, and
//! the frames past the last match are added. A write that fails leaves the
//! database as it was, and the next save reads it again before it compares.

use std::ops::Range;

use rusqlite::{params, Connection, ErrorCode, TransactionBehavior};

use crate::{legacy, Client, Inbox};

/// The database's layout, in its `user_version`. One from a newer app is left alone.
const VERSION: i32 = 1;

const INSERT: &str = "INSERT INTO inbox (client, frame) VALUES (?1, ?2)";

/// Each client's rows, ids and frames, in order.
type Rows = [Vec<(i64, Vec<u8>)>; Client::COUNT];

pub(crate) struct Store {
    /// None when no database could be had: the inboxes then live as long as the app.
    db: Option<Connection>,
    /// The rows as the database holds them.
    disk: Rows,
    /// The database may hold other rows than `disk`, after a write that failed.
    stale: bool,
}

/// What [`Store::open`] found.
pub(crate) struct Opened {
    pub store: Store,
    pub inboxes: Vec<Inbox>,
    /// What went wrong on the way, for the owner's log.
    pub problems: Vec<String>,
}

impl Store {
    /// The database at `path`, made there if new. A new one takes in the inboxes kept before
    /// it, in the transaction that makes it: those of a snapshot and its log ([`legacy`]), or,
    /// with no snapshot, `inboxes` from the owner's settings. A damaged one is put aside for a
    /// new one; with no database to be had, the inboxes kept before are kept in memory.
    pub fn open(path: &str, snapshot: &[u8], log: &[u8], inboxes: Vec<Inbox>) -> Opened {
        let before = legacy::read(snapshot, log).unwrap_or(inboxes);
        let mut problems = Vec::new();
        let mut connected = connect(path, &before);
        if let Err(error) = &connected {
            problems.push(format!(
                "the inboxes' database could not be opened: {error}"
            ));
            if damaged(error) {
                put_aside(path);
                connected = connect(path, &before);
                if let Err(error) = &connected {
                    problems.push(format!("nor could a new one be made: {error}"));
                }
            }
        }
        match connected {
            Ok((db, disk)) => Opened {
                inboxes: Client::ALL
                    .iter()
                    .map(|&client| Inbox {
                        client,
                        frames: disk[client.index()]
                            .iter()
                            .map(|(_, f)| f.clone())
                            .collect(),
                    })
                    .collect(),
                store: Store {
                    db: Some(db),
                    disk,
                    stale: false,
                },
                problems,
            },
            Err(_) => Opened {
                store: Store {
                    db: None,
                    disk: Default::default(),
                    stale: false,
                },
                inboxes: before,
                problems,
            },
        }
    }

    /// Whether the inboxes are in a database, and the ways they were kept before may go.
    pub fn on_disk(&self) -> bool {
        self.db.is_some()
    }

    /// Whether the database may hold other rows than the store knows, and only a save can
    /// tell what to write.
    pub fn is_stale(&self) -> bool {
        self.stale
    }

    /// Messages read off the radio, added at the end of every client's inbox in one
    /// transaction: no walk along the inboxes, which a save does in its time.
    pub fn append(&mut self, frames: &[Vec<u8>]) -> rusqlite::Result<()> {
        let Some(db) = self.db.as_mut() else {
            return Ok(());
        };
        let added = (|| {
            let tx = db.transaction()?;
            let mut ids = Vec::new();
            {
                let mut insert = tx.prepare_cached(INSERT)?;
                for frame in frames {
                    for client in Client::ALL {
                        ids.push(insert.insert(params![client.index() as i64, frame])?);
                    }
                }
            }
            tx.commit()?;
            Ok(ids)
        })();
        let ids = match added {
            Ok(ids) => ids,
            Err(error) => {
                self.stale = true;
                return Err(error);
            }
        };
        let mut ids = ids.into_iter();
        for frame in frames {
            for client in Client::ALL {
                if let Some(id) = ids.next() {
                    self.disk[client.index()].push((id, frame.clone()));
                }
            }
        }
        Ok(())
    }

    /// Writes the inboxes as they are now, in one transaction; nothing when the database
    /// holds them already.
    pub fn save(&mut self, now: [Vec<&[u8]>; Client::COUNT]) -> rusqlite::Result<()> {
        let Some(db) = self.db.as_mut() else {
            return Ok(());
        };
        if self.stale {
            self.disk = read_rows(db)?;
            self.stale = false;
        }
        let plans =
            Client::ALL.map(|client| plan(&self.disk[client.index()], &now[client.index()]));
        if Client::ALL
            .iter()
            .all(|client| plans[client.index()].is_empty(now[client.index()].len()))
        {
            return Ok(());
        }
        let added = match write(db, &self.disk, &plans, &now) {
            Ok(added) => added,
            Err(error) => {
                self.stale = true;
                return Err(error);
            }
        };
        for (client, ids) in Client::ALL.into_iter().zip(added) {
            let i = client.index();
            let plan = &plans[i];
            let mut gone = plan.removed.iter().peekable();
            let rows = std::mem::take(&mut self.disk[i]);
            let mut kept: Vec<(i64, Vec<u8>)> = rows
                .into_iter()
                .enumerate()
                .filter(|(k, _)| {
                    while gone.next_if(|range| range.end <= *k).is_some() {}
                    !gone.peek().is_some_and(|range| range.contains(k))
                })
                .map(|(_, row)| row)
                .collect();
            kept.extend(
                ids.into_iter()
                    .zip(now[i][plan.matched..].iter().map(|f| f.to_vec())),
            );
            self.disk[i] = kept;
        }
        Ok(())
    }
}

/// What a save does to one client's rows: these deleted, and the frames from `matched` on added.
struct Plan {
    /// Runs of rows, by their place in the store's list.
    removed: Vec<Range<usize>>,
    /// How many frames now match rows, from the start.
    matched: usize,
}

impl Plan {
    fn is_empty(&self, now: usize) -> bool {
        self.removed.is_empty() && self.matched == now
    }
}

fn plan(rows: &[(i64, Vec<u8>)], now: &[&[u8]]) -> Plan {
    let mut matched = 0;
    let mut removed = Vec::new();
    let mut run: Option<usize> = None;
    for (k, (_, frame)) in rows.iter().enumerate() {
        if matched < now.len() && frame.as_slice() == now[matched] {
            if let Some(start) = run.take() {
                removed.push(start..k);
            }
            matched += 1;
        } else if run.is_none() {
            run = Some(k);
        }
    }
    if let Some(start) = run {
        removed.push(start..rows.len());
    }
    Plan { removed, matched }
}

/// The plans in one transaction; the ids of the rows added, per client.
fn write(
    db: &mut Connection,
    disk: &Rows,
    plans: &[Plan; Client::COUNT],
    now: &[Vec<&[u8]>; Client::COUNT],
) -> rusqlite::Result<Vec<Vec<i64>>> {
    let tx = db.transaction()?;
    let mut added = Vec::new();
    {
        // A client's rows are in the order of their ids, so a run of them is every row of
        // the client between the run's first id and its last.
        let mut delete =
            tx.prepare_cached("DELETE FROM inbox WHERE client = ?1 AND id BETWEEN ?2 AND ?3")?;
        let mut insert = tx.prepare_cached(INSERT)?;
        for client in Client::ALL {
            let i = client.index();
            let rows = &disk[i];
            for run in &plans[i].removed {
                delete.execute(params![i as i64, rows[run.start].0, rows[run.end - 1].0])?;
            }
            let mut ids = Vec::new();
            for frame in &now[i][plans[i].matched..] {
                ids.push(insert.insert(params![i as i64, frame])?);
            }
            added.push(ids);
        }
    }
    tx.commit()?;
    Ok(added)
}

/// The database made ready, and its rows.
fn connect(path: &str, before: &[Inbox]) -> rusqlite::Result<(Connection, Rows)> {
    let mut db = Connection::open(path)?;
    // A commit is an append to the write-ahead log, synced to the disk before it returns.
    db.pragma_update(None, "journal_mode", "WAL")?;
    db.pragma_update(None, "synchronous", "FULL")?;
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let version: i32 = tx.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if version == 0 {
        tx.execute_batch(
            "CREATE TABLE inbox (id INTEGER PRIMARY KEY, client INTEGER NOT NULL, frame BLOB NOT NULL)",
        )?;
        {
            let mut insert = tx.prepare(INSERT)?;
            for inbox in before {
                for frame in &inbox.frames {
                    insert.execute(params![inbox.client.index() as i64, frame])?;
                }
            }
        }
        tx.pragma_update(None, "user_version", VERSION)?;
    } else if version != VERSION {
        return Err(rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_ERROR),
            Some(format!("its layout {version} is a newer app's")),
        ));
    }
    tx.commit()?;
    let rows = read_rows(&db)?;
    Ok((db, rows))
}

fn read_rows(db: &Connection) -> rusqlite::Result<Rows> {
    let mut rows: Rows = Default::default();
    let mut select = db.prepare("SELECT id, client, frame FROM inbox ORDER BY id")?;
    let mut found = select.query([])?;
    while let Some(row) = found.next()? {
        let client: i64 = row.get(1)?;
        if let Some(inbox) = usize::try_from(client).ok().and_then(|c| rows.get_mut(c)) {
            inbox.push((row.get(0)?, row.get(2)?));
        }
    }
    Ok(rows)
}

/// A file that is not a database, or is one no more.
fn damaged(error: &rusqlite::Error) -> bool {
    matches!(
        error.sqlite_error_code(),
        Some(ErrorCode::DatabaseCorrupt | ErrorCode::NotADatabase)
    )
}

/// A damaged database and its log moved to `.broken`, where they can still be looked into.
fn put_aside(path: &str) {
    for suffix in ["", "-wal"] {
        let _ = std::fs::rename(format!("{path}{suffix}"), format!("{path}.broken{suffix}"));
    }
    let _ = std::fs::remove_file(format!("{path}-shm"));
}

/// A database path of its own for a test, with nothing there yet.
#[cfg(test)]
pub(crate) fn scratch(name: &str) -> String {
    let dir = std::env::temp_dir().join(format!("meshcore-core-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir
        .join(format!("{name}.db"))
        .to_string_lossy()
        .into_owned();
    for suffix in ["", "-wal", "-shm", ".broken", ".broken-wal"] {
        let _ = std::fs::remove_file(format!("{path}{suffix}"));
    }
    path
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::legacy::write;

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
        inboxes[client.index()].frames.clone()
    }

    fn reopened(path: &str) -> Vec<Inbox> {
        let opened = Store::open(path, &[], &[], Vec::new());
        assert!(opened.problems.is_empty(), "{:?}", opened.problems);
        opened.inboxes
    }

    #[test]
    fn what_comes_and_goes_is_written_and_read_back() {
        let path = scratch("comes-and-goes");
        let mut store = Store::open(&path, &[], &[], Vec::new()).store;
        let mut page: Vec<Vec<u8>> = (0..10).map(frame).collect();
        let mut computer = vec![frame(100)];
        store.save(now(&page, &computer)).unwrap();
        assert_eq!(frames(&reopened(&path), Client::Page), page);

        // Taken from the front, one from the middle, more at the end.
        page.drain(0..3);
        page.remove(4);
        page.extend((10..13).map(frame));
        computer.clear();
        store.save(now(&page, &computer)).unwrap();
        let read = reopened(&path);
        assert_eq!(frames(&read, Client::Page), page);
        assert!(frames(&read, Client::Computer).is_empty());
    }

    #[test]
    fn the_same_frame_twice_is_kept_twice() {
        let path = scratch("twice");
        let mut store = Store::open(&path, &[], &[], Vec::new()).store;
        let mut page = vec![frame(1), frame(1), frame(2)];
        store.save(now(&page, &[])).unwrap();
        page.remove(1);
        page.push(frame(1));
        store.save(now(&page, &[])).unwrap();
        assert_eq!(frames(&reopened(&path), Client::Page), page);
    }

    #[test]
    fn a_new_database_takes_in_the_snapshot_and_its_log_once() {
        let path = scratch("legacy-snapshot");
        let snapshot = write::snapshot(3, &[frame(1), frame(2)], &[frame(1)]);
        let mut log = Vec::new();
        write::remove(&mut log, 3, Client::Page, 0, 1);
        write::append(&mut log, 3, Client::Page, &frame(3));
        let settings = vec![Inbox {
            client: Client::Page,
            frames: vec![frame(9)],
        }];
        let opened = Store::open(&path, &snapshot, &log, settings.clone());
        assert!(opened.store.on_disk());
        assert_eq!(
            frames(&opened.inboxes, Client::Page),
            vec![frame(2), frame(3)]
        );
        assert_eq!(frames(&opened.inboxes, Client::Computer), vec![frame(1)]);
        drop(opened);

        // Left behind by an app stopped before it removed them, they are not taken in again.
        let again = Store::open(&path, &snapshot, &log, settings);
        assert_eq!(
            frames(&again.inboxes, Client::Page),
            vec![frame(2), frame(3)]
        );
    }

    #[test]
    fn with_no_snapshot_a_new_database_takes_in_the_settings_inboxes() {
        let path = scratch("legacy-settings");
        let settings = vec![Inbox {
            client: Client::Computer,
            frames: vec![frame(1), frame(2)],
        }];
        let opened = Store::open(&path, &[], &[], settings);
        assert_eq!(
            frames(&opened.inboxes, Client::Computer),
            vec![frame(1), frame(2)]
        );
        drop(opened);
        assert_eq!(
            frames(&reopened(&path), Client::Computer),
            vec![frame(1), frame(2)]
        );
    }

    #[test]
    fn a_damaged_database_is_put_aside_for_a_new_one() {
        let path = scratch("damaged");
        std::fs::write(&path, vec![7u8; 8192]).unwrap();
        let opened = Store::open(&path, &[], &[], Vec::new());
        assert!(opened.store.on_disk());
        assert_eq!(opened.problems.len(), 1, "{:?}", opened.problems);
        assert_eq!(
            std::fs::read(format!("{path}.broken")).unwrap(),
            vec![7u8; 8192]
        );
        let mut store = opened.store;
        store.save(now(&[frame(1)], &[])).unwrap();
        assert_eq!(frames(&reopened(&path), Client::Page), vec![frame(1)]);
    }

    #[test]
    fn a_database_from_a_newer_app_is_left_alone() {
        let path = scratch("newer");
        Connection::open(&path)
            .unwrap()
            .pragma_update(None, "user_version", VERSION + 1)
            .unwrap();
        let settings = vec![Inbox {
            client: Client::Page,
            frames: vec![frame(1)],
        }];
        let mut opened = Store::open(&path, &[], &[], settings);
        assert!(!opened.store.on_disk());
        assert_eq!(opened.problems.len(), 1);
        assert_eq!(frames(&opened.inboxes, Client::Page), vec![frame(1)]);
        opened.store.save(now(&[frame(2)], &[])).unwrap();
        let version: i32 = Connection::open(&path)
            .unwrap()
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, VERSION + 1);
    }

    #[test]
    fn with_no_database_the_inboxes_are_kept_in_memory() {
        let path = scratch("nowhere").replace(".db", "/missing/folder/inboxes.db");
        let settings = vec![Inbox {
            client: Client::Page,
            frames: vec![frame(1)],
        }];
        let mut opened = Store::open(&path, &[], &[], settings);
        assert!(!opened.store.on_disk());
        assert_eq!(frames(&opened.inboxes, Client::Page), vec![frame(1)]);
        assert!(opened.store.save(now(&[frame(1), frame(2)], &[])).is_ok());
    }

    #[test]
    fn a_write_that_fails_is_made_good_by_the_next() {
        let path = scratch("fails");
        let mut store = Store::open(&path, &[], &[], Vec::new()).store;
        let page: Vec<Vec<u8>> = (0..5).map(frame).collect();
        store.save(now(&page, &[])).unwrap();

        // Another hand holds the database and changes it meanwhile.
        let other = Connection::open(&path).unwrap();
        other
            .execute_batch("BEGIN IMMEDIATE; DELETE FROM inbox WHERE id <= 2")
            .unwrap();
        let more: Vec<Vec<u8>> = (0..7).map(frame).collect();
        assert!(store.save(now(&more, &[])).is_err());
        other.execute_batch("COMMIT").unwrap();
        drop(other);

        store.save(now(&more, &[])).unwrap();
        assert_eq!(frames(&reopened(&path), Client::Page), more);
    }

    #[test]
    fn a_message_read_off_the_radio_is_added_for_every_client() {
        let path = scratch("append");
        let mut store = Store::open(&path, &[], &[], Vec::new()).store;
        store.save(now(&[frame(1)], &[])).unwrap();
        store.append(&[frame(2), frame(3)]).unwrap();
        let read = reopened(&path);
        assert_eq!(
            frames(&read, Client::Page),
            vec![frame(1), frame(2), frame(3)]
        );
        assert_eq!(frames(&read, Client::Computer), vec![frame(2), frame(3)]);

        // The page took the first meanwhile: a save finds only that.
        store
            .save(now(&[frame(2), frame(3)], &[frame(2), frame(3)]))
            .unwrap();
        assert_eq!(
            frames(&reopened(&path), Client::Page),
            vec![frame(2), frame(3)]
        );
    }

    #[test]
    fn an_append_that_fails_leaves_the_next_save_to_make_it_good() {
        let path = scratch("append-fails");
        let mut store = Store::open(&path, &[], &[], Vec::new()).store;
        let other = Connection::open(&path).unwrap();
        other.execute_batch("BEGIN IMMEDIATE").unwrap();
        assert!(store.append(&[frame(1)]).is_err());
        assert!(store.is_stale());
        other.execute_batch("COMMIT").unwrap();
        store.save(now(&[frame(1)], &[frame(1)])).unwrap();
        assert!(!store.is_stale());
        assert_eq!(frames(&reopened(&path), Client::Computer), vec![frame(1)]);
    }

    #[test]
    fn nothing_new_writes_nothing() {
        let path = scratch("nothing-new");
        let mut store = Store::open(&path, &[], &[], Vec::new()).store;
        let page = vec![frame(1)];
        store.save(now(&page, &[])).unwrap();
        let db = store.db.as_ref().unwrap();
        let before = db.total_changes();
        store.save(now(&page, &[])).unwrap();
        assert_eq!(store.db.as_ref().unwrap().total_changes(), before);
    }
}
