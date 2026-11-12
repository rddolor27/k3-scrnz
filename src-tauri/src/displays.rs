use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Arc, LazyLock, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use regex::{Captures, Regex};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use thiserror::Error;
use tokio::sync::{Mutex as AsyncMutex, Notify};

use crate::adb::{self, AdbError, AdbServer, DeviceSel, DeviceState};
use crate::devices::{DeviceHub, DeviceView};

const POLL_EVERY: Duration = Duration::from_secs(5);
const WATCH_EVERY: Duration = Duration::from_secs(1);
const POLL_TIMEOUT: Duration = Duration::from_secs(10);
/// Polls closer together than this are one observation, so two identical
/// answers milliseconds apart can't defeat the debounce.
const MIN_POLL_GAP: Duration = Duration::from_secs(1);

#[derive(Debug, Error)]
pub enum DisplaysError {
    #[error("dumpsys display exited with {code}: {detail}")]
    Failed { code: u8, detail: String },
    #[error("the device disconnected")]
    Disconnected,
    #[error("dumpsys display did not answer in time")]
    Timeout,
    #[error("display pattern: {0}")]
    Pattern(String),
    #[error(transparent)]
    Adb(#[from] AdbError),
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DisplayInfo {
    pub id: u32,
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub state: String,
    pub kind: String,
    pub unique_id: Option<String>,
    pub owner: Option<String>,
    pub flags: Vec<String>,
    pub touch: Option<String>,
    pub customer: bool,
}

#[derive(Clone, Serialize)]
struct DisplaysChanged<'a> {
    serial: &'a str,
    displays: &'a [DisplayInfo],
}

struct Patterns {
    logical: Regex,
    device: Regex,
    real: Regex,
    state: Regex,
    kind: Regex,
    unique_id: Regex,
    owner: Regex,
    flag: Regex,
}

impl Patterns {
    fn compile() -> Result<Self, regex::Error> {
        Ok(Self {
            logical: Regex::new(
                r#"mBaseDisplayInfo=DisplayInfo\{"(?P<name>[^"]*)", displayId (?P<id>\d+)"#,
            )?,
            device: Regex::new(
                r#"DisplayDeviceInfo\{"[^"]*": uniqueId="(?P<uid>[^"]+)".*?touch (?P<touch>[A-Z]+)"#,
            )?,
            real: Regex::new(r"\breal (?P<w>\d+) x (?P<h>\d+)")?,
            state: Regex::new(r"\bstate (?P<state>[A-Z_]+)")?,
            kind: Regex::new(r"\btype (?P<type>[A-Z_]+)")?,
            unique_id: Regex::new(r#"\buniqueId "(?P<uid>[^"]+)""#)?,
            owner: Regex::new(r"\bowner (?P<owner>\S+)")?,
            flag: Regex::new(r"FLAG_[A-Z_]+")?,
        })
    }
}

static PATTERNS: LazyLock<Result<Patterns, regex::Error>> = LazyLock::new(Patterns::compile);

fn group<'h>(caps: &Captures<'h>, name: &str) -> Option<&'h str> {
    caps.name(name).map(|m| m.as_str())
}

fn is_customer(id: u32, name: &str, state: &str, owner: Option<&str>, flags: &[String]) -> bool {
    id != 0
        && flags.iter().any(|f| f == "FLAG_PRESENTATION")
        && state == "ON"
        && !name.starts_with("scrcpy")
        && !name.starts_with("studio.screen.sharing")
        && owner != Some("com.android.shell")
}

fn parse_logical(p: &Patterns, line: &str) -> Option<DisplayInfo> {
    let head = p.logical.captures(line)?;
    let id: u32 = group(&head, "id")?.parse().ok()?;
    let name = group(&head, "name")?.to_owned();
    let rest = &line[head.get(0)?.end()..];

    let (width, height): (u32, u32) = p
        .real
        .captures(rest)
        .and_then(|c| Some((group(&c, "w")?.parse().ok()?, group(&c, "h")?.parse().ok()?)))
        .unwrap_or_default();
    let field = |re: &Regex, name: &str| {
        re.captures(rest)
            .and_then(|c| group(&c, name))
            .map(str::to_owned)
    };
    let state = field(&p.state, "state").unwrap_or_else(|| "UNKNOWN".into());
    let kind = field(&p.kind, "type").unwrap_or_else(|| "UNKNOWN".into());
    let unique_id = field(&p.unique_id, "uid");
    let owner = field(&p.owner, "owner");
    let flags: Vec<String> = p
        .flag
        .find_iter(rest)
        .map(|m| m.as_str().to_owned())
        .collect();
    let customer = is_customer(id, &name, &state, owner.as_deref(), &flags);
    Some(DisplayInfo {
        id,
        name,
        width,
        height,
        state,
        kind,
        unique_id,
        owner,
        flags,
        touch: None,
        customer,
    })
}

