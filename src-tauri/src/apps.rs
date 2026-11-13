use std::path::PathBuf;
use std::time::Duration;

use serde::{Deserialize, Serialize, Serializer};
use tauri::ipc::{InvokeBody, Request};
use thiserror::Error;

use crate::adb::{self, AdbError, AdbServer, DeviceSel, MODE_FILE_0644, ShellOutput, shell_quote};
use crate::files::{self, FilesError};

const INSTALL_HEADER: &str = "x-tri-install";
const MAX_APK: u64 = 512 * 1024 * 1024;
const PUSH_TIMEOUT: Duration = Duration::from_secs(300);
const INSTALL_TIMEOUT: Duration = Duration::from_secs(300);
const COMMAND_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Error)]
pub enum AppsError {
    #[error("{0}")]
    Refused(String),
    #[error("{0}")]
    Device(String),
    #[error("{0} has no launcher activity")]
    NoLauncher(String),
    #[error("the device did not respond in time")]
    Timeout,
    #[error(transparent)]
    Adb(#[from] AdbError),
    #[error(transparent)]
    Files(#[from] FilesError),
    #[error("local file: {0}")]
    Io(#[from] std::io::Error),
}

impl Serialize for AppsError {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AppAction {
    Restart,
    ForceStop,
    ClearData,
}

#[derive(Deserialize)]
struct InstallMeta {
    serial: String,
    name: String,
}

fn check_apk(name: &str, len: u64) -> Result<(), AppsError> {
    if !name.to_ascii_lowercase().ends_with(".apk") {
        return Err(AppsError::Refused(format!("{name} isn't an .apk file")));
    }
    if len > MAX_APK {
        return Err(AppsError::Refused(format!(
            "{name} is larger than {} MiB",
            MAX_APK / (1024 * 1024)
        )));
    }
    Ok(())
}

async fn run(sel: &DeviceSel, cmd: &str) -> Result<ShellOutput, AppsError> {
    tokio::time::timeout(COMMAND_TIMEOUT, adb::shell(&AdbServer::default(), sel, cmd))
        .await
        .map_err(|_| AppsError::Timeout)?
        .map_err(AppsError::from)
}

async fn run_ok(sel: &DeviceSel, cmd: &str) -> Result<ShellOutput, AppsError> {
    let out = run(sel, cmd).await?;
    match out.exit_code {
        Some(0) => Ok(out),
        Some(_) => Err(AppsError::Device(files::output_text(
            &out.stderr,
            &out.stdout,
        ))),
        None => Err(AppsError::Device("the device disconnected".into())),
    }
}

fn install_failure(out: &ShellOutput) -> String {
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    stdout
        .lines()
        .chain(stderr.lines())
        .map(str::trim)
        .find(|line| line.starts_with("Failure"))
        .map_or_else(
            || files::output_text(&out.stderr, &out.stdout),
            str::to_owned,
        )
}

async fn stage_and_install(
    server: &AdbServer,
    sel: &DeviceSel,
    apk: &[u8],
    remote: &str,
) -> Result<(), AppsError> {
    tokio::time::timeout(
        PUSH_TIMEOUT,
        adb::push(server, sel, apk, remote, MODE_FILE_0644),
    )
    .await
    .map_err(|_| AppsError::Timeout)??;
    let cmd = format!("pm install -r -t -d {}", shell_quote(remote));
    let out = tokio::time::timeout(INSTALL_TIMEOUT, adb::shell(server, sel, &cmd))
        .await
        .map_err(|_| AppsError::Timeout)??;
    match out.exit_code {
        Some(0) if String::from_utf8_lossy(&out.stdout).contains("Success") => Ok(()),
        Some(_) => Err(AppsError::Device(install_failure(&out))),
        None => Err(AppsError::Device("the device disconnected".into())),
    }
}

async fn install(serial: &str, name: &str, apk: &[u8]) -> Result<String, AppsError> {
    let server = AdbServer::default();
    let sel = DeviceSel::Serial(serial.to_owned());
    let remote = format!(
        "/data/local/tmp/tri-scrnz-install-{:016x}.apk",
        rand::random::<u64>()
    );
    let result = stage_and_install(&server, &sel, apk, &remote).await;
    let cleanup = tokio::time::timeout(
        COMMAND_TIMEOUT,
        adb::shell(&server, &sel, &format!("rm -f {}", shell_quote(&remote))),
    )
    .await;
    if !matches!(cleanup, Ok(Ok(ref out)) if out.exit_code == Some(0)) {
        tracing::warn!(%serial, %remote, "could not remove the install staging file");
    }
    match &result {
        Ok(()) => tracing::info!(%serial, file = %name, bytes = apk.len(), "apk installed"),
        Err(e) => tracing::warn!(%serial, file = %name, "apk install failed: {e}"),
    }
    result.map(|()| format!("Installed {name}"))
}

#[tauri::command]
pub async fn install_apk_path(serial: String, local_path: String) -> Result<String, AppsError> {
    let local = PathBuf::from(&local_path);
    let meta = tokio::fs::metadata(&local).await?;
    if !meta.is_file() {
        return Err(AppsError::Refused(format!("{local_path} is not a file")));
    }
    let name = local
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| AppsError::Refused(format!("invalid file name {local_path}")))?
        .to_owned();
    check_apk(&name, meta.len())?;
    let apk = tokio::fs::read(&local).await?;
    install(&serial, &name, &apk).await
}

#[tauri::command]
pub async fn install_apk_bytes(request: Request<'_>) -> Result<String, AppsError> {
    let meta: InstallMeta = files::json_header(&request, INSTALL_HEADER)
        .ok_or_else(|| AppsError::Refused("missing or invalid install metadata".into()))?;
    let InvokeBody::Raw(apk) = request.body() else {
        return Err(AppsError::Refused(
            "the install body must be raw bytes".into(),
        ));
    };
    check_apk(&meta.name, apk.len() as u64)?;
    install(&meta.serial, &meta.name, apk).await
}

fn launcher_component(stdout: &str, package: &str) -> Result<String, AppsError> {
    let line = stdout
        .lines()
        .rev()
        .map(str::trim)
        .find(|line| line.contains('/'))
        .ok_or_else(|| AppsError::NoLauncher(package.to_owned()))?;
    let valid = line
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '$' | '/'));
    if valid {
        Ok(line.to_owned())
    } else {
        Err(AppsError::Device(format!(
            "unexpected launcher activity {line:?}"
        )))
    }
}

async fn perform(serial: &str, package: &str, action: AppAction) -> Result<String, AppsError> {
    let sel = DeviceSel::Serial(serial.to_owned());
    let quoted = shell_quote(package);
    match action {
        AppAction::ForceStop => {
            run_ok(&sel, &format!("am force-stop {quoted}")).await?;
            Ok(format!("Stopped {package}"))
        }
        AppAction::ClearData => {
            let out = run(&sel, &format!("pm clear {quoted}")).await?;
            if out.exit_code == Some(0) && String::from_utf8_lossy(&out.stdout).contains("Success")
            {
                Ok(format!("Cleared the data of {package}"))
            } else {
                Err(AppsError::Device(files::output_text(
                    &out.stderr,
                    &out.stdout,
                )))
            }
        }
        AppAction::Restart => {
            run_ok(&sel, &format!("am force-stop {quoted}")).await?;
            // Not run_ok: a package without a launcher must get the "no launcher" message whatever the exit code.
            let resolved = run(
                &sel,
                &format!(
                    "cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.LAUNCHER {quoted}"
                ),
            )
            .await?;
            let component =
                launcher_component(&String::from_utf8_lossy(&resolved.stdout), package)?;
            // `am start` can print "Error: ..." and still exit 0.
            let started = run_ok(&sel, &format!("am start -n {}", shell_quote(&component))).await?;
            if String::from_utf8_lossy(&started.stdout)
                .lines()
                .any(|line| line.trim_start().starts_with("Error"))
            {
                return Err(AppsError::Device(files::output_text(
                    &started.stderr,
                    &started.stdout,
                )));
            }
            Ok(format!("Restarted {package}"))
        }
    }
}

#[tauri::command]
pub async fn app_action(
    serial: String,
    package: String,
    action: AppAction,
) -> Result<String, AppsError> {
    let package = files::validate_package(package)?;
    let result = perform(&serial, &package, action).await;
    match &result {
        Ok(message) => tracing::info!(%serial, %package, ?action, "{message}"),
        Err(e) => tracing::warn!(%serial, %package, ?action, "app action failed: {e}"),
    }
    result
}
