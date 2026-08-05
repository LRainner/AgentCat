use super::{TranscriptTerminal, TranscriptTerminalKind};
use serde::Deserialize;
use serde_json::Value;
use std::{
    ffi::OsStr,
    fs,
    path::{Path, PathBuf},
};

const INTERRUPTED_MARKER: &[u8] = b"Request interrupted by user";
const TURN_DURATION_MARKER: &[u8] = b"turn_duration";
const MAX_SESSION_FILE_BYTES: u64 = 16 * 1024;

#[derive(Debug, PartialEq, Eq)]
pub(super) enum SessionActivity {
    Active,
    Idle { status_updated_at: u64 },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionFile {
    session_id: String,
    status: String,
    #[serde(default)]
    status_updated_at: u64,
    #[serde(default)]
    updated_at: u64,
}

pub(super) fn terminal(
    line: &[u8],
    session_id: &str,
    active_turn_id: Option<&str>,
) -> Option<TranscriptTerminal> {
    let may_be_interrupted = line
        .windows(INTERRUPTED_MARKER.len())
        .any(|window| window == INTERRUPTED_MARKER);
    let may_be_completed = line
        .windows(TURN_DURATION_MARKER.len())
        .any(|window| window == TURN_DURATION_MARKER);
    if !may_be_interrupted && !may_be_completed {
        return None;
    }
    let line: Value = serde_json::from_slice(line).ok()?;
    let transcript_session_id = line
        .get("sessionId")
        .and_then(Value::as_str)
        .or_else(|| line.get("session_id").and_then(Value::as_str))?;
    if transcript_session_id != session_id {
        return None;
    }
    if may_be_completed
        && line.get("type").and_then(Value::as_str) == Some("system")
        && line.get("subtype").and_then(Value::as_str) == Some("turn_duration")
    {
        return Some(TranscriptTerminal {
            kind: TranscriptTerminalKind::Completed,
            turn_id: active_turn_id.map(str::to_string),
        });
    }
    if line.get("type").and_then(Value::as_str) != Some("user")
        || line.get("isSidechain").and_then(Value::as_bool) == Some(true)
        || line.get("promptSource").and_then(Value::as_str).is_some()
        || line
            .get("origin")
            .and_then(|origin| origin.get("kind"))
            .and_then(Value::as_str)
            == Some("human")
    {
        return None;
    }
    let message = line.get("message")?;
    if message.get("role").and_then(Value::as_str) != Some("user") {
        return None;
    }
    let content = message.get("content")?;
    let interrupted = content.as_str().is_some_and(is_interruption_text)
        || content.as_array().is_some_and(|blocks| {
            blocks.iter().any(|block| {
                block.get("type").and_then(Value::as_str) == Some("text")
                    && block
                        .get("text")
                        .and_then(Value::as_str)
                        .is_some_and(is_interruption_text)
            })
        });
    interrupted.then(|| TranscriptTerminal {
        kind: TranscriptTerminalKind::Interrupted,
        turn_id: active_turn_id.map(str::to_string),
    })
}

fn is_interruption_text(text: &str) -> bool {
    matches!(
        text,
        "[Request interrupted by user]" | "[Request interrupted by user for tool use]"
    )
}

pub(super) fn validate_path(path: &Path, session_id: &str, config_root: &Path) -> Option<PathBuf> {
    if !path.is_absolute() || path.extension() != Some(OsStr::new("jsonl")) {
        return None;
    }
    let canonical = path.canonicalize().ok()?;
    if !canonical.metadata().ok()?.is_file()
        || canonical.file_name()?.to_string_lossy() != format!("{session_id}.jsonl")
    {
        return None;
    }
    let projects_root = config_root.join("projects").canonicalize().ok()?;
    canonical.starts_with(projects_root).then_some(canonical)
}

pub(super) fn find_session_path(config_root: &Path, session_id: &str) -> Option<PathBuf> {
    let sessions_root = config_root.join("sessions").canonicalize().ok()?;
    let mut latest: Option<(u64, PathBuf)> = None;
    for item in fs::read_dir(&sessions_root).ok()?.take(128) {
        let Ok(item) = item else { continue };
        let path = item.path();
        let Some(file_name) = path.file_name() else {
            continue;
        };
        let file_name = file_name.to_string_lossy();
        let Some(pid) = file_name.strip_suffix(".json") else {
            continue;
        };
        if pid.is_empty() || !pid.bytes().all(|byte| byte.is_ascii_digit()) {
            continue;
        }
        let Ok(canonical) = path.canonicalize() else {
            continue;
        };
        if !canonical.starts_with(&sessions_root) {
            continue;
        }
        let Some(state) = read_session_file(&canonical) else {
            continue;
        };
        if state.session_id != session_id {
            continue;
        }
        let updated_at = state.status_updated_at.max(state.updated_at);
        if latest
            .as_ref()
            .is_none_or(|(latest_at, _)| updated_at > *latest_at)
        {
            latest = Some((updated_at, canonical));
        }
    }
    latest.map(|(_, path)| path)
}

pub(super) fn session_activity(path: &Path, session_id: &str) -> Option<SessionActivity> {
    let state = read_session_file(path)?;
    if state.session_id != session_id {
        return None;
    }
    match state.status.as_str() {
        "busy" | "shell" | "waiting" => Some(SessionActivity::Active),
        "idle" => Some(SessionActivity::Idle {
            status_updated_at: state.status_updated_at.max(state.updated_at),
        }),
        _ => None,
    }
}

fn read_session_file(path: &Path) -> Option<SessionFile> {
    let metadata = path.metadata().ok()?;
    if !metadata.is_file() || metadata.len() > MAX_SESSION_FILE_BYTES {
        return None;
    }
    serde_json::from_slice(&fs::read(path).ok()?).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hook_server::now_ms;

    #[test]
    fn detects_user_interrupt_markers() {
        for text in [
            "[Request interrupted by user]",
            "[Request interrupted by user for tool use]",
        ] {
            let line = serde_json::json!({
                "type": "user",
                "isSidechain": false,
                "sessionId": "session-1",
                "userType": "external",
                "message": { "role": "user", "content": [{ "type": "text", "text": text }] }
            });
            assert_eq!(
                terminal(&serde_json::to_vec(&line).unwrap(), "session-1", None),
                Some(TranscriptTerminal {
                    kind: TranscriptTerminalKind::Interrupted,
                    turn_id: None,
                })
            );
        }
    }

    #[test]
    fn detects_only_structured_turn_completion_records() {
        let completed = serde_json::json!({
            "type": "system",
            "subtype": "turn_duration",
            "sessionId": "session-1",
            "durationMs": 100,
        });
        assert_eq!(
            terminal(&serde_json::to_vec(&completed).unwrap(), "session-1", None),
            Some(TranscriptTerminal {
                kind: TranscriptTerminalKind::Completed,
                turn_id: None,
            })
        );
        assert_eq!(
            terminal(
                &serde_json::to_vec(&serde_json::json!({
                    "type": "user",
                    "sessionId": "session-1",
                    "message": { "role": "user", "content": "turn_duration" }
                }))
                .unwrap(),
                "session-1",
                None
            ),
            None
        );
    }

    #[test]
    fn rejects_human_prompts_and_unrelated_records() {
        let cases = [
            serde_json::json!({
                "type": "user",
                "sessionId": "session-1",
                "promptSource": "typed",
                "origin": { "kind": "human" },
                "message": { "role": "user", "content": "[Request interrupted by user]" }
            }),
            serde_json::json!({
                "type": "user",
                "sessionId": "other-session",
                "message": { "role": "user", "content": "[Request interrupted by user]" }
            }),
            serde_json::json!({
                "type": "assistant",
                "sessionId": "session-1",
                "message": { "role": "assistant", "content": "[Request interrupted by user]" }
            }),
            serde_json::json!({
                "type": "user",
                "sessionId": "session-1",
                "message": { "role": "user", "content": "prefix [Request interrupted by user]" }
            }),
        ];
        for line in cases {
            assert_eq!(
                terminal(&serde_json::to_vec(&line).unwrap(), "session-1", None),
                None
            );
        }
    }

    #[test]
    fn validates_transcripts_inside_the_config_projects_directory() {
        let root = std::env::temp_dir().join(format!(
            "agent-cat-claude-transcript-{}-{}",
            std::process::id(),
            now_ms()
        ));
        let project = root.join("projects").join("encoded-project");
        std::fs::create_dir_all(&project).unwrap();
        let valid = project.join("session-1.jsonl");
        std::fs::write(&valid, b"").unwrap();
        let outside = root.join("session-1.jsonl");
        std::fs::write(&outside, b"").unwrap();

        assert_eq!(
            validate_path(&valid, "session-1", &root),
            valid.canonicalize().ok()
        );
        assert_eq!(validate_path(&valid, "other-session", &root), None);
        assert_eq!(validate_path(&outside, "session-1", &root), None);

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn finds_the_latest_matching_session_and_classifies_activity() {
        let root = std::env::temp_dir().join(format!(
            "agent-cat-claude-session-{}-{}",
            std::process::id(),
            now_ms()
        ));
        let sessions = root.join("sessions");
        std::fs::create_dir_all(&sessions).unwrap();
        std::fs::write(
            sessions.join("100.json"),
            br#"{"sessionId":"session-1","status":"busy","statusUpdatedAt":10}"#,
        )
        .unwrap();
        std::fs::write(
            sessions.join("200.json"),
            br#"{"sessionId":"session-1","status":"idle","statusUpdatedAt":20}"#,
        )
        .unwrap();
        std::fs::write(
            sessions.join("not-a-pid.json"),
            br#"{"sessionId":"session-1","status":"idle","statusUpdatedAt":30}"#,
        )
        .unwrap();

        let path = find_session_path(&root, "session-1").unwrap();
        assert_eq!(path.file_name(), Some(OsStr::new("200.json")));
        assert_eq!(
            session_activity(&path, "session-1"),
            Some(SessionActivity::Idle {
                status_updated_at: 20,
            })
        );
        assert_eq!(session_activity(&path, "other-session"), None);
        assert_eq!(
            session_activity(&sessions.join("100.json"), "session-1"),
            Some(SessionActivity::Active)
        );

        std::fs::remove_dir_all(root).unwrap();
    }
}
