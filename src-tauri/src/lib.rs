mod codex_source;
mod config;
mod hook_installer;
mod hook_server;
mod hook_verification;
mod pet_catalog;
mod pet_manifest;
mod platform;
mod updater_proxy;

use base64::Engine;
use config::{AppConfig, WindowConfig};
use pet_catalog::CatalogResult;
use serde::Serialize;
use std::{
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder,
};
use tauri_plugin_autostart::ManagerExt;

#[cfg(all(target_os = "macos", debug_assertions))]
fn set_debug_dock_icon() {
    use objc2::{AllocAnyThread, MainThreadMarker};
    use objc2_app_kit::{NSApplication, NSImage};
    use objc2_foundation::NSData;

    let main_thread = MainThreadMarker::new().expect("Dock icon must be set on the main thread");
    let application = NSApplication::sharedApplication(main_thread);
    // Runtime NSImage icons skip the visual normalization macOS applies to bundled ICNS icons.
    // This development-only asset carries the equivalent transparent safe area.
    let data = NSData::with_bytes(include_bytes!("../icons/dev-dock-icon.png"));
    let icon = NSImage::initWithData(NSImage::alloc(), &data)
        .expect("embedded development Dock icon must be a valid PNG");
    unsafe { application.setApplicationIconImage(Some(&icon)) };
}

struct TrayMenuState {
    show_pet: CheckMenuItem<tauri::Wry>,
    always_on_top: CheckMenuItem<tauri::Wry>,
    mouse_passthrough: CheckMenuItem<tauri::Wry>,
    lock_position: CheckMenuItem<tauri::Wry>,
    launch_at_login: CheckMenuItem<tauri::Wry>,
}

