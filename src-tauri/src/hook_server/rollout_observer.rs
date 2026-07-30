use super::{emit_event, now_ms, sanitize_identifier, AgentEvent};
use serde::Deserialize;
use std::{
    collections::{HashMap, VecDeque},
    ffi::OsStr,
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::Duration,
};
use tauri::AppHandle;

const POLL_INTERVAL: Duration = Duration::from_millis(200);
const MAX_READ_BYTES: u64 = 256 * 1024;
const MAX_LINE_BYTES: usize = 256 * 1024;
const MAX_WATCH_ENTRIES: usize = 64;
const MAX_TERMINAL_TURNS_PER_ENTRY: usize = 8;
const TURN_ABORTED_MARKER: &[u8] = b"turn_aborted";
const TASK_COMPLETE_MARKER: &[u8] = b"task_complete";

#[derive(Debug, PartialEq, Eq)]
enum RolloutTerminalKind {
    Completed,
    Interrupted,
}

#[derive(Debug, PartialEq, Eq)]
struct RolloutTerminal {
    kind: RolloutTerminalKind,
    turn_id: String,
}

struct ObserverRuntime {
    running: Arc<AtomicBool>,
    entries: Arc<Mutex<HashMap<String, WatchEntry>>>,
}

struct WatchEntry {
    path: PathBuf,
    offset: u64,
    partial_line: Vec<u8>,
    discarding_line: bool,
    active_turn_id: Option<String>,
    terminal_turn_ids: VecDeque<String>,
    active: bool,
}

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

static OBSERVER: OnceLock<ObserverRuntime> = OnceLock::new();

pub(super) fn start(app: AppHandle) -> Result<(), String> {
    let runtime = OBSERVER.get_or_init(|| ObserverRuntime {
        running: Arc::new(AtomicBool::new(false)),
        entries: Arc::new(Mutex::new(HashMap::new())),
    });
    if runtime.running.swap(true, Ordering::AcqRel) {
        return Ok(());
    }
    let running = runtime.running.clone();
    let entries = runtime.entries.clone();
    std::thread::Builder::new()
        .name("agent-cat-rollout".into())
        .spawn(move || observe(app, running, entries))
        .map(|_| ())
        .map_err(|error| {
            runtime.running.store(false, Ordering::Release);
            format!("启动 Codex 中断观察器失败：{error}")
        })
}

pub(super) fn cleanup() {
    let Some(runtime) = OBSERVER.get() else {
        return;
    };
    runtime.running.store(false, Ordering::Release);
    if let Ok(mut entries) = runtime.entries.lock() {
        entries.clear();
    }
}

pub(super) fn set_enabled(enabled: bool) {
    if enabled {
        return;
    }
    if let Some(runtime) = OBSERVER.get() {
        if let Ok(mut entries) = runtime.entries.lock() {
            entries.clear();
        }
    }
}

pub(super) fn handle_hook_event(event: &AgentEvent, transcript_path: Option<&Path>) {
    let Some(runtime) = OBSERVER.get() else {
        return;
    };
    let hooks_enabled = crate::config::load()
        .map(|value| value.codex.hooks_enabled)
        .unwrap_or(false);
    let Ok(mut entries) = runtime.entries.lock() else {
        return;
    };
    if !hooks_enabled {
        entries.clear();
        return;
    }
    if event.event == "SessionEnd" {
        entries.remove(&event.session_id);
        return;
    }
    if matches!(event.event.as_str(), "Stop" | "TurnInterrupted") {
        if let Some(entry) = entries.get_mut(&event.session_id) {
            mark_terminal(entry, event.turn_id.as_deref());
        }
        return;
    }
    if event.event == "PostCompact" && event.compact_trigger.as_deref() == Some("manual") {
        if let Some(entry) = entries.get_mut(&event.session_id) {
            entry.active = false;
            entry.active_turn_id = None;
            entry.partial_line.clear();
            entry.discarding_line = false;
        }
        return;
    }

    let active = matches!(
        event.event.as_str(),
        "UserPromptSubmit"
            | "PreToolUse"
            | "PostToolUse"
            | "SubagentStart"
            | "SubagentStop"
            | "PreCompact"
            | "PostCompact"
            | "PermissionRequest"
    );
    let validated_path =
        transcript_path.and_then(|path| validate_rollout_path(path, &event.session_id));
    let Some(path) = validated_path.or_else(|| {
        entries
            .get(&event.session_id)
            .map(|entry| entry.path.clone())
    }) else {
        return;
    };
    let current_len = path.metadata().map(|metadata| metadata.len()).unwrap_or(0);
    if !entries.contains_key(&event.session_id) && entries.len() >= MAX_WATCH_ENTRIES {
        let inactive = entries
            .iter()
            .find_map(|(session_id, entry)| (!entry.active).then(|| session_id.clone()));
        if let Some(session_id) = inactive {
            entries.remove(&session_id);
        } else {
            return;
        }
    }
    let entry = entries
        .entry(event.session_id.clone())
        .or_insert_with(|| WatchEntry {
            path: path.clone(),
            offset: current_len,
            partial_line: Vec::new(),
            discarding_line: false,
            active_turn_id: None,
            terminal_turn_ids: VecDeque::new(),
            active: false,
        });
    if entry.path != path {
        entry.path = path;
        entry.offset = current_len;
        entry.partial_line.clear();
        entry.discarding_line = false;
    }
    if active
        && event
            .turn_id
            .as_deref()
            .is_some_and(|turn_id| is_terminal_turn(entry, turn_id))
    {
        return;
    }
    if active && !entry.active {
        entry.offset = current_len;
        entry.partial_line.clear();
        entry.discarding_line = false;
    }
    if active {
        entry.active = true;
        if event.turn_id.is_some() {
            entry.active_turn_id = event.turn_id.clone();
        }
    }
}

