use std::fmt;

const MIN_API_LEVEL: u32 = 24;
const MAX_SEGMENT_LEN: usize = 64;
const STABLE_FALLBACK: &str = "channel-0";
const PAGE_SIZE_TAG: &str = "page_size_16kb";
const HOST_OS: &str = if cfg!(windows) {
    "windows"
} else if cfg!(target_os = "macos") {
    "macosx"
} else {
    "linux"
};
const NAMESPACES: &str = r#"xmlns:ns2="http://schemas.android.com/repository/android/common/02" xmlns:ns3="http://schemas.android.com/repository/android/common/01" xmlns:ns4="http://schemas.android.com/repository/android/generic/01" xmlns:ns5="http://schemas.android.com/repository/android/generic/02" xmlns:ns6="http://schemas.android.com/sdk/android/repo/repository2/04" xmlns:ns7="http://schemas.android.com/sdk/android/repo/repository2/01" xmlns:ns8="http://schemas.android.com/sdk/android/repo/repository2/02" xmlns:ns9="http://schemas.android.com/sdk/android/repo/repository2/03" xmlns:ns10="http://schemas.android.com/sdk/android/repo/addon2/01" xmlns:ns11="http://schemas.android.com/sdk/android/repo/addon2/02" xmlns:ns12="http://schemas.android.com/sdk/android/repo/addon2/03" xmlns:ns13="http://schemas.android.com/sdk/android/repo/addon2/04" xmlns:ns14="http://schemas.android.com/sdk/android/repo/sys-img2/05" xmlns:ns15="http://schemas.android.com/sdk/android/repo/sys-img2/04" xmlns:ns16="http://schemas.android.com/sdk/android/repo/sys-img2/03" xmlns:ns17="http://schemas.android.com/sdk/android/repo/sys-img2/02" xmlns:ns18="http://schemas.android.com/sdk/android/repo/sys-img2/01""#;
const REVISION_PARTS: [&str; 3] = ["major", "minor", "micro"];

#[derive(Clone, Copy, Debug)]
pub struct Revision {
    parts: [u32; 3],
    len: usize,
}

impl Revision {
    pub fn parse(text: &str) -> Option<Self> {
        let mut parts = [0; 3];
        let mut len = 0;
        for (slot, piece) in parts.iter_mut().zip(text.trim().split('.')) {
            let digits: String = piece
                .trim()
                .chars()
                .take_while(char::is_ascii_digit)
                .collect();
            let Ok(value) = digits.parse() else {
                break;
            };
            *slot = value;
            len += 1;
        }
        (len > 0).then_some(Self { parts, len })
    }

    fn of(major: u32, minor: Option<u32>, micro: Option<u32>) -> Self {
        let len = if micro.is_some() {
            3
        } else if minor.is_some() {
            2
        } else {
            1
        };
        Self {
            parts: [major, minor.unwrap_or(0), micro.unwrap_or(0)],
            len,
        }
    }

    pub fn key(self) -> [u32; 3] {
        self.parts
    }
}

impl fmt::Display for Revision {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let text: Vec<String> = self.parts[..self.len].iter().map(u32::to_string).collect();
        f.write_str(&text.join("."))
    }
}

#[derive(Clone, Debug)]
pub struct Entry {
    pub id: String,
    pub folders: [String; 3],
    pub api_level: u32,
    pub api_minor: Option<u32>,
    pub extension_level: Option<u32>,
    pub tags: Vec<(String, String)>,
    pub abi: String,
    pub revision: Revision,
    pub display_name: String,
    pub size: u64,
    pub sha1: String,
    pub url: String,
    pub license_id: String,
    pub min_emulator: Option<Revision>,
    type_details: String,
    dependencies: Option<String>,
}

#[derive(Debug, Default)]
pub struct Parsed {
    pub entries: Vec<Entry>,
    pub licenses: Vec<(String, String)>,
}

struct Element<'a> {
    attrs: &'a str,
    inner: &'a str,
}

fn elements<'a>(xml: &'a str, name: &str) -> Vec<Element<'a>> {
    let open = format!("<{name}");
    let close = format!("</{name}>");
    let mut found = Vec::new();
    let mut rest = xml;
    while let Some(start) = rest.find(&open) {
        let after = &rest[start + open.len()..];
        if !after.starts_with(|c: char| c == '>' || c == '/' || c.is_ascii_whitespace()) {
            rest = after;
            continue;
        }
        let Some(tag_end) = after.find('>') else {
            break;
        };
        let attrs = &after[..tag_end];
        let body = &after[tag_end + 1..];
        if let Some(attrs) = attrs.strip_suffix('/') {
            found.push(Element { attrs, inner: "" });
            rest = body;
            continue;
        }
        let Some(end) = body.find(&close) else {
            break;
        };
        found.push(Element {
            attrs,
            inner: &body[..end],
        });
        rest = &body[end + close.len()..];
    }
    found
}

