pub use crate::agent_events::AgentEvent;
use crate::{agent_events, config};
use serde::{Deserialize, Serialize};
use std::{
    io::{Read, Write},
    path::PathBuf,
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex, OnceLock,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::AppHandle;

mod rollout_observer;
#[cfg(unix)]
mod unix;
#[cfg(windows)]
mod windows;

#[cfg(unix)]
use unix as transport;
#[cfg(windows)]
use windows as transport;

const HOOK_EVENTS: [&str; 11] = [
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "SubagentStart",
    "SubagentStop",
    "PreCompact",
    "PostCompact",
    "PermissionRequest",
    "Stop",
    "SessionEnd",
];

const DISPLAY_EVENTS: [&str; 13] = [
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "SubagentStart",
    "SubagentStop",
    "PreCompact",
    "PostCompact",
    "PermissionRequest",
    "Stop",
    "SessionEnd",
    "TurnInterrupted",
    "HookParseError",
];

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HookWirePayload {
    wire_version: u8,
    event: AgentEvent,
    #[serde(skip_serializing_if = "Option::is_none")]
    transcript_path: Option<String>,
}

#[derive(Debug)]
struct DecodedHookPayload {
    event: AgentEvent,
    transcript_path: Option<PathBuf>,
}

static LATEST_REAL_EVENT: OnceLock<Mutex<Option<AgentEvent>>> = OnceLock::new();
static RECEIVER_RUNNING: AtomicBool = AtomicBool::new(false);
static OWNS_SOCKET: AtomicBool = AtomicBool::new(false);
const HEALTH_CHECK_PAYLOAD: &[u8] = b"agent-cat-hook-health-v1";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HookRuntimeStatus {
    pub receiver_running: bool,
    pub socket_path: String,
    pub verified_at: Option<u64>,
    pub last_real_event_at: Option<u64>,
    pub last_real_event: Option<String>,
}

#[derive(Debug, Deserialize)]
struct CodexInput {
    session_id: Option<String>,
    hook_event_name: Option<String>,
    turn_id: Option<String>,
    transcript_path: Option<PathBuf>,
    display_title: Option<String>,
    source: Option<String>,
    trigger: Option<String>,
    prompt: Option<String>,
    tool_name: Option<String>,
}

pub fn socket_path() -> Result<PathBuf, String> {
    Ok(config::config_dir()?.join(transport::ENDPOINT_NAME))
}

pub fn run_cli_hook() {
    let result = (|| -> Result<(), String> {
        let mut bytes = Vec::new();
        std::io::stdin()
            .take(1024 * 1024)
            .read_to_end(&mut bytes)
            .map_err(|error| error.to_string())?;
        let input: CodexInput =
            serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
        let codex_config = config::load().ok().map(|value| value.codex);
        let transcript_path = codex_config
            .as_ref()
            .is_some_and(|value| value.hooks_enabled)
            .then(|| input.transcript_path.clone())
            .flatten();
        let show_task_summary = codex_config
            .as_ref()
            .is_some_and(|value| value.show_task_summary);
        let event = build_event(input, show_task_summary, now_ms())?;
        let mut stream = transport::connect(&socket_path()?)?;
        stream
            .set_write_timeout(Some(Duration::from_millis(150)))
            .map_err(|error| error.to_string())?;
        let payload = serde_json::to_vec(&HookWirePayload {
            wire_version: 2,
            event,
            transcript_path: transcript_path.map(|path| path.to_string_lossy().to_string()),
        })
        .map_err(|error| error.to_string())?;
        stream
            .write_all(&payload)
            .map_err(|error| error.to_string())?;
        let _ = stream.shutdown(std::net::Shutdown::Write);
        Ok(())
    })();
    // Hooks are real-time hints only. Never write to stdout/stderr and never block Codex.
    let _ = result;
}

pub fn start(app: AppHandle) -> Result<bool, String> {
    let socket = socket_path()?;
    if let Some(parent) = socket.parent() {
        config::ensure_private_dir(parent)?;
    }
    if socket.exists() && notify_existing_receiver(&socket) {
        return Ok(false);
    }
    let listener = transport::bind(&socket)?;
    rollout_observer::start(app.clone())?;
    OWNS_SOCKET.store(true, Ordering::Release);
    RECEIVER_RUNNING.store(true, Ordering::Release);
    let spawn_result = std::thread::Builder::new()
        .name("agent-cat-hook".into())
        .spawn(move || {
            for connection in listener.incoming() {
                let Ok(stream) = connection else { continue };
                let _ = stream.set_read_timeout(Some(Duration::from_millis(250)));
                let mut bytes = Vec::new();
                match stream
                    .take(1024 * 1024)
                    .read_to_end(&mut bytes)
                    .map(|_| decode_wire_payload(&bytes))
                {
                    Ok(Ok(Some(payload))) => {
                        rollout_observer::handle_hook_event(
                            &payload.event,
                            payload.transcript_path.as_deref(),
                        );
                        emit_event(&app, payload.event);
                    }
                    Ok(Ok(None)) => {}
                    Ok(Err(_)) => emit_parse_error(&app),
                    Err(_) => emit_parse_error(&app),
                }
            }
            RECEIVER_RUNNING.store(false, Ordering::Release);
        })
        .map_err(|error| format!("启动 Hook 服务失败：{error}"));
    if spawn_result.is_err() {
        RECEIVER_RUNNING.store(false, Ordering::Release);
        rollout_observer::cleanup();
        cleanup_owned_socket();
    }
    spawn_result.map(|_| true)
}

pub fn cleanup() {
    RECEIVER_RUNNING.store(false, Ordering::Release);
    rollout_observer::cleanup();
    cleanup_owned_socket();
}

pub fn set_hooks_enabled(enabled: bool) {
    rollout_observer::set_enabled(enabled);
}

fn cleanup_owned_socket() {
    if !OWNS_SOCKET.swap(false, Ordering::AcqRel) {
        return;
    }
    if let Ok(socket) = socket_path() {
        transport::remove_owned_endpoint(&socket);
    }
}

fn notify_existing_receiver(socket: &std::path::Path) -> bool {
    let Ok(mut stream) = transport::connect(socket) else {
        return false;
    };
    let _ = stream.set_write_timeout(Some(Duration::from_millis(150)));
    let _ = stream.write_all(HEALTH_CHECK_PAYLOAD);
    let _ = stream.shutdown(std::net::Shutdown::Write);
    true
}

fn decode_wire_payload(bytes: &[u8]) -> Result<Option<DecodedHookPayload>, String> {
    if bytes == HEALTH_CHECK_PAYLOAD {
        return Ok(None);
    }
    if let Ok(payload) = serde_json::from_slice::<HookWirePayload>(bytes) {
        if payload.wire_version != 2 {
            return Err("unsupported hook wire version".into());
        }
        let event = validate_incoming_event(payload.event)?;
        return Ok(Some(DecodedHookPayload {
            event,
            transcript_path: payload.transcript_path.map(PathBuf::from),
        }));
    }
    let event = serde_json::from_slice::<AgentEvent>(bytes).map_err(|error| error.to_string())?;
    Ok(Some(DecodedHookPayload {
        event: validate_incoming_event(event)?,
        transcript_path: None,
    }))
}

pub fn test_event(app: &AppHandle, event: &str) -> Result<(), String> {
    if !DISPLAY_EVENTS.contains(&event) {
        return Err("不支持的测试事件".into());
    }
    emit_event(
        app,
        AgentEvent {
            version: 1,
            agent: "codex".into(),
            session_id: "agent-cat-test".into(),
            event: event.into(),
            timestamp: now_ms(),
            title: (event == "UserPromptSubmit").then(|| "Agent Cat 实时状态测试".into()),
            tool_name: matches!(event, "PreToolUse" | "PostToolUse").then(|| "apply_patch".into()),
            turn_id: None,
            session_source: None,
            compact_trigger: None,
        },
    );
    Ok(())
}

pub fn runtime_status() -> HookRuntimeStatus {
    let verified_at = crate::hook_verification::verified_at();
    let latest_real = verified_at.and_then(|_| latest_real_event());
    HookRuntimeStatus {
        receiver_running: RECEIVER_RUNNING.load(Ordering::Acquire),
        socket_path: socket_path()
            .map(|path| path.to_string_lossy().to_string())
            .unwrap_or_default(),
        verified_at,
        last_real_event_at: latest_real.as_ref().map(|event| event.timestamp),
        last_real_event: latest_real.as_ref().map(|event| event.event.clone()),
    }
}

pub fn probe_hook() -> Result<HookRuntimeStatus, String> {
    if !RECEIVER_RUNNING.load(Ordering::Acquire) {
        return Err("Hook 状态接收器未运行，请重启 Agent Cat".into());
    }
    let timestamp = now_ms();
    let session_id = format!("agent-cat-probe-{timestamp}");
    let turn_id = format!("probe-turn-{timestamp}");
    relay_probe_event(serde_json::json!({
        "session_id": &session_id,
        "hook_event_name": "Stop",
        "turn_id": &turn_id,
        "display_title": "Agent Cat 连接测试"
    }))?;
    if !wait_for_probe_event(&session_id, "Stop") {
        return Err("Hook 测试结束事件未到达 Agent Cat，请尝试重启应用".into());
    }
    Ok(runtime_status())
}

fn relay_probe_event(payload: serde_json::Value) -> Result<(), String> {
    let payload = serde_json::to_vec(&payload).map_err(|error| error.to_string())?;
    let executable = std::env::current_exe()
        .map_err(|error| format!("无法确定 Agent Cat 可执行文件：{error}"))?;
    let mut child = Command::new(executable)
        .args(["hook", "--agent", "codex"])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("无法启动 Hook 测试：{error}"))?;
    child
        .stdin
        .take()
        .ok_or_else(|| "无法写入 Hook 测试输入".to_string())?
        .write_all(&payload)
        .map_err(|error| format!("写入 Hook 测试失败：{error}"))?;
    let result = child
        .wait()
        .map_err(|error| format!("等待 Hook 测试失败：{error}"))?;
    if !result.success() {
        return Err("Hook 测试进程异常退出".into());
    }
    Ok(())
}

