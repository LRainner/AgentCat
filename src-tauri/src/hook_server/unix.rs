use std::{
    fs,
    os::unix::{
        fs::FileTypeExt,
        net::{UnixListener, UnixStream},
    },
    path::Path,
};

pub(super) const ENDPOINT_NAME: &str = "agent-cat.sock";

pub(super) fn connect(path: &Path) -> Result<UnixStream, String> {
    UnixStream::connect(path).map_err(|error| error.to_string())
}

pub(super) fn bind(path: &Path) -> Result<UnixListener, String> {
    if path.exists() {
        let metadata =
            fs::symlink_metadata(path).map_err(|error| format!("检查旧 socket 失败：{error}"))?;
        if !metadata.file_type().is_socket() {
            return Err(format!("{} 已存在且不是 Unix socket", path.display()));
        }
        fs::remove_file(path).map_err(|error| format!("清理旧 socket 失败：{error}"))?;
    }
    UnixListener::bind(path).map_err(|error| format!("绑定 {} 失败：{error}", path.display()))
}

pub(super) fn remove_owned_endpoint(path: &Path) {
    let is_socket = fs::symlink_metadata(path)
        .map(|metadata| metadata.file_type().is_socket())
        .unwrap_or(false);
    if is_socket {
        let _ = fs::remove_file(path);
    }
}
