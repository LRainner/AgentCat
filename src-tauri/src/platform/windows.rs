use std::{
    iter::once,
    mem::size_of,
    os::windows::ffi::OsStrExt,
    path::Path,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc, OnceLock,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::WebviewWindow;
use windows_sys::Win32::{
    Foundation::{HWND, RECT},
    Graphics::{
        Dwm::{DwmGetWindowAttribute, DWMWA_EXTENDED_FRAME_BOUNDS},
        Gdi::{GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST},
    },
    Storage::FileSystem::{MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH},
    UI::{
        Accessibility::{SetWinEventHook, HWINEVENTHOOK},
        Shell::{SHQueryUserNotificationState, ShellExecuteW, QUNS_RUNNING_D3D_FULL_SCREEN},
        WindowsAndMessaging::{
            DispatchMessageW, GetClassNameW, GetForegroundWindow, GetMessageW, GetShellWindow,
            GetWindowRect, IsZoomed, ShowWindow, TranslateMessage, CHILDID_SELF,
            EVENT_OBJECT_LOCATIONCHANGE, EVENT_SYSTEM_FOREGROUND, MSG, OBJID_WINDOW, SW_SHOWNA,
            SW_SHOWNORMAL, WINEVENT_OUTOFCONTEXT, WINEVENT_SKIPOWNPROCESS,
        },
    },
};

/// Class names of the shell's desktop windows. They cover a monitor without
/// being maximised, so they would otherwise read as fullscreen.
const SHELL_DESKTOP_CLASSES: [&str; 2] = ["Progman", "WorkerW"];

/// The shell query is comparatively slow and location events arrive at drag rate,
/// so its answer is reused for a short window.
const SHELL_STATE_TTL_MS: u64 = 200;

static SENDER: OnceLock<mpsc::Sender<bool>> = OnceLock::new();
static REPORTED_ONCE: AtomicBool = AtomicBool::new(false);
static LAST_REPORTED: AtomicBool = AtomicBool::new(false);
static SHELL_CHECKED_AT: AtomicU64 = AtomicU64::new(0);
static SHELL_FULLSCREEN: AtomicBool = AtomicBool::new(false);

pub fn replace_file(source: &Path, destination: &Path) -> std::io::Result<()> {
    let source: Vec<u16> = source.as_os_str().encode_wide().chain(once(0)).collect();
    let destination: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(once(0))
        .collect();
    let result = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

pub fn reveal_in_file_manager(path: &Path) -> Result<(), String> {
    let operation: Vec<u16> = "open".encode_utf16().chain(once(0)).collect();
    let path: Vec<u16> = path.as_os_str().encode_wide().chain(once(0)).collect();
    let result = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            operation.as_ptr(),
            path.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            SW_SHOWNORMAL,
        )
    };
    let status = result as isize;
    if status <= 32 {
        Err(format!(
            "无法在文件资源管理器中打开（ShellExecuteW 错误码 {status}）"
        ))
    } else {
        Ok(())
    }
}

/// Shows the pet without activating Agent Cat.
///
/// `WebviewWindow::show` activates the window, which would take keyboard focus
/// away from whatever the user is doing, so an automatic restore shows it with
/// `SW_SHOWNA` instead.
pub fn reveal_without_focus(window: &WebviewWindow) -> Result<(), String> {
    let hwnd = window.hwnd().map_err(|error| error.to_string())?.0;
    unsafe { ShowWindow(hwnd, SW_SHOWNA) };
    Ok(())
}

/// Watches shell window events and forwards fullscreen transitions.
///
/// `EVENT_SYSTEM_FOREGROUND` covers switching windows, while a narrow
/// `EVENT_OBJECT_LOCATIONCHANGE` hook covers going fullscreen in place: pressing
/// F11 or starting a video resizes the current window without changing which
/// window is in the foreground.
pub fn start_fullscreen_observer<F>(on_change: F) -> Result<(), String>
where
    F: Fn(bool) + Send + 'static,
{
    let (sender, receiver) = mpsc::channel::<bool>();
    SENDER
        .set(sender)
        .map_err(|_| "全屏观察器已经启动".to_string())?;
    std::thread::Builder::new()
        .name("agent-cat-fullscreen".into())
        .spawn(move || {
            for fullscreen in receiver {
                on_change(fullscreen);
            }
        })
        .map_err(|error| format!("启动全屏监听线程失败：{error}"))?;
    std::thread::Builder::new()
        .name("agent-cat-winevent".into())
        .spawn(observe_window_events)
        .map_err(|error| format!("启动全屏事件线程失败：{error}"))?;
    Ok(())
}

