use regex::Regex;
use serde::Deserialize;

use super::ring::LogEntry;

const SYSTEM_UID: u32 = 1000;
const MIN_PROBLEM_LEVEL: u8 = 6;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogFilter {
    pub min_level: u8,
    pub tag: Option<String>,
    pub text: Option<String>,
    pub regex: bool,
    pub only_app: bool,
}

pub struct App<'a> {
    pub package: &'a str,
    pub uid: Option<u32>,
}

enum Text {
    Substring(String),
    Regex(Regex),
}

#[derive(Default)]
pub struct Matcher {
    min_level: u8,
    tag: Option<String>,
    text: Option<Text>,
    only_app: bool,
}

impl Matcher {
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

/// `system_server` (uid 1000) logs the app's crashes and ANRs at `E`/`F`.
fn is_app_line(entry: &LogEntry, app: &App<'_>) -> bool {
    app.uid == Some(entry.uid)
        || (entry.uid == SYSTEM_UID
            && entry.level >= MIN_PROBLEM_LEVEL
            && entry.msg.contains(app.package))
}

/// `needle_lower` must be non-empty: `windows(0)` panics.
fn contains_ignore_case(haystack: &str, needle_lower: &str) -> bool {
    if needle_lower.is_ascii() {
        // ASCII bytes never occur inside multi-byte UTF-8, so a byte-wise match can't split a char.
        let needle = needle_lower.as_bytes();
        haystack
            .as_bytes()
            .windows(needle.len())
            .any(|window| window.eq_ignore_ascii_case(needle))
    } else {
        haystack.to_lowercase().contains(needle_lower)
    }
}
