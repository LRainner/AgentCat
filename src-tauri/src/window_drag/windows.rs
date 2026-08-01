use super::{finish, mark_entered};
use tauri::{AppHandle, Emitter, WebviewWindow};
use windows_sys::Win32::{
    Foundation::{HWND, LPARAM, LRESULT, WPARAM},
    UI::{
        Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass},
        WindowsAndMessaging::{WM_ENTERSIZEMOVE, WM_EXITSIZEMOVE, WM_NCDESTROY},
    },
};

const SUBCLASS_ID: usize = 0x4147_4344;
const DRAG_ENDED_EVENT: &str = "agent-cat-drag-ended";

pub fn install(window: &WebviewWindow, app: AppHandle) -> Result<(), String> {
    let hwnd = window.hwnd().map_err(|error| error.to_string())?.0;
    let app = Box::into_raw(Box::new(app)) as usize;
    if unsafe { SetWindowSubclass(hwnd, Some(subclass_proc), SUBCLASS_ID, app) } == 0 {
        unsafe { drop(Box::from_raw(app as *mut AppHandle)) };
        return Err(std::io::Error::last_os_error().to_string());
    }
    Ok(())
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
