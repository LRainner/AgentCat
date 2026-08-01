use serde::{Deserialize, Serialize};
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter};

pub const CHANNEL: &str = "agent-event";

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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compact_trigger: Option<String>,
}

static LATEST_EVENT: OnceLock<Mutex<Option<AgentEvent>>> = OnceLock::new();

pub fn publish(app: &AppHandle, event: AgentEvent) {
    if let Ok(mut latest) = LATEST_EVENT.get_or_init(|| Mutex::new(None)).lock() {
        *latest = Some(event.clone());
    }
    let _ = app.emit_to("main", CHANNEL, event.clone());
    let _ = app.emit_to("status", CHANNEL, event.clone());
    let _ = app.emit_to("settings", CHANNEL, event);
}

pub fn latest() -> Option<AgentEvent> {
    LATEST_EVENT
        .get_or_init(|| Mutex::new(None))
        .lock()
        .ok()
        .and_then(|event| event.clone())
}
