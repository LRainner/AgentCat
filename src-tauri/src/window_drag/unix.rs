use serde::Serialize;
use tauri::{AppHandle, Manager, WebviewWindow};

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CompletionMode {
    Webview,
}

pub struct WindowDragState;

impl WindowDragState {
    pub fn new() -> Self {
        Self
    }
}

pub fn install(_window: &WebviewWindow, _app: AppHandle) -> Result<(), String> {
    Ok(())
}

pub fn start(app: &AppHandle, _drag_id: u64) -> Result<CompletionMode, String> {
    app.get_webview_window("main")
        .ok_or_else(|| "宠物窗口不存在".to_string())?
        .start_dragging()
        .map_err(|error| error.to_string())?;
    Ok(CompletionMode::Webview)
}
