use std::{
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
};

use block2::RcBlock;
use core_foundation::{
    array::CFArray,
    base::{CFType, ItemRef, TCFType},
    dictionary::CFDictionary,
    number::CFNumber,
    string::CFString,
};
use core_graphics::{
    display::CGDisplay,
    geometry::CGRect,
    window::{
        copy_window_info, kCGWindowListExcludeDesktopElements, kCGWindowListOptionOnScreenOnly,
    },
};
use objc2_app_kit::{
    NSWindow, NSWorkspace, NSWorkspaceActiveSpaceDidChangeNotification,
    NSWorkspaceDidActivateApplicationNotification,
};
use objc2_foundation::{NSNotification, NSOperationQueue};
use tauri::WebviewWindow;

const OWNER_PID_KEY: &str = "kCGWindowOwnerPID";
const LAYER_KEY: &str = "kCGWindowLayer";
const BOUNDS_KEY: &str = "kCGWindowBounds";

static STARTED: AtomicBool = AtomicBool::new(false);

pub fn replace_file(source: &Path, destination: &Path) -> std::io::Result<()> {
    std::fs::rename(source, destination)
}

pub fn reveal_in_file_manager(path: &Path) -> Result<(), String> {
    std::process::Command::new("open")
        .arg(path)
        .spawn()
        .map_err(|error| format!("无法在 Finder 中打开：{error}"))?;
    Ok(())
}

/// Shows the pet without activating Agent Cat.
///
/// `WebviewWindow::show` reaches `makeKeyAndOrderFront:`, which would take
/// keyboard focus away from whatever the user is doing, so an automatic restore
/// orders the window front instead.
pub fn reveal_without_focus(window: &WebviewWindow) -> Result<(), String> {
    let handle = window.ns_window().map_err(|error| error.to_string())?;
    if handle.is_null() {
        return Err("宠物窗口句柄不可用".to_string());
    }
    // Only reached from the main thread, which is where AppKit requires this.
    let ns_window: &NSWindow = unsafe { &*handle.cast() };
    ns_window.orderFront(None);
    Ok(())
}

/// Watches Space and activation changes on the main queue and forwards transitions.
///
/// Entering fullscreen moves an app to its own Space, so the Space-change
/// notification is the only signal available without polling. Activation is also
/// needed because the check follows the frontmost application: each display owns
/// its own Space, so focusing a window on another display changes which
/// application is frontmost without changing any Space.
pub fn start_fullscreen_observer<F>(on_change: F) -> Result<(), String>
where
    F: Fn(bool) + Send + 'static,
{
    if STARTED.swap(true, Ordering::AcqRel) {
        return Ok(());
    }
    let (sender, receiver) = mpsc::channel::<bool>();
    std::thread::Builder::new()
        .name("agent-cat-fullscreen".into())
        .spawn(move || {
            // `None` lets the first observation through, so the state seen at
            // startup is always applied, including when it is `false`.
            let mut reported: Option<bool> = None;
            for fullscreen in receiver {
                if reported != Some(fullscreen) {
                    reported = Some(fullscreen);
                    on_change(fullscreen);
                }
            }
        })
        .map_err(|error| format!("启动全屏监听线程失败：{error}"))?;

    let workspace = NSWorkspace::sharedWorkspace();
    let center = workspace.notificationCenter();
    // The notifications arrive on the main queue, where AppKit requires every
    // window and application query below to run.
    let block = {
        let sender = sender.clone();
        RcBlock::new(move |_notification: std::ptr::NonNull<NSNotification>| {
            if let Some(fullscreen) = fullscreen_state() {
                let _ = sender.send(fullscreen);
            }
        })
    };
    let space = unsafe {
        center.addObserverForName_object_queue_usingBlock(
            Some(NSWorkspaceActiveSpaceDidChangeNotification),
            None,
            Some(&NSOperationQueue::mainQueue()),
            &block,
        )
    };
    let activation = unsafe {
        center.addObserverForName_object_queue_usingBlock(
            Some(NSWorkspaceDidActivateApplicationNotification),
            None,
            Some(&NSOperationQueue::mainQueue()),
            &block,
        )
    };
    // Both registrations must outlive this call for the lifetime of the process.
    // `Retained` is neither `Send` nor `Sync`, so the tokens are leaked rather
    // than parked in a static.
    std::mem::forget(space);
    std::mem::forget(activation);
    // Seeded so that a pet started while an application is already fullscreen
    // hides immediately instead of waiting for the next notification. A window of
    // ours being frontmost carries no information, so the pet starts visible.
    let _ = sender.send(fullscreen_state().unwrap_or(false));
    Ok(())
}

/// Reports the current fullscreen state.
///
/// `None` means the question cannot be answered because one of Agent Cat's own
/// windows is frontmost. The check follows the frontmost application, so our own
/// settings or status window would otherwise report "not fullscreen" and flicker
/// the pet back into view while an application behind it is still fullscreen.
fn fullscreen_state() -> Option<bool> {
    let workspace = NSWorkspace::sharedWorkspace();
    let frontmost = workspace.frontmostApplication()?;
    let displays = display_bounds();
    if displays.is_empty() {
        return Some(false);
    }
    let pid = frontmost.processIdentifier();
    let covers = has_window_covering(pid, &displays);
    if pid == std::process::id() as i32 {
        // A fullscreen window of ours still counts; an ordinary one says nothing
        // about the applications behind it, so the previous verdict stands.
        return covers.then_some(true);
    }
    Some(covers)
}