pub fn parse_displays(text: &str) -> Result<Vec<DisplayInfo>, DisplaysError> {
    let p = PATTERNS
        .as_ref()
        .map_err(|e| DisplaysError::Pattern(e.to_string()))?;
    let mut touch_by_uid: HashMap<&str, &str> = HashMap::new();
    let mut displays: BTreeMap<u32, DisplayInfo> = BTreeMap::new();
    for line in text.lines() {
        if let Some(caps) = p.device.captures(line) {
            if let (Some(uid), Some(touch)) = (group(&caps, "uid"), group(&caps, "touch")) {
                touch_by_uid.entry(uid).or_insert(touch);
            }
        } else if let Some(display) = parse_logical(p, line) {
            displays.entry(display.id).or_insert(display);
        }
    }
    for display in displays.values_mut() {
        display.touch = display
            .unique_id
            .as_deref()
            .and_then(|uid| touch_by_uid.get(uid))
            .map(|touch| (*touch).to_owned());
    }
    Ok(displays.into_values().collect())
}

/// Both lists are sorted by id.
fn same_view(a: &[DisplayInfo], b: &[DisplayInfo]) -> bool {
    a.len() == b.len()
        && a.iter().zip(b).all(|(x, y)| {
            x.id == y.id
                && x.width == y.width
                && x.height == y.height
                && x.state == y.state
                && x.kind == y.kind
                && x.customer == y.customer
        })
}

#[derive(Default)]
struct DeviceDisplays {
    confirmed: Option<Vec<DisplayInfo>>,
    pending: Option<Vec<DisplayInfo>>,
    last_ok: Option<Instant>,
    failing: bool,
}

impl DeviceDisplays {
    fn observe(&mut self, polled: Vec<DisplayInfo>) -> bool {
        if let Some(confirmed) = &self.confirmed {
            if same_view(confirmed, &polled) {
                self.pending = None;
                return false;
            }
            let seen_twice = self
                .pending
                .as_deref()
                .is_some_and(|pending| same_view(pending, &polled));
            if !seen_twice {
                self.pending = Some(polled);
                return false;
            }
        }
        self.confirmed = Some(polled);
        self.pending = None;
        true
    }

    fn polled_within(&self, gap: Duration) -> bool {
        self.last_ok.is_some_and(|at| at.elapsed() < gap)
    }
}

type Slot = Arc<AsyncMutex<DeviceDisplays>>;

pub struct DisplayHub {
    app: AppHandle,
    devices: Arc<DeviceHub>,
    /// The async mutex is held across the `dumpsys` call so a device's events
    /// stay in order.
    slots: Mutex<HashMap<String, Slot>>,
    visible: Mutex<Option<String>>,
    visible_changed: Notify,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn is_online(device: &DeviceView) -> bool {
    device.state == DeviceState::Device && !device.gone
}

impl DisplayHub {
    pub fn new(app: AppHandle, devices: Arc<DeviceHub>) -> Self {
        Self {
            app,
            devices,
            slots: Mutex::new(HashMap::new()),
            visible: Mutex::new(None),
            visible_changed: Notify::new(),
        }
    }

    fn slot(&self, serial: &str) -> Slot {
        Arc::clone(lock(&self.slots).entry(serial.to_owned()).or_default())
    }

    fn forget_unlisted(&self, views: &[DeviceView]) {
        let listed: HashSet<&str> = views.iter().map(|d| d.serial.as_str()).collect();
        lock(&self.slots).retain(|serial, _| listed.contains(serial.as_str()));
    }

