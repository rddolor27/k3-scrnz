use std::path::PathBuf;

use serde::Serialize;
use serde_json::Value;

use super::TerminalError;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ProjectKind {
    ReactNative,
    Expo,
    Other,
}

pub struct Project {
    pub path: PathBuf,
    pub name: String,
    pub kind: ProjectKind,
}

pub async fn inspect(path: PathBuf) -> Result<Project, TerminalError> {
    let not_a_folder = || TerminalError::NotAFolder(path.display().to_string());
    let meta = tokio::fs::metadata(&path)
        .await
        .map_err(|_| not_a_folder())?;
    if !meta.is_dir() {
        return Err(not_a_folder());
    }
    let manifest = match tokio::fs::read_to_string(path.join("package.json")).await {
        Ok(text) => Some(
            serde_json::from_str::<Value>(text.strip_prefix('\u{feff}').unwrap_or(&text))
                .map_err(|e| TerminalError::Manifest(e.to_string()))?,
        ),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(TerminalError::Manifest(e.to_string())),
    };
    let depends_on = |name: &str| {
        manifest.as_ref().is_some_and(|m| {
            ["dependencies", "devDependencies"]
                .iter()
                .any(|section| m.get(section).and_then(|deps| deps.get(name)).is_some())
        })
    };
    let kind = match (depends_on("react-native"), depends_on("expo")) {
        (true, true) => ProjectKind::Expo,
        (true, false) => ProjectKind::ReactNative,
        (false, _) => ProjectKind::Other,
    };
    let name = manifest
        .as_ref()
        .and_then(|m| m.get("name"))
        .and_then(Value::as_str)
        .map(str::to_owned)
        .or_else(|| {
            path.file_name()
                .map(|name| name.to_string_lossy().into_owned())
        })
        .unwrap_or_else(|| path.display().to_string());
    Ok(Project { path, name, kind })
}

/// `serial` passed `is_valid_serial`, so it needs no quoting.
pub fn run_command(kind: ProjectKind, serial: &str) -> Option<String> {
    match kind {
        ProjectKind::ReactNative => {
            Some(format!("npx react-native run-android --deviceId {serial}"))
        }
        ProjectKind::Expo => Some(format!("npx expo run:android --device {serial}")),
        ProjectKind::Other => None,
    }
}
