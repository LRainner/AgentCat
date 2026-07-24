use crate::config;
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{Read, Write},
    os::unix::{
        fs::FileTypeExt,
        net::{UnixListener, UnixStream},
    },
    path::PathBuf,
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex, OnceLock,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager};

const ALLOWED_EVENTS: [&str; 11] = [
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
    "HookParseError",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentEvent {
    pub version: u8,
    pub agent: String,
    pub session_id: String,
    pub event: String,
    pub timestamp: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
}

static LATEST_EVENT: OnceLock<Mutex<Option<AgentEvent>>> = OnceLock::new();
static RECEIVER_RUNNING: AtomicBool = AtomicBool::new(false);
static OWNS_SOCKET: AtomicBool = AtomicBool::new(false);
const HEALTH_CHECK_PAYLOAD: &[u8] = b"agent-cat-hook-health-v1";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HookRuntimeStatus {
    pub receiver_running: bool,
    pub socket_path: String,
    pub last_event_at: Option<u64>,
    pub last_event: Option<String>,
    pub last_event_is_test: bool,
}

#[derive(Debug, Deserialize)]
struct CodexInput {
    session_id: Option<String>,
    hook_event_name: Option<String>,
    prompt: Option<String>,
    tool_name: Option<String>,
}

pub fn socket_path() -> Result<PathBuf, String> {
    Ok(config::config_dir()?.join("agent-cat.sock"))
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
        let show_task_summary = config::load()
            .map(|value| value.codex.show_task_summary)
            .unwrap_or(false);
        let event = build_event(input, show_task_summary, now_ms())?;
        let mut stream = UnixStream::connect(socket_path()?).map_err(|error| error.to_string())?;
        stream
            .set_write_timeout(Some(Duration::from_millis(150)))
            .map_err(|error| error.to_string())?;
        let payload = serde_json::to_vec(&event).map_err(|error| error.to_string())?;
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
    if socket.exists() {
        if notify_existing_receiver(&socket) {
            return Ok(false);
        }
        let metadata = fs::symlink_metadata(&socket)
            .map_err(|error| format!("检查旧 socket 失败：{error}"))?;
        if !metadata.file_type().is_socket() {
            return Err(format!("{} 已存在且不是 Unix socket", socket.display()));
        }
        fs::remove_file(&socket).map_err(|error| format!("清理旧 socket 失败：{error}"))?;
    }
    let listener = UnixListener::bind(&socket)
        .map_err(|error| format!("绑定 {} 失败：{error}", socket.display()))?;
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
                    Ok(Ok(Some(event))) => emit_event(&app, event),
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
        cleanup_owned_socket();
    }
    spawn_result.map(|_| true)
}

pub fn cleanup() {
    RECEIVER_RUNNING.store(false, Ordering::Release);
    cleanup_owned_socket();
}

fn cleanup_owned_socket() {
    if !OWNS_SOCKET.swap(false, Ordering::AcqRel) {
        return;
    }
    if let Ok(socket) = socket_path() {
        let is_socket = fs::symlink_metadata(&socket)
            .map(|metadata| metadata.file_type().is_socket())
            .unwrap_or(false);
        if is_socket {
            let _ = fs::remove_file(socket);
        }
    }
}

fn notify_existing_receiver(socket: &std::path::Path) -> bool {
    let Ok(mut stream) = UnixStream::connect(socket) else {
        return false;
    };
    let _ = stream.set_write_timeout(Some(Duration::from_millis(150)));
    let _ = stream.write_all(HEALTH_CHECK_PAYLOAD);
    let _ = stream.shutdown(std::net::Shutdown::Write);
    true
}

fn decode_wire_payload(bytes: &[u8]) -> Result<Option<AgentEvent>, String> {
    if bytes == HEALTH_CHECK_PAYLOAD {
        return Ok(None);
    }
    let event = serde_json::from_slice::<AgentEvent>(bytes).map_err(|error| error.to_string())?;
    validate_incoming_event(event).map(Some)
}

pub fn test_event(app: &AppHandle, event: &str) -> Result<(), String> {
    if !ALLOWED_EVENTS.contains(&event) {
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
        },
    );
    Ok(())
}

pub fn runtime_status() -> HookRuntimeStatus {
    let latest = latest_event();
    HookRuntimeStatus {
        receiver_running: RECEIVER_RUNNING.load(Ordering::Acquire),
        socket_path: socket_path()
            .map(|path| path.to_string_lossy().to_string())
            .unwrap_or_default(),
        last_event_at: latest.as_ref().map(|event| event.timestamp),
        last_event: latest.as_ref().map(|event| event.event.clone()),
        last_event_is_test: latest
            .as_ref()
            .map(|event| {
                event.session_id.starts_with("agent-cat-test")
                    || event.session_id.starts_with("agent-cat-probe")
            })
            .unwrap_or(false),
    }
}

