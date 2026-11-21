//! The developer log: one timeline of what the app did (sync, git commands,
//! file changes, saves, and the window's own entries), shown in the
//! developer panel and copied from there into bug reports.
//!
//! Entries never contain page text, only sizes and ids, so a copied log is
//! safe to share.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

/// How many entries to keep. Older ones are dropped.
const CAPACITY: usize = 5000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Level {
    Debug,
    Info,
    Warn,
    Error,
}

#[derive(Debug, Clone, Serialize)]
pub struct Entry {
    pub id: u64,
    /// Milliseconds since the Unix epoch.
    pub time: u64,
    pub level: Level,
    /// Where it came from: "sync", "git", "watch", "save", "app", "ui", ...
    pub source: String,
    pub message: String,
}

type Sink = Box<dyn Fn(&Entry) + Send + Sync>;

#[derive(Default)]
struct Log {
    entries: Mutex<VecDeque<Entry>>,
    next_id: AtomicU64,
    sink: Mutex<Option<Sink>>,
}

fn global() -> &'static Log {
    static LOG: OnceLock<Log> = OnceLock::new();
    LOG.get_or_init(Log::default)
}

/// Whether the developer panel is available: in debug builds, or with
/// `DOCSYNC_DEV=1` set.
pub fn enabled() -> bool {
    cfg!(debug_assertions) || std::env::var_os("DOCSYNC_DEV").is_some_and(|v| v == "1")
}

/// Send every new entry here as well (the app forwards them to the window).
pub fn set_sink(sink: impl Fn(&Entry) + Send + Sync + 'static) {
    *global().sink.lock().unwrap() = Some(Box::new(sink));
}

pub fn log(level: Level, source: &str, message: impl Into<String>) {
    let log = global();
    let entry = Entry {
        id: log.next_id.fetch_add(1, Ordering::Relaxed),
        time: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or_default(),
        level,
        source: source.to_string(),
        message: message.into(),
    };
    if cfg!(debug_assertions) {
        eprintln!("[{}] {:?} {}", entry.source, entry.level, entry.message);
    }
    {
        let mut entries = log.entries.lock().unwrap();
        if entries.len() == CAPACITY {
            entries.pop_front();
        }
        entries.push_back(entry.clone());
    }
    if let Some(sink) = log.sink.lock().unwrap().as_ref() {
        sink(&entry);
    }
}

pub fn debug(source: &str, message: impl Into<String>) {
    log(Level::Debug, source, message);
}

pub fn info(source: &str, message: impl Into<String>) {
    log(Level::Info, source, message);
}

pub fn warn(source: &str, message: impl Into<String>) {
    log(Level::Warn, source, message);
}

pub fn error(source: &str, message: impl Into<String>) {
    log(Level::Error, source, message);
}

pub fn entries() -> Vec<Entry> {
    global().entries.lock().unwrap().iter().cloned().collect()
}

pub fn clear() {
    global().entries.lock().unwrap().clear();
}

/// Text, cut to `max` characters, for git's stderr and the like.
pub fn short(text: &str, max: usize) -> String {
    let text = text.trim();
    match text.char_indices().nth(max) {
        Some((i, _)) => format!("{}…", &text[..i]),
        None => text.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_entries_in_order_and_shortens_text() {
        log(Level::Info, "test", "first");
        log(Level::Warn, "test", "second");
        let mine: Vec<_> = entries().into_iter().filter(|e| e.source == "test").collect();
        assert!(mine.windows(2).all(|w| w[0].id < w[1].id));
        assert_eq!(mine.last().unwrap().message, "second");
        assert_eq!(short("abcdef", 3), "abc…");
        assert_eq!(short(" ab ", 3), "ab");
    }
}
