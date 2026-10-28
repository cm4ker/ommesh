//! How long keeping the inboxes takes the thread that runs the core: messages
//! read off the radio one at a time and in bursts, a page taking 5000 at once,
//! and a start with them on disk. On a phone, where it counts:
//!
//! ```sh
//! cargo ndk -t arm64-v8a --platform 24 build --release --example inbox_bench
//! adb push target/aarch64-linux-android/release/examples/inbox_bench /data/local/tmp/
//! adb shell /data/local/tmp/inbox_bench /data/local/tmp/inbox-bench
//! ```

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use meshcore_core::codes::*;
use meshcore_core::{Client, Core, Effect, Timer};

struct Owner {
    core: Core,
    /// Time inside the core's calls, the database's writes included.
    spent: Duration,
    save_due: bool,
}

impl Owner {
    fn open(dir: &Path) -> (Owner, Duration) {
        let t = Instant::now();
        let path = dir.join("inboxes.db");
        let core = Core::open(&path.to_string_lossy(), &[], &[], Vec::new());
        assert!(core.on_disk());
        let took = t.elapsed();
        let owner = Owner {
            core,
            spent: Duration::ZERO,
            save_due: false,
        };
        (owner, took)
    }

    fn call(&mut self, f: impl FnOnce(&mut Core) -> Vec<Effect>) {
        let t = Instant::now();
        let effects = f(&mut self.core);
        self.spent += t.elapsed();
        for effect in effects {
            match effect {
                Effect::Wait {
                    timer: Timer::Save, ..
                } => self.save_due = true,
                Effect::Log { line } => panic!("{line}"),
                _ => {}
            }
        }
    }

    /// The save's wait is over.
    fn save_timer(&mut self) {
        if self.save_due {
            self.save_due = false;
            self.call(|c| c.timeout(Timer::Save, 0));
        }
    }
}

fn message(n: u32) -> Vec<u8> {
    let mut f = vec![RESP_CHANNEL_MSG_RECV_V3, 40, 0, 0, 0, 2, 0];
    f.extend_from_slice(&(1_760_000_000u32 + n).to_le_bytes());
    f.extend_from_slice(
        format!("Someone {n}: a message of the kind a busy channel carries all day long, {n}")
            .as_bytes(),
    );
    f
}

fn ms(d: Duration) -> f64 {
    d.as_secs_f64() * 1000.0
}

fn stats(name: &str, samples: &mut [Duration]) {
    samples.sort();
    let mean = samples.iter().sum::<Duration>() / samples.len() as u32;
    let p = |q: f64| samples[((samples.len() - 1) as f64 * q) as usize];
    println!(
        "{name}: mean {:.3} ms, p50 {:.3}, p99 {:.3}, max {:.3}",
        ms(mean),
        ms(p(0.5)),
        ms(p(0.99)),
        ms(*samples.last().unwrap())
    );
}

fn sizes(dir: &Path) -> String {
    let mut out: Vec<String> = fs::read_dir(dir)
        .unwrap()
        .map(|entry| {
            let entry = entry.unwrap();
            let size = entry.metadata().unwrap().len() / 1024;
            format!("{} {size} KB", entry.file_name().to_string_lossy())
        })
        .collect();
    out.sort();
    out.join(", ")
}

fn main() {
    let dir = PathBuf::from(
        std::env::args()
            .nth(1)
            .unwrap_or_else(|| "inbox-bench".into()),
    );
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let (mut o, took) = Owner::open(&dir);
    println!("a new database: {:.1} ms", ms(took));
    o.call(|c| c.radio_up());
    o.call(|c| c.from_radio(vec![RESP_NO_MORE_MESSAGES]));

    // One message at a time, as a channel goes on all day.
    let trickle = 1000;
    let mut each = Vec::new();
    for n in 0..trickle {
        o.spent = Duration::ZERO;
        o.call(|c| c.from_radio(vec![PUSH_MSG_WAITING]));
        let m = message(n);
        o.call(move |c| c.from_radio(m));
        o.call(|c| c.from_radio(vec![RESP_NO_MORE_MESSAGES]));
        o.save_timer();
        each.push(o.spent);
    }
    stats("one message", &mut each);

    // The radio's queue read out at once, as after a link comes back: 16 at a time, to 5000.
    let mut n = trickle;
    let mut bursts = Vec::new();
    while n < 5000 {
        o.spent = Duration::ZERO;
        o.call(|c| c.from_radio(vec![PUSH_MSG_WAITING]));
        for _ in 0..16 {
            let m = message(n);
            o.call(move |c| c.from_radio(m));
            n += 1;
        }
        o.call(|c| c.from_radio(vec![RESP_NO_MORE_MESSAGES]));
        o.save_timer();
        bursts.push(o.spent);
    }
    println!(
        "bursts of 16 to {n}: {:.1} ms",
        ms(bursts.iter().sum::<Duration>())
    );
    stats("a burst of 16", &mut bursts);
    println!("on disk: {}", sizes(&dir));

    // The page wakes and takes them all, saving as it goes.
    o.spent = Duration::ZERO;
    let t = Instant::now();
    o.call(|c| c.attach(Client::Page));
    o.call(|c| c.from_client(Client::Page, vec![PEER, PEER_KEEP, KEEP_MIRRORS], None));
    for i in 0..=n {
        o.call(|c| c.from_client(Client::Page, vec![CMD_SYNC_NEXT_MESSAGE], None));
        if i == n / 2 {
            o.save_timer();
        }
    }
    let mut saved = vec![PEER, PEER_SAVED];
    saved.extend_from_slice(&n.to_le_bytes());
    saved.extend_from_slice(&0u32.to_le_bytes());
    o.call(move |c| c.from_client(Client::Page, saved, None));
    o.save_timer();
    println!(
        "the page takes {n}: {:.1} ms (wall {:.1} ms)",
        ms(o.spent),
        ms(t.elapsed())
    );
    println!("on disk: {}", sizes(&dir));

    // The app started again, the computer's inbox still full.
    drop(o);
    let (o, took) = Owner::open(&dir);
    let kept: usize = o.core.inboxes().iter().map(|i| i.frames.len()).sum();
    println!("start with {kept} kept: {:.1} ms", ms(took));
}
