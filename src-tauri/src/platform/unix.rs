use std::path::Path;

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