fn wait_for_probe_event(session_id: &str, event: &str) -> bool {
    let deadline = Instant::now() + Duration::from_millis(500);
    while Instant::now() < deadline {
        if latest_event()
            .as_ref()
            .map(|value| value.session_id == session_id && value.event == event)
            .unwrap_or(false)
        {
            return true;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    false
}

fn emit_parse_error(app: &AppHandle) {
    emit_event(
        app,
        AgentEvent {
            version: 1,
            agent: "codex".into(),
            session_id: "unknown".into(),
            event: "HookParseError".into(),
            timestamp: now_ms(),
            title: None,
            tool_name: None,
            turn_id: None,
            session_source: None,
            compact_trigger: None,
        },
    );
}

fn emit_event(app: &AppHandle, event: AgentEvent) {
    if is_real_codex_event(&event) {
        if let Ok(mut latest) = LATEST_REAL_EVENT.get_or_init(|| Mutex::new(None)).lock() {
            *latest = Some(event.clone());
        }
        let _ = crate::hook_verification::record(event.timestamp);
    }
    agent_events::publish(app, event);
}

pub fn latest_event() -> Option<AgentEvent> {
    agent_events::latest()
}

fn latest_real_event() -> Option<AgentEvent> {
    LATEST_REAL_EVENT
        .get_or_init(|| Mutex::new(None))
        .lock()
        .ok()
        .and_then(|event| event.clone())
}

fn is_real_codex_event(event: &AgentEvent) -> bool {
    event.event != "HookParseError"
        && !event.session_id.starts_with("agent-cat-test")
        && !event.session_id.starts_with("agent-cat-probe")
}

fn build_event(
    input: CodexInput,
    show_task_summary: bool,
    timestamp: u64,
) -> Result<AgentEvent, String> {
    let event = input
        .hook_event_name
        .ok_or_else(|| "hook_event_name missing".to_string())?;
    if !HOOK_EVENTS.contains(&event.as_str()) {
        return Err("unsupported hook event".into());
    }
    let title = input
        .display_title
        .as_deref()
        .and_then(sanitize_display_text)
        .or_else(|| {
            if show_task_summary && event == "UserPromptSubmit" {
                input.prompt.as_deref().and_then(summarize_prompt)
            } else {
                None
            }
        });
    Ok(AgentEvent {
        version: 1,
        agent: "codex".into(),
        session_id: input.session_id.unwrap_or_else(|| "unknown".into()),
        event,
        timestamp,
        title,
        tool_name: input.tool_name.as_deref().and_then(sanitize_tool_name),
        turn_id: input.turn_id.as_deref().and_then(sanitize_identifier),
        session_source: input.source.as_deref().and_then(sanitize_hook_token),
        compact_trigger: input.trigger.as_deref().and_then(sanitize_hook_token),
    })
}

fn validate_incoming_event(mut event: AgentEvent) -> Result<AgentEvent, String> {
    if event.version != 1 || event.agent != "codex" {
        return Err("unsupported event envelope".into());
    }
    if !HOOK_EVENTS.contains(&event.event.as_str()) {
        return Err("unsupported hook event".into());
    }
    if event.session_id.is_empty() || event.session_id.chars().count() > 256 {
        return Err("invalid session id".into());
    }
    event.title = event.title.as_deref().and_then(sanitize_display_text);
    event.tool_name = event.tool_name.as_deref().and_then(sanitize_tool_name);
    event.turn_id = event.turn_id.as_deref().and_then(sanitize_identifier);
    event.session_source = event
        .session_source
        .as_deref()
        .and_then(sanitize_hook_token);
    event.compact_trigger = event
        .compact_trigger
        .as_deref()
        .and_then(sanitize_hook_token);
    Ok(event)
}

fn summarize_prompt(prompt: &str) -> Option<String> {
    let mut skipping_files = false;
    let line = prompt.lines().find_map(|line| {
        let value = line.trim();
        if value.eq_ignore_ascii_case("# Files mentioned by the user:") {
            skipping_files = true;
            return None;
        }
        if value.eq_ignore_ascii_case("# My request for Codex:") {
            skipping_files = false;
            return None;
        }
        if skipping_files || value.is_empty() || value.starts_with("```") {
            return None;
        }
        let value = value.trim_start_matches(|character: char| {
            character.is_whitespace() || matches!(character, '#' | '>' | '-' | '*' | '`')
        });
        (!value.is_empty()).then_some(value)
    })?;
    let normalized = line.split_whitespace().collect::<Vec<_>>().join(" ");
    truncate_chars(&normalized, 80)
}

fn sanitize_tool_name(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty()
        || !value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '_' | '-' | ':' | '.')
        })
    {
        return None;
    }
    truncate_chars(value, 64)
}