fn first<'a>(xml: &'a str, name: &str) -> Option<Element<'a>> {
    elements(xml, name).into_iter().next()
}

fn text(xml: &str, name: &str) -> Option<String> {
    first(xml, name).map(|element| unescape(element.inner.trim()))
}

fn attr(attrs: &str, name: &str) -> Option<String> {
    let needle = format!("{name}=\"");
    let mut from = 0;
    while let Some(found) = attrs[from..].find(&needle) {
        let start = from + found;
        let value = &attrs[start + needle.len()..];
        if attrs[..start].ends_with(|c: char| c.is_ascii_whitespace()) {
            return value.find('"').map(|end| unescape(&value[..end]));
        }
        from = start + needle.len();
    }
    None
}

fn unescape(text: &str) -> String {
    const ENTITIES: [(&str, char); 5] = [
        ("&lt;", '<'),
        ("&gt;", '>'),
        ("&amp;", '&'),
        ("&quot;", '"'),
        ("&apos;", '\''),
    ];
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find('&') {
        out.push_str(&rest[..at]);
        rest = &rest[at..];
        match ENTITIES.iter().find(|(entity, _)| rest.starts_with(entity)) {
            Some((entity, plain)) => {
                out.push(*plain);
                rest = &rest[entity.len()..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

fn escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn reindent(xml: &str, mut depth: usize, out: &mut String) {
    for line in xml.lines().map(str::trim).filter(|line| !line.is_empty()) {
        if line.starts_with("</") {
            depth = depth.saturating_sub(1);
        }
        out.push_str(&"    ".repeat(depth));
        out.push_str(line);
        out.push('\n');
        let opens = line.starts_with('<')
            && !line.starts_with("</")
            && !line.starts_with("<?")
            && !line.starts_with("<!")
            && !line.ends_with("/>")
            && !line.contains("</");
        if opens {
            depth += 1;
        }
    }
}

// Same rules as `emulator::valid_name`, so everything installed here shows up in the AVD scan.
fn valid_segment(segment: &str) -> bool {
    segment.len() <= MAX_SEGMENT_LEN
        && segment.starts_with(|c: char| c.is_ascii_alphanumeric())
        && !segment.ends_with('.')
        && segment
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

fn valid_ident(ident: &str) -> bool {
    !ident.is_empty()
        && ident
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

fn valid_relative_url(url: &str) -> bool {
    url.split('/').all(|part| {
        !part.is_empty()
            && part != "."
            && part != ".."
            && part
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '+'))
    })
}

pub fn parse_id(id: &str) -> Option<[String; 3]> {
    let mut parts = id.split(';');
    if parts.next()? != "system-images" {
        return None;
    }
    let folders = [parts.next()?, parts.next()?, parts.next()?];
    if parts.next().is_some()
        || !folders.iter().all(|folder| valid_segment(folder))
        || !folders[0].starts_with("android-")
    {
        return None;
    }
    Some(folders.map(str::to_owned))
}

fn parse_api_level(level: &str) -> Option<(u32, Option<u32>)> {
    let (major, minor) = match level.split_once('.') {
        Some((major, minor)) => (major, Some(minor.parse::<u32>().ok()?)),
        None => (level, None),
    };
    Some((major.parse().ok()?, minor.filter(|minor| *minor > 0)))
}

fn revision_of(xml: &str) -> Option<Revision> {
    let number = |name| text(xml, name).and_then(|value| value.parse().ok());
    Some(Revision::of(
        number("major")?,
        number("minor"),
        number("micro"),
    ))
}

pub fn local_revision(package_xml: &str) -> Option<Revision> {
    let package = first(package_xml, "localPackage")?;
    revision_of(first(package.inner, "revision")?.inner)
}

struct Archive {
    size: u64,
    sha1: String,
    url: String,
}

fn pick_archive(archives: &str, base_url: &str) -> Option<Archive> {
    let mut usable = elements(archives, "archive")
        .into_iter()
        .filter(|archive| text(archive.inner, "host-os").is_none_or(|os| os == HOST_OS));
    let archive = usable.next()?;
    if usable.next().is_some() {
        return None;
    }
    let complete = first(archive.inner, "complete")?;
    let checksum = first(complete.inner, "checksum")?;
    let sha1 = checksum.inner.trim().to_ascii_lowercase();
    let url = text(complete.inner, "url")?;
    if attr(checksum.attrs, "type")? != "sha1"
        || sha1.len() != 40
        || !sha1.chars().all(|c| c.is_ascii_hexdigit())
        || !valid_relative_url(&url)
    {
        return None;
    }
    Some(Archive {
        size: text(complete.inner, "size")?.parse().ok()?,
        sha1,
        url: format!("{base_url}{url}"),
    })
}

fn entry(package: &Element, stable: &str, abi: &str, base_url: &str) -> Option<Entry> {
    let id = attr(package.attrs, "path")?;
    let folders = parse_id(&id)?;
    let details = first(package.inner, "type-details")?;
    if first(details.inner, "codename").is_some()
        || text(details.inner, "base-extension").is_some_and(|base| base == "false")
        || attr(first(package.inner, "channelRef")?.attrs, "ref")? != stable
        || text(details.inner, "abi")? != abi
    {
        return None;
    }
    let (api_level, api_minor) = parse_api_level(&text(details.inner, "api-level")?)?;
    if api_level < MIN_API_LEVEL {
        return None;
    }
    let tags: Vec<(String, String)> = elements(details.inner, "tag")
        .into_iter()
        .filter_map(|tag| {
            let tag_id = text(tag.inner, "id")?;
            // Older catalog entries (API 24/25 `default`) ship an empty <display>.
            let display = text(tag.inner, "display")
                .filter(|display| !display.trim().is_empty())
                .unwrap_or_else(|| match tag_id.as_str() {
                    "default" => "Default Android System Image".to_owned(),
                    other => other.to_owned(),
                });
            Some((tag_id, display))
        })
        .collect();
    if tags.is_empty() || tags.iter().any(|(tag_id, _)| tag_id == PAGE_SIZE_TAG) {
        return None;
    }
    let license_id = attr(first(package.inner, "uses-license")?.attrs, "ref")?;
    if !valid_ident(&license_id) {
        return None;
    }
    let dependencies = first(package.inner, "dependencies");
    let min_emulator = dependencies.as_ref().and_then(|dependencies| {
        elements(dependencies.inner, "dependency")
            .into_iter()
            .find(|dependency| attr(dependency.attrs, "path").as_deref() == Some("emulator"))
            .and_then(|dependency| revision_of(first(dependency.inner, "min-revision")?.inner))
    });
    let archive = pick_archive(first(package.inner, "archives")?.inner, base_url)?;
    Some(Entry {
        id,
        folders,
        api_level,
        api_minor,
        extension_level: text(details.inner, "extension-level")
            .and_then(|level| level.parse().ok()),
        tags,
        abi: abi.to_owned(),
        revision: revision_of(first(package.inner, "revision")?.inner)?,
        display_name: text(package.inner, "display-name")?,
        size: archive.size,
        sha1: archive.sha1,
        url: archive.url,
        license_id,
        min_emulator,
        type_details: details.inner.to_owned(),
        dependencies: dependencies.map(|dependencies| dependencies.inner.to_owned()),
    })
}

pub fn parse(xml: &str, base_url: &str, abi: &str) -> Parsed {
    let stable = elements(xml, "channel")
        .into_iter()
        .find(|channel| channel.inner.trim() == "stable")
        .and_then(|channel| attr(channel.attrs, "id"))
        .unwrap_or_else(|| STABLE_FALLBACK.to_owned());
    let licenses: Vec<(String, String)> = elements(xml, "license")
        .into_iter()
        .filter_map(|license| {
            let id = attr(license.attrs, "id").filter(|id| valid_ident(id))?;
            Some((id, unescape(license.inner)))
        })
        .collect();
    let entries = elements(xml, "remotePackage")
        .iter()
        .filter_map(|package| entry(package, &stable, abi, base_url))
        .filter(|entry| licenses.iter().any(|(id, _)| *id == entry.license_id))
        .collect();
    Parsed { entries, licenses }
}

impl Entry {
    pub fn package_xml(&self, license: &str) -> String {
        let mut out = format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<ns2:repository {NAMESPACES}>\n    <license id=\"{}\" type=\"text\">{}</license>\n    <localPackage path=\"{}\" obsolete=\"false\">\n        <type-details xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\" xsi:type=\"ns16:sysImgDetailsType\">\n",
            self.license_id,
            escape(license),
            self.id,
        );
        reindent(&self.type_details, 3, &mut out);
        out.push_str("        </type-details>\n        <revision>\n");
        for (name, value) in REVISION_PARTS
            .iter()
            .zip(self.revision.parts)
            .take(self.revision.len)
        {
            out.push_str(&format!("            <{name}>{value}</{name}>\n"));
        }
        out.push_str(&format!(
            "        </revision>\n        <display-name>{}</display-name>\n        <uses-license ref=\"{}\"/>\n",
            escape(&self.display_name),
            self.license_id,
        ));
        if let Some(dependencies) = &self.dependencies {
            out.push_str("        <dependencies>\n");
            reindent(dependencies, 3, &mut out);
            out.push_str("        </dependencies>\n");
        }
        out.push_str("    </localPackage>\n</ns2:repository>\n");
        out
    }
}
