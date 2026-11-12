//! Per-device ring of parsed entries (SPEC section 10.2).

use std::collections::{HashSet, VecDeque};
use std::sync::Arc;

use super::binary::Record;

/// Distinct tags kept for sharing. Past this the table starts over (entries
/// keep the `Arc`s they already hold), so a tag that embeds a pid or an id
/// can't grow it without bound.
const MAX_TAGS: usize = 4096;

#[derive(Debug)]
pub struct LogEntry {
    /// Monotonic per device, starting at 1; survives [`Ring::clear`].
    pub seq: u64,
    pub sec: u32,
    pub nsec: u32,
    pub pid: i32,
    pub tid: u32,
    pub uid: u32,
    pub level: u8,
    pub tag: Arc<str>,
    pub msg: String,
}

impl LogEntry {
    /// Milliseconds since the epoch, as the UI shows them.
    pub fn ts_ms(&self) -> u64 {
        u64::from(self.sec) * 1000 + u64::from(self.nsec / 1_000_000)
    }
}

pub struct Ring {
    entries: VecDeque<LogEntry>,
    capacity: usize,
    next_seq: u64,
    tags: HashSet<Arc<str>>,
}

impl Ring {
    pub fn new(capacity: usize) -> Self {
        let capacity = capacity.max(1);
        Self {
            entries: VecDeque::new(),
            capacity,
            next_seq: 1,
            tags: HashSet::new(),
        }
    }

    /// Appends an entry, dropping the oldest one when the ring is full.
    pub fn push(&mut self, record: Record) {
        if self.entries.len() >= self.capacity {
            self.entries.pop_front();
        }
        let entry = LogEntry {
            seq: self.next_seq,
            sec: record.sec,
            nsec: record.nsec,
            pid: record.pid,
            tid: record.tid,
            uid: record.uid,
            level: record.level,
            tag: self.intern(&record.tag),
            msg: record.msg,
        };
        self.next_seq += 1;
        self.entries.push_back(entry);
    }

    /// Empties the ring. Sequence numbers keep counting.
    pub fn clear(&mut self) {
        self.entries.clear();
    }

    pub fn next_seq(&self) -> u64 {
        self.next_seq
    }

    /// Oldest to newest.
    pub fn iter(&self) -> impl DoubleEndedIterator<Item = &LogEntry> {
        self.entries.iter()
    }

    /// Entries with `seq >= from`, oldest first. Sequence numbers are
    /// contiguous in the ring, so this is a slice, not a scan.
    pub fn since(&self, from: u64) -> impl Iterator<Item = &LogEntry> {
        let first = self.entries.front().map_or(self.next_seq, |e| e.seq);
        let skip = usize::try_from(from.saturating_sub(first)).unwrap_or(usize::MAX);
        self.entries.range(skip.min(self.entries.len())..)
    }

    fn intern(&mut self, tag: &str) -> Arc<str> {
        if let Some(shared) = self.tags.get(tag) {
            return Arc::clone(shared);
        }
        if self.tags.len() >= MAX_TAGS {
            self.tags.clear();
        }
        let shared: Arc<str> = Arc::from(tag);
        self.tags.insert(Arc::clone(&shared));
        shared
    }
}
