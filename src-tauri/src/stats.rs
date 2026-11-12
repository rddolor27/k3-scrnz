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

impl Serialize for StatsError {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppStats {
    pub cpu_percent: f32,
    pub memory_bytes: u64,
    pub processes: u32,
    pub emulator_cpu_percent: f32,
    pub emulator_memory_bytes: u64,
}

fn is_emulator(name: &OsStr) -> bool {
    let name = name.to_string_lossy().to_ascii_lowercase();
    name.starts_with("emulator") || name.starts_with("qemu-system")
}

fn descendants(processes: &HashMap<Pid, Process>, roots: HashSet<Pid>) -> HashSet<Pid> {
    let mut tree = roots;
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

#[tauri::command]
pub async fn get_app_stats(state: State<'_, StatsState>) -> Result<AppStats, StatsError> {
    let Some(sampler) = state.sampler.as_ref().map(Arc::clone) else {
        return Err(StatsError::Unavailable(
            state.error.clone().unwrap_or_default(),
        ));
    };
    tokio::task::spawn_blocking(move || {
        sampler
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .sample()
    })
    .await
    .map_err(|e| StatsError::Task(e.to_string()))
}