fn display_bounds() -> Vec<CGRect> {
    CGDisplay::active_displays()
        .unwrap_or_default()
        .into_iter()
        .map(|id| CGDisplay::new(id).bounds())
        .collect()
}

fn has_window_covering(pid: i32, displays: &[CGRect]) -> bool {
    let Some(windows) = copy_window_info(
        kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements,
        0,
    ) else {
        return false;
    };
    // `copy_window_info` yields an untyped array; every element is a window
    // dictionary, so the element type can be narrowed safely.
    let windows: CFArray<CFDictionary<CFString, CFType>> =
        unsafe { CFArray::wrap_under_get_rule(windows.as_concrete_TypeRef()) };
    windows
        .iter()
        .any(|window| is_fullscreen_window(&window, pid, displays))
}

fn is_fullscreen_window(
    window: &CFDictionary<CFString, CFType>,
    pid: i32,
    displays: &[CGRect],
) -> bool {
    // Layer 0 holds ordinary application windows; overlays and panels sit higher.
    if number(window, OWNER_PID_KEY) != Some(pid as f64) || number(window, LAYER_KEY) != Some(0.0) {
        return false;
    }
    let Some(bounds) = dictionary(window, BOUNDS_KEY) else {
        return false;
    };
    let (Some(x), Some(y), Some(width), Some(height)) = (
        number(&bounds, "X"),
        number(&bounds, "Y"),
        number(&bounds, "Width"),
        number(&bounds, "Height"),
    ) else {
        return false;
    };
    displays.iter().any(|display| {
        super::rect_covers(
            (x, y, x + width, y + height),
            (
                display.origin.x,
                display.origin.y,
                display.origin.x + display.size.width,
                display.origin.y + display.size.height,
            ),
        )
    })
}

fn lookup<'a>(
    dictionary: &'a CFDictionary<CFString, CFType>,
    key: &'static str,
) -> Option<ItemRef<'a, CFType>> {
    dictionary.find(CFString::from_static_string(key))
}

fn number(dictionary: &CFDictionary<CFString, CFType>, key: &'static str) -> Option<f64> {
    lookup(dictionary, key)?.downcast::<CFNumber>()?.to_f64()
}

fn dictionary(
    parent: &CFDictionary<CFString, CFType>,
    key: &'static str,
) -> Option<CFDictionary<CFString, CFType>> {
    let untyped = lookup(parent, key)?.downcast::<CFDictionary>()?;
    // Window-info values are dictionaries, but only the untyped form implements
    // `ConcreteCFType`, so the element types are reattached for the lookups above.
    Some(unsafe { CFDictionary::wrap_under_get_rule(untyped.as_concrete_TypeRef()) })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn window_list() -> Option<CFArray<CFDictionary<CFString, CFType>>> {
        let windows = copy_window_info(
            kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements,
            0,
        )?;
        Some(unsafe { CFArray::wrap_under_get_rule(windows.as_concrete_TypeRef()) })
    }

    /// Guards the CoreGraphics dictionary parsing: a wrong key or value type makes
    /// the detector report "not fullscreen" forever without ever failing, so the
    /// field reads are checked against live window data instead.
    #[test]
    fn reads_owner_layer_and_bounds_from_live_window_dictionaries() {
        let Some(windows) = window_list() else {
            return;
        };
        // A headless session may expose no windows; there is nothing to check then.
        if windows.is_empty() {
            return;
        }
        let parsed = windows
            .iter()
            .filter_map(|window| {
                let bounds = dictionary(&window, BOUNDS_KEY)?;
                Some((
                    number(&window, OWNER_PID_KEY)?,
                    number(&window, LAYER_KEY)?,
                    number(&bounds, "X")?,
                    number(&bounds, "Y")?,
                    number(&bounds, "Width")?,
                    number(&bounds, "Height")?,
                ))
            })
            .collect::<Vec<_>>();
        assert!(
            !parsed.is_empty(),
            "no on-screen window dictionary exposed an owner pid, layer, and bounds"
        );
        assert!(
            parsed
                .iter()
                .any(|(_, _, _, _, width, height)| *width > 0.0 && *height > 0.0),
            "parsed window bounds were never positive"
        );
    }

    /// Smoke-tests the whole `NSWorkspace` path. The result depends on the desktop,
    /// so only completion is asserted; the geometry itself is covered above.
    #[test]
    fn resolves_the_frontmost_application_without_panicking() {
        let _ = fullscreen_state();
    }

    /// The observer has to report the state it starts in, otherwise a pet launched
    /// while an application is already fullscreen stays visible until the next
    /// Space or activation change.
    #[test]
    fn reports_the_state_it_starts_in() {
        let (sender, receiver) = mpsc::channel();
        start_fullscreen_observer(move |fullscreen| {
            let _ = sender.send(fullscreen);
        })
        .unwrap();
        assert!(
            receiver
                .recv_timeout(std::time::Duration::from_secs(10))
                .is_ok(),
            "the observer never reported its initial state"
        );
    }
}