    fn set_visible(&self, serial: Option<String>) {
        tracing::debug!(serial = ?serial, "visible device set");
        *lock(&self.visible) = serial;
        self.visible_changed.notify_one();
    }

    fn visible_online(&self) -> Option<String> {
        let serial = lock(&self.visible).clone()?;
        self.devices
            .views()
            .iter()
            .any(|d| d.serial == serial && is_online(d))
            .then_some(serial)
    }

    fn emit(&self, serial: &str, displays: &[DisplayInfo]) {
        let customers: Vec<u32> = displays
            .iter()
            .filter(|d| d.customer)
            .map(|d| d.id)
            .collect();
        tracing::info!(%serial, displays = displays.len(), ?customers, "displays changed");
        if let Err(e) = self
            .app
            .emit("displays-changed", DisplaysChanged { serial, displays })
        {
            tracing::warn!(%serial, "can't emit displays-changed: {e}");
        }
    }

    async fn poll(&self, serial: &str, state: &mut DeviceDisplays) -> Result<(), DisplaysError> {
        let polled = fetch(serial).await?;
        state.last_ok = Some(Instant::now());
        if state.observe(polled) {
            self.emit(serial, state.confirmed.as_deref().unwrap_or_default());
        }
        Ok(())
    }

    fn spawn_poll(self: &Arc<Self>, serial: String) {
        let hub = Arc::clone(self);
        tauri::async_runtime::spawn(async move { hub.poll_background(&serial).await });
    }

