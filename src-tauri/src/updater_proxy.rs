pub fn configure() {
    if explicit_https_proxy_is_configured() {
        return;
    }

    if let Some(proxy) = platform_https_proxy() {
        // Reqwest's "system proxy" support only reads environment variables.
        // Mirror the native desktop setting before any updater clients exist.
        std::env::set_var("HTTPS_PROXY", proxy);
    }
}

fn explicit_https_proxy_is_configured() -> bool {
    ["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"]
        .iter()
        .any(|name| std::env::var_os(name).is_some_and(|value| !value.is_empty()))
}

#[cfg(target_os = "windows")]
fn platform_https_proxy() -> Option<String> {
    windows::current_user_https_proxy()
}

#[cfg(target_os = "macos")]
fn platform_https_proxy() -> Option<String> {
    macos::current_user_https_proxy()
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn platform_https_proxy() -> Option<String> {
    None
}

fn normalize_http_proxy(endpoint: &str) -> Option<String> {
    let endpoint = endpoint.trim();
    if endpoint.is_empty() || endpoint.chars().any(char::is_whitespace) {
        return None;
    }
    Some(if endpoint.contains("://") {
        endpoint.to_owned()
    } else {
        format!("http://{endpoint}")
    })
}

fn https_proxy_from_windows_setting(setting: &str) -> Option<String> {
    let mut default_proxy = None;
    let mut https_proxy = None;

    for entry in setting
        .split(';')
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
    {
        if let Some((protocol, endpoint)) = entry.split_once('=') {
            if protocol.trim().eq_ignore_ascii_case("https") {
                https_proxy = normalize_http_proxy(endpoint);
            }
        } else if default_proxy.is_none() {
            default_proxy = normalize_http_proxy(entry);
        }
    }

    https_proxy.or(default_proxy)
}

#[cfg(any(target_os = "macos", test))]
fn https_proxy_from_scutil(output: &str) -> Option<String> {
    let value = |key: &str| {
        output.lines().find_map(|line| {
            let (candidate, value) = line.trim().split_once(':')?;
            (candidate.trim() == key).then(|| value.trim())
        })
    };

    if value("HTTPSEnable")? != "1" {
        return None;
    }
    let host = value("HTTPSProxy")?;
    let port = value("HTTPSPort")?.parse::<u16>().ok()?;
    normalize_http_proxy(&format!("{host}:{port}"))
}

#[cfg(target_os = "windows")]
mod windows {
    use super::https_proxy_from_windows_setting;
    use windows_sys::Win32::{
        Foundation::GlobalFree,
        Networking::WinHttp::{
            WinHttpGetIEProxyConfigForCurrentUser, WINHTTP_CURRENT_USER_IE_PROXY_CONFIG,
        },
    };

    pub(super) fn current_user_https_proxy() -> Option<String> {
        let mut config = WINHTTP_CURRENT_USER_IE_PROXY_CONFIG::default();
        if unsafe { WinHttpGetIEProxyConfigForCurrentUser(&mut config) } == 0 {
            return None;
        }

        let proxy = unsafe { wide_string(config.lpszProxy) };
        unsafe {
            free_global_string(config.lpszAutoConfigUrl);
            free_global_string(config.lpszProxy);
            free_global_string(config.lpszProxyBypass);
        }
        proxy.and_then(|value| https_proxy_from_windows_setting(&value))
    }

    unsafe fn wide_string(value: *mut u16) -> Option<String> {
        if value.is_null() {
            return None;
        }
        let mut len = 0;
        while unsafe { *value.add(len) } != 0 {
            len += 1;
        }
        String::from_utf16(unsafe { std::slice::from_raw_parts(value, len) }).ok()
    }

    unsafe fn free_global_string(value: *mut u16) {
        if !value.is_null() {
            let _ = unsafe { GlobalFree(value.cast()) };
        }
    }
}

#[cfg(target_os = "macos")]
mod macos {
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
}

#[cfg(test)]
mod tests {
    use super::{https_proxy_from_scutil, https_proxy_from_windows_setting, normalize_http_proxy};

    #[cfg(target_os = "windows")]
    #[test]
    fn reads_the_current_windows_proxy_without_exposing_it() {
        if let Some(proxy) = super::windows::current_user_https_proxy() {
            assert!(proxy.starts_with("http://") || proxy.starts_with("https://"));
        }
    }

    #[test]
    fn normalizes_a_bare_http_proxy_endpoint() {
        assert_eq!(
            normalize_http_proxy("127.0.0.1:7890"),
            Some("http://127.0.0.1:7890".into())
        );
    }

    #[test]
    fn uses_a_single_windows_proxy_for_https() {
        assert_eq!(
            https_proxy_from_windows_setting("127.0.0.1:7890"),
            Some("http://127.0.0.1:7890".into())
        );
    }

    #[test]
    fn selects_the_https_entry_from_per_protocol_settings() {
        assert_eq!(
            https_proxy_from_windows_setting(
                "http=127.0.0.1:8080;https=127.0.0.1:8443;socks=127.0.0.1:1080"
            ),
            Some("http://127.0.0.1:8443".into())
        );
    }

    #[test]
    fn does_not_promote_an_http_only_windows_setting() {
        assert_eq!(
            https_proxy_from_windows_setting("http=127.0.0.1:8080"),
            None
        );
    }

    #[test]
    fn reads_the_effective_macos_https_proxy() {
        let output = r#"<dictionary> {
  HTTPEnable : 1
  HTTPPort : 8080
  HTTPProxy : localhost
  HTTPSEnable : 1
  HTTPSPort : 8443
  HTTPSProxy : 127.0.0.1
}"#;
        assert_eq!(
            https_proxy_from_scutil(output),
            Some("http://127.0.0.1:8443".into())
        );
    }
}