fn sanitize_identifier(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty()
        || value.chars().count() > 256
        || !value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return None;
    }
    Some(value.to_string())
}

fn sanitize_hook_token(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty()
        || value.chars().count() > 32
        || !value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return None;
    }
    Some(value.to_ascii_lowercase())
}

fn sanitize_display_text(value: &str) -> Option<String> {
    let normalized = value
        .chars()
        .map(|character| {
            if character.is_control() {
                ' '
            } else {
                character
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    truncate_chars(&normalized, 80)
}

fn truncate_chars(value: &str, limit: usize) -> Option<String> {
    if value.is_empty() {
        return None;
    }
    let mut characters = value.chars();
    let prefix: String = characters.by_ref().take(limit).collect();
    if characters.next().is_some() {
        let mut shortened: String = prefix.chars().take(limit.saturating_sub(1)).collect();
        shortened.push('…');
        Some(shortened)
    } else {
        Some(prefix)
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prompt_summary_skips_attachment_wrapper_and_limits_unicode() {
        let prompt =
            "# Files mentioned by the user:\n\n/tmp/private.png\n\n# My request for Codex:\n\n"
                .to_string()
                + &"猫".repeat(100);
        let summary = summarize_prompt(&prompt).unwrap();
        assert_eq!(summary.chars().count(), 80);
        assert!(summary.ends_with('…'));
        assert!(!summary.contains("private"));
    }

    #[test]
    fn event_only_includes_opted_in_summary_and_safe_tool_name() {
        let input = CodexInput {
            session_id: Some("session".into()),
            hook_event_name: Some("UserPromptSubmit".into()),
            turn_id: Some("turn-1".into()),
            transcript_path: None,
            display_title: None,
            source: None,
            trigger: None,
            prompt: Some("修复实时状态显示".into()),
            tool_name: Some("bad tool name".into()),
        };
        let event = build_event(input, false, 42).unwrap();
        assert_eq!(event.timestamp, 42);
        assert_eq!(event.title, None);
        assert_eq!(event.tool_name, None);
        assert_eq!(event.turn_id.as_deref(), Some("turn-1"));
    }

    #[test]
    fn explicit_display_title_is_sanitized_without_task_summaries() {
        let input: CodexInput = serde_json::from_value(serde_json::json!({
            "session_id": "agent-cat-probe-1",
            "hook_event_name": "Stop",
            "turn_id": "probe-turn-1",
            "display_title": " Agent Cat\n连接测试 "
        }))
        .unwrap();
        let event = build_event(input, false, 42).unwrap();
        assert_eq!(event.title.as_deref(), Some("Agent Cat 连接测试"));
    }

    #[test]
    fn rejects_unknown_events_and_sanitizes_socket_payloads() {
        let unknown = CodexInput {
            session_id: Some("session".into()),
            hook_event_name: Some("FutureEvent".into()),
            turn_id: None,
            transcript_path: None,
            display_title: None,
            source: None,
            trigger: None,
            prompt: None,
            tool_name: None,
        };
        assert!(build_event(unknown, false, 42).is_err());

        let event = validate_incoming_event(AgentEvent {
            version: 1,
            agent: "codex".into(),
            session_id: "session".into(),
            event: "PreToolUse".into(),
            timestamp: 42,
            title: Some("  hello\nworld  ".into()),
            tool_name: Some("bad tool".into()),
            turn_id: Some("turn-1".into()),
            session_source: Some("COMPACT".into()),
            compact_trigger: Some("manual".into()),
        })
        .unwrap();
        assert_eq!(event.title.as_deref(), Some("hello world"));
        assert_eq!(event.tool_name, None);
        assert_eq!(event.session_source.as_deref(), Some("compact"));
    }

    #[test]
    fn health_check_does_not_emit_a_parse_error() {
        assert!(decode_wire_payload(HEALTH_CHECK_PAYLOAD).unwrap().is_none());
        assert!(decode_wire_payload(b"").is_err());
    }

    #[test]
    fn only_real_codex_events_can_verify_the_integration() {
        let event = |session_id: &str, name: &str| AgentEvent {
            version: 1,
            agent: "codex".into(),
            session_id: session_id.into(),
            event: name.into(),
            timestamp: 42,
            title: None,
            tool_name: None,
            turn_id: None,
            session_source: None,
            compact_trigger: None,
        };

        assert!(is_real_codex_event(&event("session-1", "SessionStart")));
        assert!(!is_real_codex_event(&event("agent-cat-test", "Stop")));
        assert!(!is_real_codex_event(&event("agent-cat-probe-1", "Stop")));
        assert!(!is_real_codex_event(&event("unknown", "HookParseError")));
    }

    #[test]
    fn versioned_wire_payload_keeps_observer_path_inside_the_backend() {
        let payload = HookWirePayload {
            wire_version: 2,
            event: AgentEvent {
                version: 1,
                agent: "codex".into(),
                session_id: "session".into(),
                event: "SessionEnd".into(),
                timestamp: 42,
                title: None,
                tool_name: None,
                turn_id: Some("turn-1".into()),
                session_source: None,
                compact_trigger: None,
            },
            transcript_path: Some("/private/transcript.jsonl".into()),
        };
        let decoded = decode_wire_payload(&serde_json::to_vec(&payload).unwrap())
            .unwrap()
            .unwrap();
        assert_eq!(decoded.event.event, "SessionEnd");
        assert_eq!(
            decoded.transcript_path.as_deref(),
            Some(std::path::Path::new("/private/transcript.jsonl"))
        );
    }
}