struct StatusWindowState(Mutex<f64>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PointerSnapshot {
    cursor_x: f64,
    cursor_y: f64,
    window_x: i32,
    window_y: i32,
    window_width: u32,
    window_height: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SpriteInspection {
    unused_cells: usize,
    non_transparent_pixels: u64,
    transparent: bool,
}

#[tauri::command]
fn get_config() -> Result<AppConfig, String> {
    config::load()
}

#[tauri::command]
fn save_config(app: tauri::AppHandle, mut value: AppConfig) -> Result<(), String> {
    capture_main_position(&app, &mut value.window)?;
    config::save(&value)?;
    hook_server::set_hooks_enabled(value.codex.hooks_enabled);
    Ok(())
}

#[tauri::command]
fn scan_pets() -> Result<CatalogResult, String> {
    pet_catalog::scan(&config::load()?)
}

#[tauri::command]
fn load_sprite_data_url(path: String) -> Result<String, String> {
    let (mime, bytes) = read_sprite_payload(&path)?;
    Ok(format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

fn read_sprite_payload(path: &str) -> Result<(&'static str, Vec<u8>), String> {
    let extension = Path::new(path)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let mime = match extension.as_str() {
        "png" => "image/png",
        "webp" => "image/webp",
        _ => return Err("只允许读取 PNG 或 WebP spritesheet".into()),
    };
    if let Some(result) = codex_source::read_asset_locator(path) {
        return result.map(|bytes| (mime, bytes));
    }
    let file = PathBuf::from(path);
    let metadata = fs::metadata(&file).map_err(|error| format!("读取 {path} 失败：{error}"))?;
    if !metadata.is_file() || metadata.len() > 24 * 1024 * 1024 {
        return Err("spritesheet 不存在或超过 24 MiB".into());
    }
    let bytes = fs::read(&file).map_err(|error| format!("读取 {path} 失败：{error}"))?;
    Ok((mime, bytes))
}

#[tauri::command]
fn inspect_sprite(path: String, version: u8) -> Result<SpriteInspection, String> {
    if version != 1 && version != 2 {
        return Err("version 必须是 1 或 2".into());
    }
    let (_, bytes) = read_sprite_payload(&path)?;
    let image = image::load_from_memory(&bytes)
        .map_err(|error| format!("解码 {path} 失败：{error}"))?
        .to_rgba8();
    let expected_height = if version == 2 { 2288 } else { 1872 };
    if image.width() != 1536 || image.height() != expected_height {
        return Err("spritesheet 尺寸与版本不一致".into());
    }
    let used_frames = [6u32, 8, 8, 4, 5, 8, 6, 6, 6];
    let mut non_transparent_pixels = 0u64;
    let mut unused_cells = 0usize;
    for (row, used) in used_frames.into_iter().enumerate() {
        for column in used..8 {
            unused_cells += 1;
            let x_start = column * 192;
            let y_start = row as u32 * 208;
            for y in y_start..y_start + 208 {
                for x in x_start..x_start + 192 {
                    if image.get_pixel(x, y).0[3] != 0 {
                        non_transparent_pixels += 1;
                    }
                }
            }
        }
    }
    Ok(SpriteInspection {
        unused_cells,
        non_transparent_pixels,
        transparent: non_transparent_pixels == 0,
    })
}

#[tauri::command]
fn pointer_snapshot(app: tauri::AppHandle) -> Result<PointerSnapshot, String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "宠物窗口不存在".to_string())?;
    let cursor = app.cursor_position().map_err(|error| error.to_string())?;
    let position = window.outer_position().map_err(|error| error.to_string())?;
    let size = window.outer_size().map_err(|error| error.to_string())?;
    Ok(PointerSnapshot {
        cursor_x: cursor.x,
        cursor_y: cursor.y,
        window_x: position.x,
        window_y: position.y,
        window_width: size.width,
        window_height: size.height,
    })
}

#[tauri::command]
fn start_dragging(app: tauri::AppHandle) -> Result<(), String> {
    app.get_webview_window("main")
        .ok_or_else(|| "宠物窗口不存在".to_string())?
        .start_dragging()
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn apply_window_settings(app: tauri::AppHandle, value: WindowConfig) -> Result<(), String> {
    apply_main_window_settings(&app, &value)?;
    let app_config = config::load()?;
    sync_status_window_with_config(&app, &app_config, None)
}

#[tauri::command]
fn apply_config_preview(app: tauri::AppHandle, value: AppConfig) -> Result<(), String> {
    apply_main_window_settings(&app, &value.window)?;
    sync_status_window_with_config(&app, &value, None)
}

fn apply_main_window_settings(app: &tauri::AppHandle, value: &WindowConfig) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "宠物窗口不存在".to_string())?;
    window
        .set_always_on_top(value.always_on_top)
        .map_err(|error| error.to_string())?;
    window
        .set_ignore_cursor_events(value.mouse_passthrough)
        .map_err(|error| error.to_string())?;
    let width = (192.0 * value.scale).round().max(77.0);
    let height = (208.0 * value.scale).round().max(84.0);
    window
        .set_size(tauri::LogicalSize::new(width, height))
        .map_err(|error| error.to_string())?;
    sync_tray_menu(app, value);
    Ok(())
}

fn capture_main_position(app: &tauri::AppHandle, value: &mut WindowConfig) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "宠物窗口不存在".to_string())?;
    let position = window.outer_position().map_err(|error| error.to_string())?;
    value.x = Some(position.x);
    value.y = Some(position.y);
    Ok(())
}

#[tauri::command]
fn sync_status_window(app: tauri::AppHandle, content_height: Option<f64>) -> Result<(), String> {
    let value = config::load()?;
    sync_status_window_with_config(&app, &value, content_height)
}

