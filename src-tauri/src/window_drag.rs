use serde::Serialize;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, WebviewWindow};

#[cfg(target_os = "windows")]
mod windows;

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CompletionMode {
    Native,
    Webview,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DragEnded {
    pub drag_id: u64,
}

#[derive(Debug, Default)]
struct NativeDragRegistry {
    active: Option<NativeDragSession>,
}

#[derive(Debug, Clone, Copy)]
struct NativeDragSession {
    id: u64,
    entered: bool,
}

impl NativeDragRegistry {
    fn begin(&mut self, id: u64) -> Result<(), String> {
        if self.active.is_some() {
            return Err("已有窗口拖动正在进行".into());
        }
        self.active = Some(NativeDragSession { id, entered: false });
        Ok(())
    }

    fn entered(&mut self) {
        if let Some(active) = self.active.as_mut() {
            active.entered = true;
        }
    }

    fn cancel(&mut self, id: u64) {
        if self.active.is_some_and(|active| active.id == id) {
            self.active = None;
        }
    }

    fn finish(&mut self) -> Option<u64> {
        let active = self.active.filter(|active| active.entered)?;
        self.active = None;
        Some(active.id)
    }
}

#[derive(Default)]
pub struct WindowDragState(Mutex<NativeDragRegistry>);

pub fn install(window: &WebviewWindow, app: AppHandle) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    return windows::install(window, app);

    #[cfg(not(target_os = "windows"))]
    {
        let _ = (window, app);
        Ok(())
    }
}

pub fn start(app: &AppHandle, drag_id: u64) -> Result<CompletionMode, String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "宠物窗口不存在".to_string())?;

    #[cfg(target_os = "windows")]
    app.state::<WindowDragState>()
        .0
        .lock()
        .map_err(|_| "窗口拖动状态不可用".to_string())?
        .begin(drag_id)?;

    if let Err(error) = window.start_dragging() {
        #[cfg(target_os = "windows")]
        if let Ok(mut state) = app.state::<WindowDragState>().0.lock() {
            state.cancel(drag_id);
        }
        return Err(error.to_string());
    }

    Ok(if cfg!(target_os = "windows") {
        CompletionMode::Native
    } else {
        CompletionMode::Webview
    })
}

#[cfg(target_os = "windows")]
fn mark_entered(app: &AppHandle) {
    if let Ok(mut state) = app.state::<WindowDragState>().0.lock() {
        state.entered();
    }
}

#[cfg(target_os = "windows")]
fn finish(app: &AppHandle) -> Option<DragEnded> {
    let drag_id = app.state::<WindowDragState>().0.lock().ok()?.finish()?;
    Some(DragEnded { drag_id })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_finishes_a_drag_that_entered_the_native_move_loop() {
        let mut registry = NativeDragRegistry::default();
        registry.begin(7).unwrap();
        assert_eq!(registry.finish(), None);
        registry.entered();
        assert_eq!(registry.finish(), Some(7));
        assert_eq!(registry.finish(), None);
    }

    #[test]
    fn rejects_overlapping_drags_and_cancels_only_the_matching_session() {
        let mut registry = NativeDragRegistry::default();
        registry.begin(7).unwrap();
        assert!(registry.begin(8).is_err());
        registry.cancel(8);
        assert!(registry.begin(8).is_err());
        registry.cancel(7);
        assert!(registry.begin(8).is_ok());
    }
}
