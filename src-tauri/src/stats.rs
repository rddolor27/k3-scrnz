//! CPU and RAM of the app for the status bar (SPEC section 11): this process
//! plus everything it spawned, which is where WebView2 decodes and renders.

use std::collections::HashSet;
use std::sync::{Arc, Mutex, PoisonError};

use serde::{Serialize, Serializer};
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
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
    /// The app process and its descendants.
    pub processes: u32,
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
        // exe → WebView2 browser → GPU/renderer/utility: a few passes suffice.
        let mut tree = HashSet::from([self.root]);
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
                break;
            }
        }
        let mut cpu = 0.0_f32;
        let mut memory = 0_u64;
        let mut count = 0_u32;
        for process in tree.iter().filter_map(|pid| processes.get(pid)) {
            cpu += process.cpu_usage();
            memory += process.memory();
            count += 1;
        }
        AppStats {
            cpu_percent: cpu / self.cpus,
            memory_bytes: memory,
            processes: count,
        }
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