fn observe(
    app: AppHandle,
    running: Arc<AtomicBool>,
    entries: Arc<Mutex<HashMap<String, WatchEntry>>>,
) {
    while running.load(Ordering::Acquire) {
        std::thread::sleep(POLL_INTERVAL);
        if let Ok(mut entries) = entries.lock() {
            for (session_id, entry) in entries.iter_mut() {
                if !entry.active {
                    continue;
                }
                if let Some(terminal) = poll_entry(entry) {
                    mark_terminal(entry, Some(&terminal.turn_id));
                    emit_event(
                        &app,
                        AgentEvent {
                            version: 1,
                            agent: "codex".into(),
                            session_id: session_id.clone(),
                            event: match terminal.kind {
                                RolloutTerminalKind::Completed => "Stop".into(),
                                RolloutTerminalKind::Interrupted => "TurnInterrupted".into(),
                            },
                            timestamp: now_ms(),
                            title: None,
                            tool_name: None,
                            turn_id: Some(terminal.turn_id),
                            session_source: None,
                            compact_trigger: None,
                        },
                    );
                }
            }
        }
    }
}

fn is_terminal_turn(entry: &WatchEntry, turn_id: &str) -> bool {
    entry
        .terminal_turn_ids
        .iter()
        .any(|terminal| terminal == turn_id)
}

fn mark_terminal(entry: &mut WatchEntry, turn_id: Option<&str>) {
    if let Some(turn_id) = turn_id {
        if let Some(index) = entry
            .terminal_turn_ids
            .iter()
            .position(|terminal| terminal == turn_id)
        {
            entry.terminal_turn_ids.remove(index);
        }
        entry.terminal_turn_ids.push_back(turn_id.to_string());
        while entry.terminal_turn_ids.len() > MAX_TERMINAL_TURNS_PER_ENTRY {
            entry.terminal_turn_ids.pop_front();
        }
    }
    entry.active = false;
    entry.active_turn_id = None;
    entry.partial_line.clear();
    entry.discarding_line = false;
}

fn poll_entry(entry: &mut WatchEntry) -> Option<RolloutTerminal> {
    let length = entry.path.metadata().ok()?.len();
    if length < entry.offset {
        entry.offset = 0;
        entry.partial_line.clear();
        entry.discarding_line = false;
    }
    if length == entry.offset {
        return None;
    }
    let mut file = File::open(&entry.path).ok()?;
    file.seek(SeekFrom::Start(entry.offset)).ok()?;
    let mut bytes = Vec::with_capacity((length - entry.offset).min(MAX_READ_BYTES) as usize);
    file.take(MAX_READ_BYTES).read_to_end(&mut bytes).ok()?;
    entry.offset = entry.offset.saturating_add(bytes.len() as u64);
    consume_bytes(entry, &bytes)
}

fn consume_bytes(entry: &mut WatchEntry, bytes: &[u8]) -> Option<RolloutTerminal> {
    for byte in bytes {
        if *byte == b'\n' {
            let detected = if entry.discarding_line {
                None
            } else {
                rollout_terminal(&entry.partial_line, entry.active_turn_id.as_deref())
            };
            entry.partial_line.clear();
            entry.discarding_line = false;
            if detected.is_some() {
                return detected;
            }
        } else if !entry.discarding_line {
            if entry.partial_line.len() < MAX_LINE_BYTES {
                entry.partial_line.push(*byte);
            } else {
                entry.partial_line.clear();
                entry.discarding_line = true;
            }
        }
    }
    None
}