fn observe_window_events() {
    // Each hook watches a single event id; spanning both would subscribe to
    // every event in between and flood the callback. Agent Cat's own windows are
    // skipped because the status bubble repositions on every agent event.
    let foreground = unsafe {
        SetWinEventHook(
            EVENT_SYSTEM_FOREGROUND,
            EVENT_SYSTEM_FOREGROUND,
            std::ptr::null_mut(),
            Some(window_event_proc),
            0,
            0,
            WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS,
        )
    };
    let location = unsafe {
        SetWinEventHook(
            EVENT_OBJECT_LOCATIONCHANGE,
            EVENT_OBJECT_LOCATIONCHANGE,
            std::ptr::null_mut(),
            Some(window_event_proc),
            0,
            0,
            WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS,
        )
    };
    report(is_fullscreen_active());
    if foreground.is_null() || location.is_null() {
        // Without hooks nothing else would notice a transition, so the desktop
        // has to be sampled instead. This never returns.
        poll_forever();
    }
    // Out-of-context hooks deliver events through this thread's message queue.
    let mut message = MSG::default();
    while unsafe { GetMessageW(&mut message, std::ptr::null_mut(), 0, 0) } > 0 {
        unsafe {
            TranslateMessage(&message);
            DispatchMessageW(&message);
        }
    }
}

fn poll_forever() -> ! {
    loop {
        std::thread::sleep(Duration::from_millis(1_000));
        report(is_fullscreen_active());
    }
}

unsafe extern "system" fn window_event_proc(
    _hook: HWINEVENTHOOK,
    event: u32,
    hwnd: HWND,
    id_object: i32,
    id_child: i32,
    _thread: u32,
    _time: u32,
) {
    // Location changes arrive for every window on the desktop, but only the
    // foreground window can become fullscreen.
    if event == EVENT_OBJECT_LOCATIONCHANGE {
        if id_object != OBJID_WINDOW
            || id_child as u32 != CHILDID_SELF
            || hwnd != unsafe { GetForegroundWindow() }
        {
            return;
        }
        report(is_fullscreen_active_throttled());
        return;
    }
    report(is_fullscreen_active());
}

fn report(fullscreen: bool) {
    // The first observation always reaches the application so the state seen at
    // startup is applied, including when it is `false`. Later duplicates are
    // dropped to keep location events, which arrive at drag rate, off the channel.
    let first = !REPORTED_ONCE.swap(true, Ordering::AcqRel);
    if !first && LAST_REPORTED.load(Ordering::Acquire) == fullscreen {
        return;
    }
    LAST_REPORTED.store(fullscreen, Ordering::Release);
    if let Some(sender) = SENDER.get() {
        let _ = sender.send(fullscreen);
    }
}

fn is_fullscreen_active() -> bool {
    // An exclusive Direct3D surface keeps an ordinary window rectangle, so the
    // shell state is the only signal for it.
    if shell_reports_fullscreen(false) {
        return true;
    }
    let hwnd = unsafe { GetForegroundWindow() };
    !hwnd.is_null() && foreground_covers_monitor(hwnd)
}

/// The same check for the location-change path.
///
/// Those events arrive at drag rate, but a resize cannot change the exclusive
/// Direct3D state, so the shell answer is reused instead of queried again.
fn is_fullscreen_active_throttled() -> bool {
    if shell_reports_fullscreen(true) {
        return true;
    }
    let hwnd = unsafe { GetForegroundWindow() };
    !hwnd.is_null() && foreground_covers_monitor(hwnd)
}

