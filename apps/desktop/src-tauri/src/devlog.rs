//! The developer log: one timeline of what the app did (sync, git commands,
//! file changes, saves, and the window's own entries), shown in the
//! developer panel and copied from there into bug reports.
//!
//! Entries never contain page text, only sizes and ids, so a copied log is
//! safe to share.
//!
//! Every entry also goes to a log file in the app's log folder
//! (`~/Library/Logs/<identifier>/sawmill.log` on macOS), which Settings ›
//! About shows, so problems can be traced after a restart or a crash. At
//! [`MAX_FILE_BYTES`] it moves to `sawmill.1.log`, replacing the previous
//! one.

use std::collections::VecDeque;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

/// How many entries to keep. Older ones are dropped.
const CAPACITY: usize = 5000;

/// The log file's size limit; see the module docs.
pub const MAX_FILE_BYTES: u64 = 5 * 1024 * 1024;

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
    file: Mutex<Option<LogFile>>,
}

struct LogFile {
    path: PathBuf,
    file: File,
    size: u64,
}

impl LogFile {
    fn open(path: &Path) -> std::io::Result<Self> {
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir)?;
        }
        let file = OpenOptions::new().create(true).append(true).open(path)?;
        let size = file.metadata()?.len();
        Ok(Self {
            path: path.to_path_buf(),
            file,
            size,
        })
    }

    fn write(&mut self, line: &str) {
        if self.size + line.len() as u64 > MAX_FILE_BYTES {
            let _ = fs::rename(&self.path, self.path.with_extension("1.log"));
            if let Ok(fresh) = Self::open(&self.path) {
                *self = fresh;
            }
        }
        if self.file.write_all(line.as_bytes()).is_ok() {
            self.size += line.len() as u64;
        }
    }
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

/// Write every entry from now on to the file at `path` as well.
pub fn set_file(path: &Path) -> std::io::Result<()> {
    *global().file.lock().unwrap() = Some(LogFile::open(path)?);
    Ok(())
}

/// The log file, once [`set_file`] has opened it.
pub fn file_path() -> Option<PathBuf> {
    global().file.lock().unwrap().as_ref().map(|f| f.path.clone())
}

/// A line of the log file: `2026-11-27 07:32:00.123Z INFO  [sync] message`.
fn file_line(entry: &Entry) -> String {
    let level = match entry.level {
        Level::Debug => "DEBUG",
        Level::Info => "INFO ",
        Level::Warn => "WARN ",
        Level::Error => "ERROR",
    };
    let message = entry.message.replace('\n', "\n    ");
    format!("{} {level} [{}] {message}\n", utc_time(entry.time), entry.source)
}

/// Milliseconds since the Unix epoch as `YYYY-MM-DD HH:MM:SS.mmmZ`.
fn utc_time(ms: u64) -> String {
    let secs = ms / 1000;
    let (days, day_secs) = ((secs / 86_400) as i64, secs % 86_400);
    // Howard Hinnant's days-to-civil algorithm.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02} {:02}:{:02}:{:02}.{:03}Z",
        day_secs / 3600,
        day_secs / 60 % 60,
        day_secs % 60,
        ms % 1000
    )
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
    if let Some(file) = log.file.lock().unwrap().as_mut() {
        file.write(&file_line(&entry));
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

    #[test]
    fn formats_times_in_utc() {
        assert_eq!(utc_time(0), "1970-01-01 00:00:00.000Z");
        assert_eq!(utc_time(951_782_400_123), "2000-02-29 00:00:00.123Z");
        assert_eq!(
            utc_time(1_795_737_600_000 + 7_384_005),
            "2026-11-27 02:03:04.005Z"
        );
    }

    #[test]
    fn log_file_lines_and_rotation() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("logs").join("sawmill.log");
        let mut file = LogFile::open(&path).unwrap();
        let entry = Entry {
            id: 0,
            time: 0,
            level: Level::Warn,
            source: "sync".into(),
            message: "two\nlines".into(),
        };
        file.write(&file_line(&entry));
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            "1970-01-01 00:00:00.000Z WARN  [sync] two\n    lines\n"
        );
        file.size = MAX_FILE_BYTES;
        file.write("next\n");
        assert_eq!(fs::read_to_string(&path).unwrap(), "next\n");
        assert!(dir.path().join("logs").join("sawmill.1.log").exists());
    }
}
