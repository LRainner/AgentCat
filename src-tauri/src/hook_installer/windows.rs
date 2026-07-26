use base64::Engine;
use serde_json::{Map, Value};
use std::path::Path;

const POWERSHELL_ENCODED_PREFIX: &str =
    "powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ";

pub(super) fn build_hook_command(executable: &Path) -> String {
    let script = format!(
        "try {{ & {} hook --agent codex > $null 2>&1 }} catch {{}}; exit 0",
        powershell_quote(&executable.to_string_lossy())
    );
    let bytes: Vec<u8> = script
        .encode_utf16()
        .flat_map(|unit| unit.to_le_bytes())
        .collect();
    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
    format!("{POWERSHELL_ENCODED_PREFIX}{encoded}")
}

pub(super) fn add_platform_fields(handler: &mut Map<String, Value>, command: &str) {
    handler.insert("commandWindows".into(), command.into());
}

pub(super) fn is_encoded_agent_cat_command(command: &str) -> bool {
    let Some(script) = decode_hook_command(command) else {
        return false;
    };
    let lower = script.to_ascii_lowercase();
    lower.contains("agent-cat.exe") && lower.contains("hook --agent codex")
}

fn decode_hook_command(command: &str) -> Option<String> {
    let encoded = command.strip_prefix(POWERSHELL_ENCODED_PREFIX)?;
    if encoded.len() > 64 * 1024 {
        return None;
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .ok()?;
    let mut chunks = bytes.chunks_exact(2);
    let units: Vec<u16> = chunks
        .by_ref()
        .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
        .collect();
    if !chunks.remainder().is_empty() {
        return None;
    }
    String::from_utf16(&units).ok()
}

fn powershell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hook_installer::{
        add_agent_cat_entries, command_handler, event_contains_agent_cat, remove_agent_cat_entries,
        EVENTS,
    };
    use serde_json::json;

    const HOOK_TEST_PAYLOAD: &[u8] = br#"{"hook_event_name":"UserPromptSubmit","prompt":"hello"}"#;

    #[test]
    fn hook_command_uses_windows_redirection_and_quotes() {
        let command = build_hook_command(Path::new(r"C:\Program Files\Agent Cat\agent-cat.exe"));
        assert_eq!(
            decode_hook_command(&command).unwrap(),
            r#"try { & 'C:\Program Files\Agent Cat\agent-cat.exe' hook --agent codex > $null 2>&1 } catch {}; exit 0"#
        );
    }

    fn run_hook_command(
        shell: &str,
        shell_args: &[&str],
        executable: &Path,
        output_path: Option<&Path>,
    ) -> std::process::ExitStatus {
        use std::io::Write;
        use std::process::Stdio;

        let command = build_hook_command(executable);
        let mut process = std::process::Command::new(shell);
        process.args(shell_args).arg(&command).stdin(Stdio::piped());
        if let Some(path) = output_path {
            process.env("AGENT_CAT_HOOK_TEST_OUTPUT", path);
        }
        let mut child = process.spawn().unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(HOOK_TEST_PAYLOAD)
            .unwrap();
        child.wait().unwrap()
    }

    #[test]
    fn hook_command_always_exits_successfully_in_supported_shells() {
        for (shell, shell_args) in [
            ("cmd.exe", &["/D", "/S", "/C"][..]),
            ("powershell.exe", &["-NoLogo", "-NoProfile", "-Command"][..]),
        ] {
            let status =
                run_hook_command(shell, shell_args, &std::env::current_exe().unwrap(), None);
            assert!(status.success(), "existing executable failed in {shell}");

            let status = run_hook_command(
                shell,
                shell_args,
                Path::new(r"C:\this-path-must-not-exist\agent-cat.exe"),
                None,
            );
            assert!(status.success(), "missing executable failed in {shell}");
        }
    }

    #[test]
    fn hook_command_preserves_stdin_in_supported_shells() {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "agent-cat-hook-stdin-{}-{unique}",
            std::process::id()
        ));
        std::fs::create_dir(&root).unwrap();
        let relay = root.join("relay.cmd");
        let output = root.join("payload.json");
        std::fs::write(&relay, b"@more > \"%AGENT_CAT_HOOK_TEST_OUTPUT%\"\r\n").unwrap();

        for (shell, shell_args) in [
            ("cmd.exe", &["/D", "/S", "/C"][..]),
            ("powershell.exe", &["-NoLogo", "-NoProfile", "-Command"][..]),
        ] {
            if output.exists() {
                std::fs::remove_file(&output).unwrap();
            }
            let status = run_hook_command(shell, shell_args, &relay, Some(output.as_path()));
            assert!(status.success(), "stdin relay failed in {shell}");
            let actual: Value = serde_json::from_slice(&std::fs::read(&output).unwrap()).unwrap();
            let expected: Value = serde_json::from_slice(HOOK_TEST_PAYLOAD).unwrap();
            assert_eq!(actual, expected);
        }

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn hook_handler_uses_the_windows_override() {
        let command = build_hook_command(Path::new(r"C:\Agent Cat\agent-cat.exe"));
        let handler = command_handler(&command);
        assert_eq!(
            handler.get("command").and_then(Value::as_str),
            Some(&*command)
        );
        assert_eq!(
            handler.get("commandWindows").and_then(Value::as_str),
            Some(&*command)
        );
        assert!(super::super::is_agent_cat_command(&handler));
    }

    #[test]
    fn encoded_hook_install_is_idempotent_and_removable() {
        let mut root = json!({});
        let command = build_hook_command(Path::new(r"C:\Agent Cat\agent-cat.exe"));
        add_agent_cat_entries(&mut root, &command).unwrap();
        add_agent_cat_entries(&mut root, &command).unwrap();
        assert_eq!(
            EVENTS
                .iter()
                .filter(|event| event_contains_agent_cat(&root, event))
                .count(),
            EVENTS.len()
        );

        remove_agent_cat_entries(&mut root);
        assert!(EVENTS
            .iter()
            .all(|event| !event_contains_agent_cat(&root, event)));
    }
}