fn sync_status_window_with_config(
    app: &tauri::AppHandle,
    value: &AppConfig,
    content_height: Option<f64>,
) -> Result<(), String> {
    let status = app
        .get_webview_window("status")
        .ok_or_else(|| "状态窗口不存在".to_string())?;
    status
        .set_always_on_top(value.window.always_on_top)
        .map_err(|error| error.to_string())?;
    status
        .set_ignore_cursor_events(false)
        .map_err(|error| error.to_string())?;
    let bubble_scale = value.codex.bubble_scale.clamp(0.65, 1.5);
    let state = app.state::<StatusWindowState>();
    let mut content_height_state = state.0.lock().map_err(|error| error.to_string())?;
    if let Some(requested) = content_height.filter(|height| height.is_finite()) {
        *content_height_state = requested.clamp(96.0, 4096.0);
    }
    let content_height = *content_height_state;
    let logical_status_size =
        tauri::LogicalSize::new(400.0 * bubble_scale, content_height * bubble_scale);
    let status_size = logical_status_size
        .to_physical::<u32>(status.scale_factor().map_err(|error| error.to_string())?);
    status
        .set_size(logical_status_size)
        .map_err(|error| error.to_string())?;
    if !value.codex.hooks_enabled || !value.codex.show_live_status {
        status.hide().map_err(|error| error.to_string())?;
        return Ok(());
    }

    let main = app
        .get_webview_window("main")
        .ok_or_else(|| "宠物窗口不存在".to_string())?;
    let main_position = main.outer_position().map_err(|error| error.to_string())?;
    let main_size = main.outer_size().map_err(|error| error.to_string())?;
    let monitor = main
        .current_monitor()
        .map_err(|error| error.to_string())?
        .or(main.primary_monitor().map_err(|error| error.to_string())?)
        .ok_or_else(|| "找不到显示器".to_string())?;
    let monitor_position = monitor.position();
    let monitor_size = monitor.size();
    let gap = (8.0 * main.scale_factor().unwrap_or(1.0)).round() as i32;
    let inset = gap.max(8);
    let min_x = monitor_position.x + inset;
    let max_x = monitor_position.x + monitor_size.width as i32 - status_size.width as i32 - inset;
    let min_y = monitor_position.y + inset;
    let max_y = monitor_position.y + monitor_size.height as i32 - status_size.height as i32 - inset;
    let desired_x = main_position.x + main_size.width as i32 - status_size.width as i32;
    let above_y = main_position.y - status_size.height as i32 - gap;
    let below_y = main_position.y + main_size.height as i32 + gap;
    let desired_y = if above_y >= min_y { above_y } else { below_y };
    let x = desired_x.clamp(min_x, max_x.max(min_x));
    let y = desired_y.clamp(min_y, max_y.max(min_y));
    status
        .set_position(PhysicalPosition::new(x, y))
        .map_err(|error| error.to_string())?;
    drop(content_height_state);
    Ok(())
}

fn sync_tray_menu(app: &tauri::AppHandle, value: &WindowConfig) {
    if let Some(menu) = app.try_state::<TrayMenuState>() {
        let _ = menu.always_on_top.set_checked(value.always_on_top);
        let _ = menu.mouse_passthrough.set_checked(value.mouse_passthrough);
        let _ = menu.lock_position.set_checked(value.lock_position);
    }
}

fn toggle_window_setting(app: &tauri::AppHandle, id: &str) -> Result<(), String> {
    let mut value = config::load()?;
    capture_main_position(app, &mut value.window)?;
    match id {
        "always-on-top" => value.window.always_on_top = !value.window.always_on_top,
        "mouse-passthrough" => value.window.mouse_passthrough = !value.window.mouse_passthrough,
        "lock-position" => value.window.lock_position = !value.window.lock_position,
        _ => return Err("未知菜单设置".into()),
    }
    config::save(&value)?;
    apply_window_settings(app.clone(), value.window)?;
    app.emit("agent-cat-config-changed", ())
        .map_err(|error| error.to_string())
}

fn show_main_window(app: &tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    app.show().map_err(|error| error.to_string())?;

    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "宠物窗口不存在".to_string())?;
    window.unminimize().map_err(|error| error.to_string())?;
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())
}

