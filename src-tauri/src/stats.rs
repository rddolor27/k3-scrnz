//! CPU and RAM of the app for the status bar (SPEC section 11): this process
//! plus everything it spawned, which is where WebView2 decodes and renders.

use std::collections::{HashMap, HashSet};
use std::ffi::OsStr;
use std::sync::{Arc, Mutex, PoisonError};

use serde::{Serialize, Serializer};
use sysinfo::{Pid, Process, ProcessRefreshKind, ProcessesToUpdate, System};
use tauri::State;

#[derive(Debug, thiserror::Error)]
pub enum StatsError {
    #[error("process stats are unavailable: {0}")]
    Unavailable(String),
    #[error("the stats task failed: {0}")]
    Task(String),
}

/// Tauri sends command errors to the UI as their message.
impl Serialize for StatsError {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppStats {
    /// Share of the whole machine (all logical CPUs), 0–100. The first sample
    /// reads 0: CPU usage is a difference between two refreshes.
    pub cpu_percent: f32,
    /// Summed working sets (WebView2's processes share some pages, so this
    /// is an upper bound).
    pub memory_bytes: u64,
    /// The app process and its WebView2 descendants.
    pub processes: u32,
    /// Emulators this app started are its children too, but counted here
    /// instead (a booted AVD alone takes 1–3 GB).
    pub emulator_cpu_percent: f32,
    pub emulator_memory_bytes: u64,
}

/// `emulator.exe` and the `qemu-system-*` it runs.
fn is_emulator(name: &OsStr) -> bool {
    let name = name.to_string_lossy().to_ascii_lowercase();
    name.starts_with("emulator") || name.starts_with("qemu-system")
}

/// `roots` plus every process below them.
fn descendants(processes: &HashMap<Pid, Process>, roots: HashSet<Pid>) -> HashSet<Pid> {
    let mut tree = roots;
    // exe → WebView2 browser → GPU/renderer/utility: a few passes suffice.
    loop {
        let before = tree.len();
        for (pid, process) in processes {
            if process
                .parent()
                .is_some_and(|parent| tree.contains(&parent))
            {
                tree.insert(*pid);
            }
        }
        if tree.len() == before {
            return tree;
        }
    }
}

struct Sampler {
    system: System,
    root: Pid,
    cpus: f32,
}

impl Sampler {
    fn sample(&mut self) -> AppStats {
        self.system.refresh_processes_specifics(
            ProcessesToUpdate::All,
            true,
            ProcessRefreshKind::nothing().with_cpu().with_memory(),
        );
        let processes = self.system.processes();
        let tree = descendants(processes, HashSet::from([self.root]));
        let emulator_roots: HashSet<Pid> = tree
            .iter()
            .filter(|pid| processes.get(pid).is_some_and(|p| is_emulator(p.name())))
            .copied()
            .collect();
        let emulators = descendants(processes, emulator_roots);
        let (mut app, mut emulator) = (Usage::default(), Usage::default());
        for pid in &tree {
            if let Some(process) = processes.get(pid) {
                let usage = if emulators.contains(pid) {
                    &mut emulator
                } else {
                    &mut app
                };
                usage.add(process);
            }
        }
        AppStats {
            cpu_percent: app.cpu / self.cpus,
            memory_bytes: app.memory,
            processes: app.count,
            emulator_cpu_percent: emulator.cpu / self.cpus,
            emulator_memory_bytes: emulator.memory,
        }
    }
}

#[derive(Default)]
struct Usage {
    cpu: f32,
    memory: u64,
    count: u32,
}

impl Usage {
    fn add(&mut self, process: &Process) {
        self.cpu += process.cpu_usage();
        self.memory += process.memory();
        self.count += 1;
    }
}

pub struct StatsState {
    sampler: Option<Arc<Mutex<Sampler>>>,
    error: Option<String>,
}

impl StatsState {
    pub fn new() -> Self {
        let built =
            sysinfo::get_current_pid().and_then(|root| System::new().map(|system| (root, system)));
        match built {
            Ok((root, system)) => {
                let cpus = std::thread::available_parallelism().map_or(1, |n| n.get());
                Self {
                    sampler: Some(Arc::new(Mutex::new(Sampler {
                        system,
                        root,
                        cpus: cpus as f32,
                    }))),
                    error: None,
                }
            }
            Err(e) => {
                tracing::warn!(error = %e, "process stats unavailable");
                Self {
                    sampler: None,
                    error: Some(e.to_string()),
                }
            }
        }
    }
}

/// Polled by the status bar every 2 s while the window is visible.
#[tauri::command]
pub async fn get_app_stats(state: State<'_, StatsState>) -> Result<AppStats, StatsError> {
    let Some(sampler) = state.sampler.as_ref().map(Arc::clone) else {
        return Err(StatsError::Unavailable(
            state.error.clone().unwrap_or_default(),
        ));
    };
    // Refreshing every process is a blocking system call.
    tokio::task::spawn_blocking(move || {
        sampler
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .sample()
    })
    .await
    .map_err(|e| StatsError::Task(e.to_string()))
}
