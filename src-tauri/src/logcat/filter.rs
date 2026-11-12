//! The UI's log filter (SPEC section 10.2): level, tag, text or regex, and
//! "only my app".

use regex::Regex;
use serde::Deserialize;

use super::ring::LogEntry;

/// Uid of `system_server`, which logs crashes and ANRs of other apps.
const SYSTEM_UID: u32 = 1000;
/// `E` and `F`: the levels that make a system line about the app interesting.
const MIN_PROBLEM_LEVEL: u8 = 6;

/// What the UI sends: `minLevel` is 2 (V) to 7 (F).
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogFilter {
    pub min_level: u8,
    /// Case-insensitive substring of the tag.
    pub tag: Option<String>,
    /// Case-insensitive substring of the message, or a regex over it.
    pub text: Option<String>,
    pub regex: bool,
    pub only_app: bool,
}

/// The app that "only my app" keeps.
pub struct App<'a> {
    pub package: &'a str,
    pub uid: Option<u32>,
}

enum Text {
    /// Lowercased.
    Substring(String),
    Regex(Regex),
}

/// A [`LogFilter`] ready to run: lowercased needles and a compiled regex. The
/// default matches everything.
#[derive(Default)]
pub struct Matcher {
    min_level: u8,
    /// Lowercased.
    tag: Option<String>,
    text: Option<Text>,
    only_app: bool,
}

impl Matcher {
    /// Fails with the regex error text when `filter.regex` and the pattern is
    /// invalid. An empty tag or text means no filter.
    pub fn new(filter: &LogFilter) -> Result<Self, regex::Error> {
        let text = match filter.text.as_deref().filter(|t| !t.is_empty()) {
            None => None,
            Some(pattern) if filter.regex => Some(Text::Regex(Regex::new(pattern)?)),
            Some(needle) => Some(Text::Substring(needle.to_lowercase())),
        };
        Ok(Self {
            min_level: filter.min_level,
            tag: filter
                .tag
                .as_deref()
                .filter(|t| !t.is_empty())
                .map(str::to_lowercase),
            text,
            only_app: filter.only_app,
        })
    }

    pub fn matches(&self, entry: &LogEntry, app: &App<'_>) -> bool {
        entry.level >= self.min_level
            && self
                .tag
                .as_deref()
                .is_none_or(|needle| contains_ignore_case(&entry.tag, needle))
            && (!self.only_app || is_app_line(entry, app))
            && match &self.text {
                None => true,
                Some(Text::Substring(needle)) => contains_ignore_case(&entry.msg, needle),
                Some(Text::Regex(regex)) => regex.is_match(&entry.msg),
            }
    }
}

/// The app's own lines, plus `E`/`F` lines from `system_server` that mention
/// its package (crashes, ANRs, "Process ... has died").
fn is_app_line(entry: &LogEntry, app: &App<'_>) -> bool {
    app.uid == Some(entry.uid)
        || (entry.uid == SYSTEM_UID
            && entry.level >= MIN_PROBLEM_LEVEL
            && entry.msg.contains(app.package))
}

/// `needle_lower` is already lowercase and non-empty.
fn contains_ignore_case(haystack: &str, needle_lower: &str) -> bool {
    if needle_lower.is_ascii() {
        // No byte of a multi-byte UTF-8 sequence is ASCII, so a byte-wise
        // match can't split a character, and nothing is allocated per row.
        let needle = needle_lower.as_bytes();
        haystack
            .as_bytes()
            .windows(needle.len())
            .any(|window| window.eq_ignore_ascii_case(needle))
    } else {
        haystack.to_lowercase().contains(needle_lower)
    }
}