fn toggle_main_window(app: &tauri::AppHandle) -> Result<(), String> {
    let should_show = app
        .try_state::<TrayMenuState>()
        .ok_or_else(|| "菜单状态不存在".to_string())?
        .show_pet
        .is_checked()
        .map_err(|error| error.to_string())?;
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "宠物窗口不存在".to_string())?;
    if should_show {
        show_main_window(app)?;
    } else {
        window.hide().map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn autostart_status(app: tauri::AppHandle) -> Result<bool, String> {
    app.autolaunch()
        .is_enabled()
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn set_autostart(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    let manager = app.autolaunch();
    if enabled {
        manager.enable().map_err(|error| error.to_string())?;
    } else {
        manager.disable().map_err(|error| error.to_string())?;
    }
    if let Some(menu) = app.try_state::<TrayMenuState>() {
        let _ = menu.launch_at_login.set_checked(enabled);
    }
    app.emit("agent-cat-autostart-changed", ())
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn save_main_position(app: tauri::AppHandle) -> Result<AppConfig, String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "宠物窗口不存在".to_string())?;
    let position = window.outer_position().map_err(|error| error.to_string())?;
    let mut value = config::load()?;
    value.window.x = Some(position.x);
    value.window.y = Some(position.y);
    config::save(&value)?;
    Ok(value)
}

#[tauri::command]
fn reset_main_position(app: tauri::AppHandle) -> Result<AppConfig, String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "宠物窗口不存在".to_string())?;
    let monitor = window
        .current_monitor()
        .map_err(|error| error.to_string())?
        .or(window
            .primary_monitor()
            .map_err(|error| error.to_string())?)
        .ok_or_else(|| "找不到显示器".to_string())?;
    let monitor_position = monitor.position();
    let monitor_size = monitor.size();
    let window_size = window.outer_size().map_err(|error| error.to_string())?;
    let x = monitor_position.x + monitor_size.width as i32 - window_size.width as i32 - 36;
    let y = monitor_position.y + monitor_size.height as i32 - window_size.height as i32 - 96;
    window
        .set_position(PhysicalPosition::new(x, y))
        .map_err(|error| error.to_string())?;
    let mut value = config::load()?;
    value.window.x = Some(x);
    value.window.y = Some(y);
    config::save(&value)?;
    Ok(value)
}

fn safe_position(
    window: &tauri::WebviewWindow,
    desired_x: i32,
    desired_y: i32,
) -> Result<PhysicalPosition<i32>, String> {
    let window_size = window.outer_size().unwrap_or(PhysicalSize::new(192, 208));
    let monitors = window
        .available_monitors()
        .map_err(|error| error.to_string())?;
    let visible = monitors.iter().any(|monitor| {
        let position = monitor.position();
        let size = monitor.size();
        desired_x + window_size.width as i32 > position.x + 24
            && desired_x < position.x + size.width as i32 - 24
            && desired_y + window_size.height as i32 > position.y + 24
            && desired_y < position.y + size.height as i32 - 24
    });
    if visible {
        return Ok(PhysicalPosition::new(desired_x, desired_y));
    }
    let monitor = window
        .primary_monitor()
        .map_err(|error| error.to_string())?
        .or_else(|| monitors.into_iter().next())
        .ok_or_else(|| "找不到显示器".to_string())?;
    let position = monitor.position();
    let size = monitor.size();
    Ok(PhysicalPosition::new(
        position.x + size.width as i32 - window_size.width as i32 - 36,
        position.y + size.height as i32 - window_size.height as i32 - 96,
    ))
}

#[tauri::command]
async fn show_window(app: tauri::AppHandle, kind: String) -> Result<(), String> {
    show_aux_window(&app, &kind)
}

#[tauri::command]
fn reveal_path(path: String) -> Result<(), String> {
    let value = if path == "~/.codex/pets" {
        config::home_dir()?.join(".codex/pets")
    } else {
        PathBuf::from(path)
    };
    if !value.exists() {
        fs::create_dir_all(&value)
            .map_err(|error| format!("创建 {} 失败：{error}", value.display()))?;
    }
    platform::reveal_in_file_manager(&value)
}

#[tauri::command]
fn hook_status() -> Result<hook_installer::HookStatus, String> {
    hook_installer::status()
}

#[tauri::command]
fn install_hooks() -> Result<hook_installer::HookStatus, String> {
    install_hooks_shared()
}

fn install_hooks_shared() -> Result<hook_installer::HookStatus, String> {
    let previous_fingerprint = hook_installer::verification_fingerprint()?;
    let status = hook_installer::install()?;
    if previous_fingerprint != hook_installer::verification_fingerprint()? {
        hook_verification::clear()?;
    }
    Ok(status)
}

#[tauri::command]
fn uninstall_hooks() -> Result<hook_installer::HookStatus, String> {
    uninstall_hooks_shared()
}