    /// Skipped while this device is already being polled: a hung device must
    /// not pile up tasks.
    async fn poll_background(&self, serial: &str) {
        let slot = self.slot(serial);
        let Ok(mut state) = slot.try_lock() else {
            tracing::debug!(%serial, "display poll already running");
            return;
        };
        if state.polled_within(MIN_POLL_GAP) {
            return;
        }
        match self.poll(serial, &mut state).await {
            Ok(()) => {
                if std::mem::take(&mut state.failing) {
                    tracing::info!(%serial, "dumpsys display works again");
                }
            }
            Err(e) if !std::mem::replace(&mut state.failing, true) => {
                tracing::warn!(%serial, "dumpsys display failed: {e}");
            }
            Err(e) => tracing::debug!(%serial, "dumpsys display still failing: {e}"),
        }
    }
}

async fn fetch(serial: &str) -> Result<Vec<DisplayInfo>, DisplaysError> {
    let sel = DeviceSel::Serial(serial.to_owned());
    let out = tokio::time::timeout(
        POLL_TIMEOUT,
        adb::shell(&AdbServer::default(), &sel, "dumpsys display"),
    )
    .await
    .map_err(|_| DisplaysError::Timeout)??;
    match out.exit_code {
        Some(0) => parse_displays(&String::from_utf8_lossy(&out.stdout)),
        Some(code) => Err(DisplaysError::Failed {
            code,
            detail: String::from_utf8_lossy(&out.stderr).trim().to_owned(),
        }),
        None => Err(DisplaysError::Disconnected),
    }
}

pub fn start(hub: Arc<DisplayHub>) {
    tauri::async_runtime::spawn(async move {
        tracing::info!("display polling started");
        let mut watch = tokio::time::interval(WATCH_EVERY);
        let mut tick = tokio::time::interval(POLL_EVERY);
        let mut online: HashSet<String> = HashSet::new();
        loop {
            tokio::select! {
                _ = watch.tick() => {
                    let views = hub.devices.views();
                    hub.forget_unlisted(&views);
                    let now_online: HashSet<String> = views
                        .iter()
                        .filter(|d| is_online(d))
                        .map(|d| d.serial.clone())
                        .collect();
                    for serial in now_online.difference(&online) {
                        tracing::debug!(%serial, "device online; polling displays");
                        hub.spawn_poll(serial.clone());
                    }
                    online = now_online;
                }
                _ = tick.tick() => {
                    if let Some(serial) = hub.visible_online() {
                        hub.spawn_poll(serial);
                    }
                }
                _ = hub.visible_changed.notified() => {
                    tick.reset();
                    if let Some(serial) = hub.visible_online() {
                        hub.spawn_poll(serial);
                    }
                }
            }
        }
    });
}

#[tauri::command]
pub async fn get_displays(
    hub: State<'_, Arc<DisplayHub>>,
    serial: String,
) -> Result<Vec<DisplayInfo>, String> {
    let slot = hub.slot(&serial);
    let mut state = slot.lock().await;
    if !state.polled_within(MIN_POLL_GAP) {
        hub.poll(&serial, &mut state)
            .await
            .map_err(|e| e.to_string())?;
    }
    Ok(state.confirmed.clone().unwrap_or_default())
}

#[tauri::command]
pub fn set_visible_device(hub: State<'_, Arc<DisplayHub>>, serial: Option<String>) {
    hub.set_visible(serial);
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = include_str!("../tests/fixtures/gemini-dumpsys-display.txt");

    #[test]
    fn parses_the_gemini_sample() {
        let displays = parse_displays(SAMPLE).unwrap();
        let ids: Vec<u32> = displays.iter().map(|d| d.id).collect();
        assert_eq!(ids, [0, 2]);

        let main = &displays[0];
        assert_eq!(main.name, "Built-in Screen");
        assert_eq!((main.width, main.height), (1920, 1080));
        assert_eq!(
            (main.state.as_str(), main.kind.as_str()),
            ("ON", "INTERNAL")
        );
        assert_eq!(main.touch.as_deref(), Some("INTERNAL"));
        assert!(!main.customer);

        let second = &displays[1];
        assert_eq!(second.name, "SecondDisplay");
        assert_eq!((second.width, second.height), (1280, 800));
        assert_eq!(
            (second.state.as_str(), second.kind.as_str()),
            ("ON", "VIRTUAL")
        );
        assert_eq!(
            second.unique_id.as_deref(),
            Some("virtual:com.android.systemui,10134,SecondDisplay,0")
        );
        assert_eq!(second.owner.as_deref(), Some("com.android.systemui"));
        assert_eq!(
            second.flags,
            ["FLAG_SECURE", "FLAG_PRESENTATION", "FLAG_TRUSTED"]
        );
        assert_eq!(second.touch.as_deref(), Some("NONE"));
        assert!(second.customer);
    }

    #[test]
    fn mirroring_displays_are_not_customer_screens() {
        let line = |id: u32, name: &str, owner: &str| {
            format!(
                r#"    mBaseDisplayInfo=DisplayInfo{{"{name}", displayId {id}", displayGroupId 0, FLAG_PRESENTATION, real 1280 x 800, state ON, type VIRTUAL, uniqueId "virtual:{name},{id}", owner {owner} (uid 2000), removeMode 0}}"#
            )
        };
        let text = [
            line(2, "SecondDisplay", "com.android.systemui"),
            line(3, "scrcpy", "com.android.systemui"),
            line(4, "studio.screen.sharing", "com.android.systemui"),
            line(5, "Mirror", "com.android.shell"),
        ]
        .join("\n");
        let customers: Vec<u32> = parse_displays(&text)
            .unwrap()
            .iter()
            .filter(|d| d.customer)
            .map(|d| d.id)
            .collect();
        assert_eq!(customers, [2]);
    }

    #[test]
    fn a_changed_list_is_confirmed_on_the_second_identical_poll() {
        let with_customer = parse_displays(SAMPLE).unwrap();
        let mut without_customer = with_customer.clone();
        without_customer.retain(|d| !d.customer);

        let mut state = DeviceDisplays::default();
        // The first result is accepted directly.
        assert!(state.observe(with_customer.clone()));
        assert!(!state.observe(with_customer.clone()));

        // A change needs two polls in a row; the confirmed list holds meanwhile.
        assert!(!state.observe(without_customer.clone()));
        assert_eq!(state.confirmed.as_ref(), Some(&with_customer));
        assert!(state.observe(without_customer.clone()));
        assert_eq!(state.confirmed.as_ref(), Some(&without_customer));

        // A flap back to the confirmed list clears the pending change.
        assert!(!state.observe(with_customer.clone()));
        assert!(!state.observe(without_customer.clone()));
        assert!(!state.observe(with_customer.clone()));
        assert!(state.observe(with_customer.clone()));
        assert_eq!(state.confirmed.as_ref(), Some(&with_customer));
    }
}