fn rollout_terminal(line: &[u8], active_turn_id: Option<&str>) -> Option<RolloutTerminal> {
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
        "task_complete" => RolloutTerminalKind::Completed,
        "turn_aborted" if line.payload.reason.as_deref() == Some("interrupted") => {
            RolloutTerminalKind::Interrupted
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
    Some(RolloutTerminal {
        kind,
        turn_id: turn_id.to_string(),
    })
}

fn validate_rollout_path(path: &Path, session_id: &str) -> Option<PathBuf> {
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
    use std::io::Write;

    fn entry(turn_id: Option<&str>) -> WatchEntry {
        WatchEntry {
            path: PathBuf::new(),
            offset: 0,
            partial_line: Vec::new(),
            discarding_line: false,
            active_turn_id: turn_id.map(str::to_string),
            terminal_turn_ids: VecDeque::new(),
            active: true,
        }
    }

    #[test]
    fn detects_only_matching_interrupted_turns() {
        let line = br#"{"timestamp":"now","type":"event_msg","payload":{"type":"turn_aborted","turn_id":"turn-1","reason":"interrupted"}}"#;
        assert_eq!(
            rollout_terminal(line, Some("turn-1")),
            Some(RolloutTerminal {
                kind: RolloutTerminalKind::Interrupted,
                turn_id: "turn-1".into(),
            })
        );
        assert_eq!(rollout_terminal(line, Some("turn-2")), None);
        assert_eq!(rollout_terminal(line, None), None);
        assert_eq!(
            rollout_terminal(
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
            rollout_terminal(line, Some("turn-1")),
            Some(RolloutTerminal {
                kind: RolloutTerminalKind::Completed,
                turn_id: "turn-1".into(),
            })
        );
        assert_eq!(rollout_terminal(line, Some("turn-2")), None);
        assert_eq!(rollout_terminal(line, None), None);
    }

    #[test]
    fn buffers_partial_lines_without_replaying_content() {
        let mut entry = entry(Some("turn-1"));
        let first = br#"{"type":"event_msg","payload":{"type":"turn_aborted","turn_id":"turn-1""#;
        let second = br#", "reason":"interrupted"}}
"#;
        assert_eq!(consume_bytes(&mut entry, first), None);
        assert_eq!(
            consume_bytes(&mut entry, second),
            Some(RolloutTerminal {
                kind: RolloutTerminalKind::Interrupted,
                turn_id: "turn-1".into(),
            })
        );
        assert!(entry.partial_line.is_empty());
    }

    #[test]
    fn ignores_marker_text_outside_the_event_envelope() {
        for line in [
            br#"{"type":"response_item","payload":{"type":"message","text":"turn_aborted interrupted"}}"#.as_slice(),
            br#"{"type":"response_item","payload":{"type":"message","text":"task_complete"}}"#.as_slice(),
        ] {
            assert_eq!(rollout_terminal(line, None), None);
        }
    }

    #[test]
    fn reads_only_bytes_appended_after_registration() {
        let root = std::env::temp_dir().join(format!(
            "agent-cat-rollout-observer-{}-{}",
            std::process::id(),
            now_ms()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("rollout-test-session-1.jsonl");
        std::fs::write(
            &path,
            b"{\"type\":\"event_msg\",\"payload\":{\"type\":\"turn_aborted\",\"turn_id\":\"old\",\"reason\":\"interrupted\"}}\n",
        )
        .unwrap();
        let path = validate_rollout_path(&path, "session-1").unwrap();
        let mut entry = WatchEntry {
            offset: path.metadata().unwrap().len(),
            path: path.clone(),
            partial_line: Vec::new(),
            discarding_line: false,
            active_turn_id: Some("turn-1".into()),
            terminal_turn_ids: VecDeque::new(),
            active: true,
        };
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap();
        writeln!(
            file,
            "{{\"type\":\"event_msg\",\"payload\":{{\"type\":\"turn_aborted\",\"turn_id\":\"turn-1\",\"reason\":\"interrupted\"}}}}"
        )
        .unwrap();
        file.flush().unwrap();
        assert_eq!(
            poll_entry(&mut entry),
            Some(RolloutTerminal {
                kind: RolloutTerminalKind::Interrupted,
                turn_id: "turn-1".into(),
            })
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn reads_completed_turn_appended_after_registration() {
        let root = std::env::temp_dir().join(format!(
            "agent-cat-rollout-complete-{}-{}",
            std::process::id(),
            now_ms()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("rollout-test-session-1.jsonl");
        std::fs::write(&path, b"").unwrap();
        let path = validate_rollout_path(&path, "session-1").unwrap();
        let mut entry = WatchEntry {
            offset: 0,
            path: path.clone(),
            partial_line: Vec::new(),
            discarding_line: false,
            active_turn_id: Some("turn-1".into()),
            terminal_turn_ids: VecDeque::new(),
            active: true,
        };
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap();
        writeln!(
            file,
            "{{\"type\":\"event_msg\",\"payload\":{{\"type\":\"task_complete\",\"turn_id\":\"turn-1\"}}}}"
        )
        .unwrap();
        file.flush().unwrap();
        assert_eq!(
            poll_entry(&mut entry),
            Some(RolloutTerminal {
                kind: RolloutTerminalKind::Completed,
                turn_id: "turn-1".into(),
            })
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn keeps_terminal_turns_in_a_bounded_history() {
        let mut entry = entry(None);
        for index in 0..=MAX_TERMINAL_TURNS_PER_ENTRY {
            mark_terminal(&mut entry, Some(&format!("turn-{index}")));
        }
        assert!(!is_terminal_turn(&entry, "turn-0"));
        assert!(is_terminal_turn(
            &entry,
            &format!("turn-{MAX_TERMINAL_TURNS_PER_ENTRY}")
        ));
        assert_eq!(entry.terminal_turn_ids.len(), MAX_TERMINAL_TURNS_PER_ENTRY);
    }
}
