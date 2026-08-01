use serde::Serialize;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
use windows_sys::Win32::{
    Foundation::{HWND, LPARAM, LRESULT, WPARAM},
    UI::{
        Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass},
        WindowsAndMessaging::{WM_ENTERSIZEMOVE, WM_EXITSIZEMOVE, WM_NCDESTROY},
    },
};

const SUBCLASS_ID: usize = 0x4147_4344;
const DRAG_ENDED_EVENT: &str = "agent-cat-drag-ended";

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CompletionMode {
    Native,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
struct DragEnded {
    drag_id: u64,
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

pub struct WindowDragState(Mutex<NativeDragRegistry>);

impl WindowDragState {
    pub fn new() -> Self {
        Self(Mutex::new(NativeDragRegistry::default()))
    }
}

pub fn install(window: &WebviewWindow, app: AppHandle) -> Result<(), String> {
    let hwnd = window.hwnd().map_err(|error| error.to_string())?.0;
    let app = Box::into_raw(Box::new(app)) as usize;
    if unsafe { SetWindowSubclass(hwnd, Some(subclass_proc), SUBCLASS_ID, app) } == 0 {
        unsafe { drop(Box::from_raw(app as *mut AppHandle)) };
        return Err(std::io::Error::last_os_error().to_string());
    }
    Ok(())
}

pub fn start(app: &AppHandle, drag_id: u64) -> Result<CompletionMode, String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "宠物窗口不存在".to_string())?;
    app.state::<WindowDragState>()
        .0
        .lock()
        .map_err(|_| "窗口拖动状态不可用".to_string())?
        .begin(drag_id)?;

    if let Err(error) = window.start_dragging() {
        if let Ok(mut state) = app.state::<WindowDragState>().0.lock() {
            state.cancel(drag_id);
        }
        return Err(error.to_string());
    }

    Ok(CompletionMode::Native)
}

fn mark_entered(app: &AppHandle) {
    if let Ok(mut state) = app.state::<WindowDragState>().0.lock() {
        state.entered();
    }
}

fn finish(app: &AppHandle) -> Option<DragEnded> {
    let drag_id = app.state::<WindowDragState>().0.lock().ok()?.finish()?;
    Some(DragEnded { drag_id })
}

unsafe extern "system" fn subclass_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    subclass_id: usize,
    app: usize,
) -> LRESULT {
    let app_handle = &*(app as *const AppHandle);
    match message {
        WM_ENTERSIZEMOVE => mark_entered(app_handle),
        WM_EXITSIZEMOVE => {
            if let Some(payload) = finish(app_handle) {
                let _ = app_handle.emit_to("main", DRAG_ENDED_EVENT, payload);
            }
        }
        WM_NCDESTROY => {
            RemoveWindowSubclass(hwnd, Some(subclass_proc), subclass_id);
            drop(Box::from_raw(app as *mut AppHandle));
        }
        _ => {}
    }
    DefSubclassProc(hwnd, message, wparam, lparam)
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
