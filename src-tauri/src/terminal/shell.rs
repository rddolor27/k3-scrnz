use std::path::PathBuf;

use portable_pty::CommandBuilder;
use serde::Serialize;

use super::TerminalError;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellInfo {
    pub id: String,
    pub label: String,
}

#[cfg(windows)]
#[derive(Clone, Copy)]
enum Flavor {
    PowerShell,
    GitBash,
    Cmd,
}

pub struct Shell {
    pub id: &'static str,
    label: String,
    program: PathBuf,
    #[cfg(windows)]
    flavor: Flavor,
}

impl Shell {
    pub fn command(&self, command: Option<&str>) -> Result<CommandBuilder, TerminalError> {
        let command = command.map(plain).transpose()?;
        Ok(self.build(command))
    }

    #[cfg(windows)]
    fn build(&self, command: Option<&str>) -> CommandBuilder {
        let mut cmd = CommandBuilder::new(&self.program);
        match self.flavor {
            Flavor::PowerShell => {
                cmd.arg("-NoLogo");
                if let Some(command) = command {
                    cmd.args(["-NoExit", "-Command", command]);
                }
            }
            Flavor::GitBash => {
                // The login profile cds to $HOME unless CHERE_INVOKING is set.
                cmd.env("CHERE_INVOKING", "1");
                cmd.args(["--login", "-i"]);
                if let Some(command) = command {
                    let script = format!("{command}; exec bash --login -i");
                    cmd.args(["-c", script.as_str()]);
                }
            }
            Flavor::Cmd => {
                if let Some(command) = command {
                    // /S makes cmd strip exactly the quotes put around the command.
                    cmd.args(["/S", "/K", command]);
                }
            }
        }
        cmd
    }

    #[cfg(not(windows))]
    fn build(&self, command: Option<&str>) -> CommandBuilder {
        let mut cmd = CommandBuilder::new(&self.program);
        if let Some(command) = command {
            let script = format!("{command}; exec \"$SHELL\" -i");
            cmd.args(["-c", script.as_str()]);
        } else {
            cmd.arg("-i");
        }
        cmd
    }
}

pub fn list() -> Vec<ShellInfo> {
    detect()
        .into_iter()
        .map(|shell| ShellInfo {
            id: shell.id.to_owned(),
            label: shell.label,
        })
        .collect()
}

pub fn resolve(id: Option<&str>) -> Result<Shell, TerminalError> {
    let mut shells = detect();
    if shells.is_empty() {
        return Err(TerminalError::Spawn(
            "no shell found on this machine".to_owned(),
        ));
    }
    let index = match id {
        None => 0,
        Some(id) => shells
            .iter()
            .position(|shell| shell.id == id)
            .unwrap_or_else(|| {
                tracing::warn!(
                    shell = id,
                    "unknown or missing terminal shell, using the default"
                );
                0
            }),
    };
    Ok(shells.swap_remove(index))
}

// run_command emits only these characters; anything else is refused rather than quoted per shell.
fn plain(command: &str) -> Result<&str, TerminalError> {
    let is_plain = command
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, ' ' | '.' | '_' | ':' | '-'));
    if is_plain {
        Ok(command)
    } else {
        Err(TerminalError::Spawn(format!(
            "the command needs shell quoting: {command}"
        )))
    }
}

#[cfg(windows)]
fn detect() -> Vec<Shell> {
    [
        (
            "pwsh",
            "PowerShell 7",
            Flavor::PowerShell,
            find_on_path("pwsh.exe"),
        ),
        (
            "powershell",
            "Windows PowerShell",
            Flavor::PowerShell,
            find_windows_powershell(),
        ),
        ("gitbash", "Git Bash", Flavor::GitBash, find_git_bash()),
        ("cmd", "Command Prompt", Flavor::Cmd, find_cmd()),
    ]
    .into_iter()
    .filter_map(|(id, label, flavor, program)| {
        Some(Shell {
            id,
            label: label.to_owned(),
            program: program?,
            flavor,
        })
    })
    .collect()
}

#[cfg(not(windows))]
fn detect() -> Vec<Shell> {
    let program = PathBuf::from(std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_owned()));
    let label = program.file_name().map_or_else(
        || "sh".to_owned(),
        |name| name.to_string_lossy().into_owned(),
    );
    vec![Shell {
        id: "sh",
        label,
        program,
    }]
}

#[cfg(windows)]
fn find_on_path(name: &str) -> Option<PathBuf> {
    let paths = std::env::var_os("PATH")?;
    std::env::split_paths(&paths)
        .map(|dir| dir.join(name))
        .find(|exe| exe.is_file())
}

#[cfg(windows)]
fn system32() -> Option<PathBuf> {
    let root = std::env::var_os("SystemRoot").or_else(|| std::env::var_os("windir"))?;
    Some(PathBuf::from(root).join("System32"))
}

#[cfg(windows)]
fn find_windows_powershell() -> Option<PathBuf> {
    system32()
        .map(|dir| {
            dir.join("WindowsPowerShell")
                .join("v1.0")
                .join("powershell.exe")
        })
        .filter(|exe| exe.is_file())
        .or_else(|| find_on_path("powershell.exe"))
}

#[cfg(windows)]
fn find_cmd() -> Option<PathBuf> {
    std::env::var_os("ComSpec")
        .map(PathBuf::from)
        .into_iter()
        .chain(system32().map(|dir| dir.join("cmd.exe")))
        .find(|exe| exe.is_file())
}

// System32\bash.exe is the WSL launcher, so bash is only taken from a Git for Windows root.
#[cfg(windows)]
fn find_git_bash() -> Option<PathBuf> {
    let beside_git = find_on_path("git.exe").and_then(|git| {
        git.parent()?
            .ancestors()
            .take(3)
            .map(|root| root.join("bin").join("bash.exe"))
            .find(|exe| exe.is_file())
    });
    beside_git.or_else(|| {
        ["ProgramFiles", "ProgramFiles(x86)"]
            .iter()
            .filter_map(std::env::var_os)
            .map(|dir| PathBuf::from(dir).join("Git"))
            .chain(
                std::env::var_os("LOCALAPPDATA")
                    .map(|dir| PathBuf::from(dir).join("Programs").join("Git")),
            )
            .map(|root| root.join("bin").join("bash.exe"))
            .find(|exe| exe.is_file())
    })
}
