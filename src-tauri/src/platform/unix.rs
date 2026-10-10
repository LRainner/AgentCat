use std::path::Path;
use tauri::WebviewWindow;

pub fn replace_file(source: &Path, destination: &Path) -> std::io::Result<()> {
    std::fs::rename(source, destination)
}

pub fn reveal_in_file_manager(path: &Path) -> Result<(), String> {
    std::process::Command::new("xdg-open")
        .arg(path)
        .spawn()
        .map_err(|error| format!("无法在文件管理器中打开：{error}"))?;
    Ok(())
}

/// There is no desktop-independent way to raise a window without activating it,
/// so the automatic restore falls back to the ordinary show here.
pub fn reveal_without_focus(window: &WebviewWindow) -> Result<(), String> {
    window.show().map_err(|error| error.to_string())
}

/// Desktop-environment fullscreen detection is not implemented on Linux; the
/// pet simply never auto-hides there, which keeps the option inert rather than
/// misreporting a state we cannot observe.
pub fn start_fullscreen_observer<F>(_on_change: F) -> Result<(), String>
where
    F: Fn(bool) + Send + 'static,
{
    Ok(())
}