fn uninstall_hooks_shared() -> Result<hook_installer::HookStatus, String> {
    let status = hook_installer::uninstall()?;
    hook_verification::clear()?;
    Ok(status)
}

#[tauri::command]
fn send_test_event(app: tauri::AppHandle, event: String) -> Result<(), String> {
    hook_server::test_event(&app, &event)
}

#[tauri::command]
fn get_live_event() -> Option<hook_server::AgentEvent> {
    hook_server::latest_event()
}

#[tauri::command]
fn hook_runtime_status() -> hook_server::HookRuntimeStatus {
    hook_server::runtime_status()
}

#[tauri::command]
fn probe_hook() -> Result<hook_server::HookRuntimeStatus, String> {
    hook_server::probe_hook()
}

fn show_aux_window(app: &tauri::AppHandle, kind: &str) -> Result<(), String> {
    let (label, url, title, width, height) = match kind {
        "settings" => ("settings", "settings.html", "Agent Cat 设置", 920.0, 720.0),
        "pet-debug" => (
            "pet-debug",
            "pet-debug.html",
            "Agent Cat 动画测试器",
            980.0,
            780.0,
        ),
        _ => return Err("未知窗口".into()),
    };
    if let Some(window) = app.get_webview_window(label) {
        window.show().map_err(|error| error.to_string())?;
        window.set_focus().map_err(|error| error.to_string())?;
        return Ok(());
    }
    WebviewWindowBuilder::new(app, label, WebviewUrl::App(url.into()))
        .title(title)
        .inner_size(width, height)
        .min_inner_size(640.0, 520.0)
        .center()
        .build()
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn setup_tray(app: &tauri::App, value: &AppConfig) -> Result<(), String> {
    let show_pet = CheckMenuItem::with_id(app, "show-pet", "显示宠物", true, true, None::<&str>)
        .map_err(|error| error.to_string())?;
    let settings = MenuItem::with_id(app, "settings", "设置…", true, None::<&str>)
        .map_err(|error| error.to_string())?;
    let always_on_top = CheckMenuItem::with_id(
        app,
        "always-on-top",
        "始终置顶",
        true,
        value.window.always_on_top,
        None::<&str>,
    )
    .map_err(|error| error.to_string())?;
    let mouse_passthrough = CheckMenuItem::with_id(
        app,
        "mouse-passthrough",
        "鼠标穿透",
        true,
        value.window.mouse_passthrough,
        None::<&str>,
    )
    .map_err(|error| error.to_string())?;
    let lock_position = CheckMenuItem::with_id(
        app,
        "lock-position",
        "锁定位置",
        true,
        value.window.lock_position,
        None::<&str>,
    )
    .map_err(|error| error.to_string())?;
    let launch_at_login = CheckMenuItem::with_id(
        app,
        "launch-at-login",
        "登录时启动",
        true,
        app.autolaunch().is_enabled().unwrap_or(false),
        None::<&str>,
    )
    .map_err(|error| error.to_string())?;
    let reset_position =
        MenuItem::with_id(app, "reset-position", "恢复默认位置", true, None::<&str>)
            .map_err(|error| error.to_string())?;
    let quit = MenuItem::with_id(app, "quit", "退出 Agent Cat", true, None::<&str>)
        .map_err(|error| error.to_string())?;
    let separator_one = PredefinedMenuItem::separator(app).map_err(|error| error.to_string())?;
    let separator_two = PredefinedMenuItem::separator(app).map_err(|error| error.to_string())?;
    let menu = Menu::with_items(
        app,
        &[
            &show_pet,
            &settings,
            &separator_one,
            &always_on_top,
            &mouse_passthrough,
            &lock_position,
            &launch_at_login,
            &reset_position,
            &separator_two,
            &quit,
        ],
    )
    .map_err(|error| error.to_string())?;
    app.manage(TrayMenuState {
        show_pet,
        always_on_top,
        mouse_passthrough,
        lock_position,
        launch_at_login,
    });
    let mut builder = TrayIconBuilder::with_id("agent-cat-tray")
        .menu(&menu)
        .tooltip("Agent Cat")
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show-pet" => {
                let _ = toggle_main_window(app);
            }
            "settings" => {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = show_aux_window(&app, "settings");
                });
            }
            "always-on-top" | "mouse-passthrough" | "lock-position" => {
                let _ = toggle_window_setting(app, event.id().as_ref());
            }
            "launch-at-login" => {
                if let Ok(enabled) = app.autolaunch().is_enabled() {
                    let _ = set_autostart(app.clone(), !enabled);
                }
            }
            "reset-position" => {
                let _ = reset_main_position(app.clone());
                let _ = app.emit("agent-cat-config-changed", ());
            }
            "quit" => {
                hook_server::cleanup();
                app.exit(0);
            }
            _ => {}
        });
    #[cfg(target_os = "macos")]
    {
        let rgba = image::load_from_memory(include_bytes!("../icons/menu-bar-iconTemplate.png"))
            .map_err(|error| format!("加载菜单栏图标失败：{error}"))?
            .to_rgba8();
        let (width, height) = rgba.dimensions();
        let icon = tauri::image::Image::new_owned(rgba.into_raw(), width, height);
        builder = builder.icon(icon).icon_as_template(true);
    }
    #[cfg(not(target_os = "macos"))]
    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }
    builder.build(app).map_err(|error| error.to_string())?;
    Ok(())
}

