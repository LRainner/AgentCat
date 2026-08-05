use super::{TranscriptTerminal, TranscriptTerminalKind};
use crate::hook_server::sanitize_identifier;
use serde::Deserialize;
use std::{
    ffi::OsStr,
    path::{Path, PathBuf},
};

const TURN_ABORTED_MARKER: &[u8] = b"turn_aborted";
const TASK_COMPLETE_MARKER: &[u8] = b"task_complete";

#[derive(Debug, Default, Deserialize)]
struct RolloutPayload {
    #[serde(rename = "type")]
    kind: Option<String>,
    turn_id: Option<String>,
    reason: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RolloutLine {
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    payload: RolloutPayload,
}

pub(super) fn terminal(line: &[u8], active_turn_id: Option<&str>) -> Option<TranscriptTerminal> {
    let may_be_interrupted = line
        .windows(TURN_ABORTED_MARKER.len())
        .any(|window| window == TURN_ABORTED_MARKER);
    let may_be_completed = line
        .windows(TASK_COMPLETE_MARKER.len())
        .any(|window| window == TASK_COMPLETE_MARKER);
    if !may_be_interrupted && !may_be_completed {
        return None;
    }
    let line: RolloutLine = serde_json::from_slice(line).ok()?;
    if line.kind != "event_msg" {
        return None;
    }
    let kind = match line.payload.kind.as_deref()? {
        "task_complete" => TranscriptTerminalKind::Completed,
        "turn_aborted" if line.payload.reason.as_deref() == Some("interrupted") => {
            TranscriptTerminalKind::Interrupted
        }
        _ => return None,
    };
    let turn_id = line
        .payload
        .turn_id
        .as_deref()
        .and_then(sanitize_identifier)?;
    if active_turn_id != Some(turn_id.as_str()) {
        return None;
    }
    Some(TranscriptTerminal {
        kind,
        turn_id: Some(turn_id),
    })
}

pub(super) fn validate_path(path: &Path, session_id: &str) -> Option<PathBuf> {
    if !path.is_absolute() || path.extension() != Some(OsStr::new("jsonl")) {
        return None;
    }
    let canonical = path.canonicalize().ok()?;
    if !canonical.metadata().ok()?.is_file() {
        return None;
    }
    let file_name = canonical.file_name()?.to_string_lossy();
    if !file_name.starts_with("rollout-") || !file_name.ends_with(&format!("-{session_id}.jsonl")) {
        return None;
    }
    Some(canonical)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_only_matching_interrupted_turns() {
        let line = br#"{"timestamp":"now","type":"event_msg","payload":{"type":"turn_aborted","turn_id":"turn-1","reason":"interrupted"}}"#;
        assert_eq!(
            terminal(line, Some("turn-1")),
            Some(TranscriptTerminal {
                kind: TranscriptTerminalKind::Interrupted,
                turn_id: Some("turn-1".into()),
            })
        );
        assert_eq!(terminal(line, Some("turn-2")), None);
        assert_eq!(terminal(line, None), None);
        assert_eq!(
            terminal(
                br#"{"type":"event_msg","payload":{"type":"turn_aborted","turn_id":"turn-1","reason":"replaced"}}"#,
                Some("turn-1")
            ),
            None
        );
    }

    #[test]
    fn detects_only_matching_completed_turns() {
        let line = br#"{"timestamp":"now","type":"event_msg","payload":{"type":"task_complete","turn_id":"turn-1"}}"#;
        assert_eq!(
            terminal(line, Some("turn-1")),
            Some(TranscriptTerminal {
                kind: TranscriptTerminalKind::Completed,
                turn_id: Some("turn-1".into()),
            })
        );
        assert_eq!(terminal(line, Some("turn-2")), None);
        assert_eq!(terminal(line, None), None);
    }

    #[test]
    fn ignores_marker_text_outside_the_event_envelope() {
        for line in [
            br#"{"type":"response_item","payload":{"type":"message","text":"turn_aborted interrupted"}}"#.as_slice(),
            br#"{"type":"response_item","payload":{"type":"message","text":"task_complete"}}"#.as_slice(),
        ] {
            assert_eq!(terminal(line, None), None);
        }
    }
}
