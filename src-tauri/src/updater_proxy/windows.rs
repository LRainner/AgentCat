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