pub fn handle_cli() -> bool {
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("hook") => {
            hook_server::run_cli_hook();
            true
        }
        Some("install-hooks") => {
            if let Err(error) = install_hooks_shared() {
                eprintln!("{error}");
                std::process::exit(1);
            }
            true
        }
        Some("uninstall-hooks") => {
            if let Err(error) = uninstall_hooks_shared() {
                eprintln!("{error}");
                std::process::exit(1);
            }
            true
        }
        _ => false,
    }
}

pub fn run() {
    updater_proxy::configure();
    let app = tauri::Builder::default()
        .manage(StatusWindowState(Mutex::new(96.0)))
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(
            tauri_plugin_autostart::Builder::new()
                .app_name("Agent Cat")
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            get_config,
            save_config,
            scan_pets,
            load_sprite_data_url,
            inspect_sprite,
            pointer_snapshot,
            start_dragging,
            apply_window_settings,
            apply_config_preview,
            sync_status_window,
            save_main_position,
            reset_main_position,
            autostart_status,
            set_autostart,
            show_window,
            reveal_path,
            hook_status,
            install_hooks,
            uninstall_hooks,
            send_test_event,
            get_live_event,
            hook_runtime_status,
            probe_hook
        ])
        .setup(|app| {
            if !hook_server::start(app.handle().clone()).map_err(std::io::Error::other)? {
                app.handle().exit(0);
                return Ok(());
            }
            let value = config::load().map_err(std::io::Error::other)?;
            setup_tray(app, &value).map_err(std::io::Error::other)?;
            {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.set_always_on_top(value.window.always_on_top);
                    let _ = window.set_ignore_cursor_events(value.window.mouse_passthrough);
                    let _ = window.set_size(tauri::LogicalSize::new(
                        192.0 * value.window.scale,
                        208.0 * value.window.scale,
                    ));
                    if let (Some(x), Some(y)) = (value.window.x, value.window.y) {
                        if let Ok(position) = safe_position(&window, x, y) {
                            let _ = window.set_position(position);
                        }
                    }
                }
                let _ = sync_status_window(app.handle().clone(), None);
            }
            let args: Vec<String> = std::env::args().collect();
            if args.iter().any(|arg| arg == "--settings") {
                show_aux_window(app.handle(), "settings").map_err(std::io::Error::other)?;
            }
            if args.iter().any(|arg| arg == "--pet-debug") {
                show_aux_window(app.handle(), "pet-debug").map_err(std::io::Error::other)?;
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Agent Cat");
    app.run(|_, event| match event {
        #[cfg(all(target_os = "macos", debug_assertions))]
        tauri::RunEvent::Ready => set_debug_dock_icon(),
        tauri::RunEvent::Exit => {
            hook_server::cleanup();
        }
        _ => {}
    });
}
