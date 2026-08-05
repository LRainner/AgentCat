use super::{emit_event, now_ms, AgentEvent};
use crate::hook_installer;
use std::{
    collections::{HashMap, VecDeque},
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::{Duration, Instant},
};
use tauri::AppHandle;

mod claude_code;
mod codex;

const POLL_INTERVAL: Duration = Duration::from_millis(200);
const MAX_READ_BYTES: u64 = 256 * 1024;
const MAX_LINE_BYTES: usize = 256 * 1024;
const MAX_WATCH_ENTRIES: usize = 64;
const MAX_TERMINAL_TURNS_PER_ENTRY: usize = 8;
const CLAUDE_IDLE_GRACE: Duration = Duration::from_millis(2_500);

#[derive(Debug, PartialEq, Eq)]
enum TranscriptTerminalKind {
    Completed,
    Interrupted,
}

#[derive(Debug, PartialEq, Eq)]
struct TranscriptTerminal {
    kind: TranscriptTerminalKind,
    turn_id: Option<String>,
}

struct ObserverRuntime {
    running: Arc<AtomicBool>,
    entries: Arc<Mutex<HashMap<String, WatchEntry>>>,
}

struct WatchEntry {
    agent: String,
    session_id: String,
    transcript_path: Option<PathBuf>,
    offset: u64,
    partial_line: Vec<u8>,
    discarding_line: bool,
    active_turn_id: Option<String>,
    terminal_turn_ids: VecDeque<String>,
    claude_session_path: Option<PathBuf>,
    turn_started_at: u64,
    idle_observed_at: Option<Instant>,
    active: bool,
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
        .name("agent-cat-transcript".into())
        .spawn(move || observe(app, running, entries))
        .map(|_| ())
        .map_err(|error| {
            runtime.running.store(false, Ordering::Release);
            format!("启动 Agent transcript 观察器失败：{error}")
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

pub(super) fn sync_enabled_agents(codex_enabled: bool, claude_code_enabled: bool) {
    if let Some(runtime) = OBSERVER.get() {
        if let Ok(mut entries) = runtime.entries.lock() {
            entries.retain(|_, entry| match entry.agent.as_str() {
                hook_installer::CODEX => codex_enabled,
                hook_installer::CLAUDE_CODE => claude_code_enabled,
                _ => false,
            });
        }
    }
}

pub(super) fn handle_hook_event(event: &AgentEvent, transcript_path: Option<&Path>) {
    let Some(runtime) = OBSERVER.get() else {
        return;
    };
    let hooks_enabled = crate::config::load()
        .map(|value| match event.agent.as_str() {
            hook_installer::CODEX => value.codex.hooks_enabled,
            hook_installer::CLAUDE_CODE => value.claude_code.hooks_enabled,
            _ => false,
        })
        .unwrap_or(false);
    let Ok(mut entries) = runtime.entries.lock() else {
        return;
    };
    if !hooks_enabled {
        entries.retain(|_, entry| entry.agent != event.agent);
        return;
    }
    let watch_key = watch_key(&event.agent, &event.session_id);
    if event.event == "SessionEnd" {
        entries.remove(&watch_key);
        return;
    }
    if matches!(
        event.event.as_str(),
        "Stop" | "StopFailure" | "TurnInterrupted"
    ) {
        if let Some(entry) = entries.get_mut(&watch_key) {
            mark_terminal(entry, event.turn_id.as_deref());
        }
        return;
    }
    if event.event == "PostCompact" && event.compact_trigger.as_deref() == Some("manual") {
        if let Some(entry) = entries.get_mut(&watch_key) {
            entry.active = false;
            entry.active_turn_id = None;
            entry.partial_line.clear();
            entry.discarding_line = false;
            entry.idle_observed_at = None;
        }
        return;
    }

    let active = matches!(
        event.event.as_str(),
        "UserPromptSubmit"
            | "PreToolUse"
            | "PostToolUse"
            | "PostToolUseFailure"
            | "SubagentStart"
            | "SubagentStop"
            | "PreCompact"
            | "PostCompact"
            | "PermissionRequest"
    );
    let validated_path = transcript_path
        .and_then(|path| validate_transcript_path(&event.agent, path, &event.session_id));
    let transcript_path = validated_path.or_else(|| {
        entries
            .get(&watch_key)
            .and_then(|entry| entry.transcript_path.clone())
    });
    let claude_session_path = (event.agent == hook_installer::CLAUDE_CODE)
        .then(|| find_claude_session_path(&event.session_id))
        .flatten();
    if transcript_path.is_none() && claude_session_path.is_none() {
        return;
    }
    let current_len = transcript_path
        .as_ref()
        .and_then(|path| path.metadata().ok())
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    if !entries.contains_key(&watch_key) && entries.len() >= MAX_WATCH_ENTRIES {
        let inactive = entries
            .iter()
            .find_map(|(session_id, entry)| (!entry.active).then(|| session_id.clone()));
        if let Some(session_id) = inactive {
            entries.remove(&session_id);
        } else {
            return;
        }
    }
    let entry = entries.entry(watch_key).or_insert_with(|| WatchEntry {
        agent: event.agent.clone(),
        session_id: event.session_id.clone(),
        transcript_path: transcript_path.clone(),
        offset: current_len,
        partial_line: Vec::new(),
        discarding_line: false,
        active_turn_id: None,
        terminal_turn_ids: VecDeque::new(),
        claude_session_path: claude_session_path.clone(),
        turn_started_at: event.timestamp,
        idle_observed_at: None,
        active: false,
    });
    if transcript_path.is_some() && entry.transcript_path != transcript_path {
        entry.transcript_path = transcript_path;
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
        entry.turn_started_at = event.timestamp;
        entry.idle_observed_at = None;
    }
    if active {
        entry.active = true;
        if event.event == "UserPromptSubmit" {
            entry.turn_started_at = event.timestamp;
            entry.idle_observed_at = None;
            if claude_session_path.is_some() {
                entry.claude_session_path = claude_session_path;
            }
        } else if entry.claude_session_path.is_none() {
            entry.claude_session_path = claude_session_path;
        }
        if event.turn_id.is_some() {
            entry.active_turn_id = event.turn_id.clone();
        }
    }
}

fn watch_key(agent: &str, session_id: &str) -> String {
    format!("{agent}\0{session_id}")
}

fn observe(
    app: AppHandle,
    running: Arc<AtomicBool>,
    entries: Arc<Mutex<HashMap<String, WatchEntry>>>,
) {
    while running.load(Ordering::Acquire) {
        std::thread::sleep(POLL_INTERVAL);
        if let Ok(mut entries) = entries.lock() {
            for entry in entries.values_mut() {
                if !entry.active {
                    continue;
                }
                if let Some(terminal) = poll_entry(entry) {
                    mark_terminal(entry, terminal.turn_id.as_deref());
                    emit_event(
                        &app,
                        AgentEvent {
                            version: 1,
                            agent: entry.agent.clone(),
                            session_id: entry.session_id.clone(),
                            event: match terminal.kind {
                                TranscriptTerminalKind::Completed => "Stop".into(),
                                TranscriptTerminalKind::Interrupted => "TurnInterrupted".into(),
                            },
                            timestamp: now_ms(),
                            title: None,
                            tool_name: None,
                            turn_id: terminal.turn_id,
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
    entry.idle_observed_at = None;
}

fn poll_entry(entry: &mut WatchEntry) -> Option<TranscriptTerminal> {
    poll_entry_at(entry, Instant::now())
}

fn poll_entry_at(entry: &mut WatchEntry, now: Instant) -> Option<TranscriptTerminal> {
    if let Some(terminal) = poll_transcript(entry) {
        return Some(terminal);
    }
    poll_claude_session(entry, now)
}

fn poll_transcript(entry: &mut WatchEntry) -> Option<TranscriptTerminal> {
    let path = entry.transcript_path.as_ref()?;
    let length = path.metadata().ok()?.len();
    if length < entry.offset {
        entry.offset = 0;
        entry.partial_line.clear();
        entry.discarding_line = false;
    }
    if length == entry.offset {
        return None;
    }
    let mut file = File::open(path).ok()?;
    file.seek(SeekFrom::Start(entry.offset)).ok()?;
    let mut bytes = Vec::with_capacity((length - entry.offset).min(MAX_READ_BYTES) as usize);
    file.take(MAX_READ_BYTES).read_to_end(&mut bytes).ok()?;
    entry.offset = entry.offset.saturating_add(bytes.len() as u64);
    consume_bytes(entry, &bytes)
}

fn poll_claude_session(entry: &mut WatchEntry, now: Instant) -> Option<TranscriptTerminal> {
    if entry.agent != hook_installer::CLAUDE_CODE {
        return None;
    }
    if entry.claude_session_path.is_none() {
        entry.claude_session_path = find_claude_session_path(&entry.session_id);
    }
    let activity =
        claude_code::session_activity(entry.claude_session_path.as_deref()?, &entry.session_id)?;
    match activity {
        claude_code::SessionActivity::Active => {
            entry.idle_observed_at = None;
            None
        }
        claude_code::SessionActivity::Idle { status_updated_at }
            if status_updated_at >= entry.turn_started_at =>
        {
            let observed_at = *entry.idle_observed_at.get_or_insert(now);
            now.duration_since(observed_at)
                .ge(&CLAUDE_IDLE_GRACE)
                .then(|| TranscriptTerminal {
                    kind: TranscriptTerminalKind::Interrupted,
                    turn_id: entry.active_turn_id.clone(),
                })
        }
        claude_code::SessionActivity::Idle { .. } => None,
    }
}

fn find_claude_session_path(session_id: &str) -> Option<PathBuf> {
    let root = hook_installer::transcript_root(hook_installer::CLAUDE_CODE)
        .ok()
        .flatten()?;
    claude_code::find_session_path(&root, session_id)
}

fn consume_bytes(entry: &mut WatchEntry, bytes: &[u8]) -> Option<TranscriptTerminal> {
    for byte in bytes {
        if *byte == b'\n' {
            let detected = if entry.discarding_line {
                None
            } else {
                transcript_terminal(
                    &entry.agent,
                    &entry.session_id,
                    &entry.partial_line,
                    entry.active_turn_id.as_deref(),
                )
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

fn transcript_terminal(
    agent: &str,
    session_id: &str,
    line: &[u8],
    active_turn_id: Option<&str>,
) -> Option<TranscriptTerminal> {
    match agent {
        hook_installer::CODEX => codex::terminal(line, active_turn_id),
        hook_installer::CLAUDE_CODE => claude_code::terminal(line, session_id, active_turn_id),
        _ => None,
    }
}

fn validate_transcript_path(agent: &str, path: &Path, session_id: &str) -> Option<PathBuf> {
    match agent {
        hook_installer::CODEX => codex::validate_path(path, session_id),
        hook_installer::CLAUDE_CODE => {
            let root = hook_installer::transcript_root(agent).ok().flatten()?;
            claude_code::validate_path(path, session_id, &root)
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn entry(turn_id: Option<&str>) -> WatchEntry {
        WatchEntry {
            agent: hook_installer::CODEX.into(),
            session_id: "session-1".into(),
            transcript_path: None,
            offset: 0,
            partial_line: Vec::new(),
            discarding_line: false,
            active_turn_id: turn_id.map(str::to_string),
            terminal_turn_ids: VecDeque::new(),
            claude_session_path: None,
            turn_started_at: 0,
            idle_observed_at: None,
            active: true,
        }
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
            Some(TranscriptTerminal {
                kind: TranscriptTerminalKind::Interrupted,
                turn_id: Some("turn-1".into()),
            })
        );
        assert!(entry.partial_line.is_empty());
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
        let path = codex::validate_path(&path, "session-1").unwrap();
        let mut entry = WatchEntry {
            agent: hook_installer::CODEX.into(),
            session_id: "session-1".into(),
            offset: path.metadata().unwrap().len(),
            transcript_path: Some(path.clone()),
            partial_line: Vec::new(),
            discarding_line: false,
            active_turn_id: Some("turn-1".into()),
            terminal_turn_ids: VecDeque::new(),
            claude_session_path: None,
            turn_started_at: 0,
            idle_observed_at: None,
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
            Some(TranscriptTerminal {
                kind: TranscriptTerminalKind::Interrupted,
                turn_id: Some("turn-1".into()),
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
        let path = codex::validate_path(&path, "session-1").unwrap();
        let mut entry = WatchEntry {
            agent: hook_installer::CODEX.into(),
            session_id: "session-1".into(),
            offset: 0,
            transcript_path: Some(path.clone()),
            partial_line: Vec::new(),
            discarding_line: false,
            active_turn_id: Some("turn-1".into()),
            terminal_turn_ids: VecDeque::new(),
            claude_session_path: None,
            turn_started_at: 0,
            idle_observed_at: None,
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
            Some(TranscriptTerminal {
                kind: TranscriptTerminalKind::Completed,
                turn_id: Some("turn-1".into()),
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

    #[test]
    fn treats_claude_idle_without_a_terminal_hook_as_interrupted_after_grace() {
        let root = std::env::temp_dir().join(format!(
            "agent-cat-claude-idle-observer-{}-{}",
            std::process::id(),
            now_ms()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let session_path = root.join("100.json");
        std::fs::write(
            &session_path,
            br#"{"sessionId":"session-1","status":"idle","statusUpdatedAt":200}"#,
        )
        .unwrap();
        let mut entry = WatchEntry {
            agent: hook_installer::CLAUDE_CODE.into(),
            session_id: "session-1".into(),
            transcript_path: None,
            offset: 0,
            partial_line: Vec::new(),
            discarding_line: false,
            active_turn_id: None,
            terminal_turn_ids: VecDeque::new(),
            claude_session_path: Some(session_path),
            turn_started_at: 100,
            idle_observed_at: None,
            active: true,
        };
        let first_observation = Instant::now();
        assert_eq!(poll_entry_at(&mut entry, first_observation), None);
        assert_eq!(
            poll_entry_at(&mut entry, first_observation + CLAUDE_IDLE_GRACE),
            Some(TranscriptTerminal {
                kind: TranscriptTerminalKind::Interrupted,
                turn_id: None,
            })
        );

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn ignores_stale_idle_and_cancels_pending_idle_when_claude_is_active() {
        let root = std::env::temp_dir().join(format!(
            "agent-cat-claude-active-observer-{}-{}",
            std::process::id(),
            now_ms()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let session_path = root.join("100.json");
        std::fs::write(
            &session_path,
            br#"{"sessionId":"session-1","status":"idle","statusUpdatedAt":50}"#,
        )
        .unwrap();
        let mut entry = WatchEntry {
            agent: hook_installer::CLAUDE_CODE.into(),
            session_id: "session-1".into(),
            transcript_path: None,
            offset: 0,
            partial_line: Vec::new(),
            discarding_line: false,
            active_turn_id: None,
            terminal_turn_ids: VecDeque::new(),
            claude_session_path: Some(session_path.clone()),
            turn_started_at: 100,
            idle_observed_at: None,
            active: true,
        };
        let now = Instant::now();
        assert_eq!(poll_entry_at(&mut entry, now), None);
        assert!(entry.idle_observed_at.is_none());

        std::fs::write(
            &session_path,
            br#"{"sessionId":"session-1","status":"idle","statusUpdatedAt":200}"#,
        )
        .unwrap();
        assert_eq!(poll_entry_at(&mut entry, now), None);
        assert!(entry.idle_observed_at.is_some());
        std::fs::write(
            &session_path,
            br#"{"sessionId":"session-1","status":"busy","statusUpdatedAt":201}"#,
        )
        .unwrap();
        assert_eq!(poll_entry_at(&mut entry, now + CLAUDE_IDLE_GRACE), None);
        assert!(entry.idle_observed_at.is_none());

        std::fs::remove_dir_all(root).unwrap();
    }
}