pub fn probe_hook() -> Result<HookRuntimeStatus, String> {
    if !RECEIVER_RUNNING.load(Ordering::Acquire) {
        return Err("Hook 状态接收器未运行，请重启 Agent Cat".into());
    }
    let timestamp = now_ms();
    let session_id = format!("agent-cat-probe-{timestamp}");
    let payload = serde_json::to_vec(&serde_json::json!({
        "session_id": session_id,
        "hook_event_name": "UserPromptSubmit",
        "prompt": "Agent Cat 连接测试"
    }))
    .map_err(|error| error.to_string())?;
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
    let deadline = Instant::now() + Duration::from_millis(500);
    while Instant::now() < deadline {
        if latest_event()
            .as_ref()
            .map(|event| event.session_id == session_id)
            .unwrap_or(false)
        {
            return Ok(runtime_status());
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    Err("Hook 测试事件未到达 Agent Cat，请尝试重启应用".into())
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
        },
    );
}

fn emit_event(app: &AppHandle, event: AgentEvent) {
    if let Ok(mut latest) = LATEST_EVENT.get_or_init(|| Mutex::new(None)).lock() {
        *latest = Some(event.clone());
    }
    let show_status = config::load()
        .map(|value| value.codex.hooks_enabled && value.codex.show_live_status)
        .unwrap_or(false);
    if show_status {
        if let Some(window) = app.get_webview_window("status") {
            let _ = window.show();
        }
    }
    let _ = app.emit_to("main", "codex-event", event.clone());
    let _ = app.emit_to("status", "codex-event", event);
}

pub fn latest_event() -> Option<AgentEvent> {
    LATEST_EVENT
        .get_or_init(|| Mutex::new(None))
        .lock()
        .ok()
        .and_then(|event| event.clone())
}

fn build_event(
    input: CodexInput,
    show_task_summary: bool,
    timestamp: u64,
) -> Result<AgentEvent, String> {
    let event = input
        .hook_event_name
        .ok_or_else(|| "hook_event_name missing".to_string())?;
    if !ALLOWED_EVENTS[..ALLOWED_EVENTS.len() - 1].contains(&event.as_str()) {
        return Err("unsupported hook event".into());
    }
    let title = if show_task_summary && event == "UserPromptSubmit" {
        input.prompt.as_deref().and_then(summarize_prompt)
    } else {
        None
    };
    Ok(AgentEvent {
        version: 1,
        agent: "codex".into(),
        session_id: input.session_id.unwrap_or_else(|| "unknown".into()),
        event,
        timestamp,
        title,
        tool_name: input.tool_name.as_deref().and_then(sanitize_tool_name),
    })
}

fn validate_incoming_event(mut event: AgentEvent) -> Result<AgentEvent, String> {
    if event.version != 1 || event.agent != "codex" {
        return Err("unsupported event envelope".into());
    }
    if !ALLOWED_EVENTS[..ALLOWED_EVENTS.len() - 1].contains(&event.event.as_str()) {
        return Err("unsupported hook event".into());
    }
    if event.session_id.is_empty() || event.session_id.chars().count() > 256 {
        return Err("invalid session id".into());
    }
    event.title = event.title.as_deref().and_then(sanitize_display_text);
    event.tool_name = event.tool_name.as_deref().and_then(sanitize_tool_name);
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
            prompt: Some("修复实时状态显示".into()),
            tool_name: Some("bad tool name".into()),
        };
        let event = build_event(input, false, 42).unwrap();
        assert_eq!(event.timestamp, 42);
        assert_eq!(event.title, None);
        assert_eq!(event.tool_name, None);
    }

    #[test]
    fn rejects_unknown_events_and_sanitizes_socket_payloads() {
        let unknown = CodexInput {
            session_id: Some("session".into()),
            hook_event_name: Some("FutureEvent".into()),
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
        })
        .unwrap();
        assert_eq!(event.title.as_deref(), Some("hello world"));
        assert_eq!(event.tool_name, None);
    }

    #[test]
    fn health_check_does_not_emit_a_parse_error() {
        assert!(decode_wire_payload(HEALTH_CHECK_PAYLOAD).unwrap().is_none());
        assert!(decode_wire_payload(b"").is_err());
    }
}