fn shell_reports_fullscreen(reuse_answer: bool) -> bool {
    let now = now_millis();
    if reuse_answer
        && now.saturating_sub(SHELL_CHECKED_AT.load(Ordering::Acquire)) < SHELL_STATE_TTL_MS
    {
        return SHELL_FULLSCREEN.load(Ordering::Acquire);
    }
    let mut state = 0;
    // A failure only means the shell could not answer, which is not fullscreen.
    let result = unsafe { SHQueryUserNotificationState(&mut state) };
    // Only an exclusive Direct3D surface is a fullscreen signal by itself.
    // `QUNS_PRESENTATION_MODE` and `QUNS_BUSY` also cover presentation settings,
    // which can be enabled while no window is fullscreen, so those states are left
    // to the foreground coverage check instead of hiding the pet on their own.
    let fullscreen = result >= 0 && state == QUNS_RUNNING_D3D_FULL_SCREEN;
    SHELL_FULLSCREEN.store(fullscreen, Ordering::Release);
    SHELL_CHECKED_AT.store(now, Ordering::Release);
    fullscreen
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// Reports whether the window is the shell's desktop surface.
///
/// Clicking the desktop makes it the foreground window, and it spans the whole
/// monitor without being maximised, so it has to be excluded before the frame
/// comparison or every click on the desktop would look like fullscreen.
fn is_shell_desktop_window(hwnd: HWND) -> bool {
    if hwnd == unsafe { GetShellWindow() } {
        return true;
    }
    let mut buffer = [0u16; 64];
    let length = unsafe { GetClassNameW(hwnd, buffer.as_mut_ptr(), buffer.len() as i32) };
    if length <= 0 {
        return false;
    }
    let class = String::from_utf16_lossy(&buffer[..length as usize]);
    SHELL_DESKTOP_CLASSES
        .iter()
        .any(|name| class.eq_ignore_ascii_case(name))
}

fn foreground_covers_monitor(hwnd: HWND) -> bool {
    if is_shell_desktop_window(hwnd) {
        return false;
    }
    // A maximised window reports a rectangle that overhangs the monitor by the
    // invisible resize border, which would otherwise read as fullscreen.
    if unsafe { IsZoomed(hwnd) } != 0 {
        return false;
    }
    let Some(frame) = window_frame(hwnd) else {
        return false;
    };
    let Some(monitor) = monitor_bounds(hwnd) else {
        return false;
    };
    super::rect_covers(edges(&frame), edges(&monitor))
}

fn edges(rect: &RECT) -> super::frame::Edges {
    (
        f64::from(rect.left),
        f64::from(rect.top),
        f64::from(rect.right),
        f64::from(rect.bottom),
    )
}

fn window_frame(hwnd: HWND) -> Option<RECT> {
    // Extended frame bounds exclude the invisible resize border.
    let mut frame = RECT::default();
    let result = unsafe {
        DwmGetWindowAttribute(
            hwnd,
            DWMWA_EXTENDED_FRAME_BOUNDS as u32,
            (&mut frame as *mut RECT).cast(),
            size_of::<RECT>() as u32,
        )
    };
    if result >= 0 {
        return Some(frame);
    }
    let mut fallback = RECT::default();
    (unsafe { GetWindowRect(hwnd, &mut fallback) } != 0).then_some(fallback)
}

fn monitor_bounds(hwnd: HWND) -> Option<RECT> {
    let monitor = unsafe { MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST) };
    if monitor.is_null() {
        return None;
    }
    let mut info = MONITORINFO {
        cbSize: size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };
    (unsafe { GetMonitorInfoW(monitor, &mut info) } != 0).then_some(info.rcMonitor)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The desktop spans the monitor without being maximised, so it has to be
    /// excluded or every click on it would read as fullscreen.
    #[test]
    fn recognises_the_shell_desktop_window() {
        let shell = unsafe { GetShellWindow() };
        if shell.is_null() {
            // A session without an interactive desktop exposes no shell window.
            return;
        }
        assert!(is_shell_desktop_window(shell));
        assert!(!is_shell_desktop_window(std::ptr::null_mut()));
    }

    /// The first observation has to be delivered so that a pet started while an
    /// application is already fullscreen hides, and duplicates have to be dropped
    /// because location events arrive at drag rate.
    #[test]
    fn reports_the_first_observation_and_then_only_changes() {
        let (sender, receiver) = mpsc::channel();
        assert!(
            SENDER.set(sender).is_ok(),
            "the report channel is claimed once"
        );
        report(true);
        assert_eq!(receiver.try_recv().ok(), Some(true));
        report(true);
        assert_eq!(receiver.try_recv().ok(), None);
        report(false);
        assert_eq!(receiver.try_recv().ok(), Some(false));
    }
}
