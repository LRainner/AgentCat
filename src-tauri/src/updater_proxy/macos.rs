use super::https_proxy_from_scutil;
use std::process::Command;

pub(super) fn current_user_https_proxy() -> Option<String> {
    let output = Command::new("/usr/sbin/scutil")
        .arg("--proxy")
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    https_proxy_from_scutil(&String::from_utf8_lossy(&output.stdout))
}
