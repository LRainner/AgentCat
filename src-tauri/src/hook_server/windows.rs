use crate::config;
use std::{
    fs,
    net::{Ipv4Addr, SocketAddr, SocketAddrV4, TcpListener, TcpStream},
    path::Path,
    time::Duration,
};

pub(super) const ENDPOINT_NAME: &str = "agent-cat.endpoint";

pub(super) fn connect(path: &Path) -> Result<TcpStream, String> {
    let value = fs::read_to_string(path)
        .map_err(|error| format!("读取 Hook 端点 {} 失败：{error}", path.display()))?;
    let port = value
        .trim()
        .parse::<u16>()
        .map_err(|_| format!("Hook 端点 {} 无效", path.display()))?;
    let address = SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::LOCALHOST, port));
    TcpStream::connect_timeout(&address, Duration::from_millis(150))
        .map_err(|error| error.to_string())
}

pub(super) fn bind(path: &Path) -> Result<TcpListener, String> {
    if path.exists() {
        fs::remove_file(path).map_err(|error| format!("清理旧 Hook 端点失败：{error}"))?;
    }
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .map_err(|error| format!("绑定本地 Hook 端口失败：{error}"))?;
    let port = listener
        .local_addr()
        .map_err(|error| format!("读取本地 Hook 端口失败：{error}"))?
        .port();
    config::atomic_write(path, port.to_string().as_bytes())?;
    Ok(listener)
}

pub(super) fn remove_owned_endpoint(path: &Path) {
    if path.is_file() {
        let _ = fs::remove_file(path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};

    const HEALTH_CHECK_PAYLOAD: &[u8] = b"agent-cat-hook-health-v1";

    #[test]
    fn transport_uses_a_loopback_endpoint() {
        let root = std::env::temp_dir().join(format!(
            "agent-cat-hook-transport-{}-{}",
            std::process::id(),
            crate::hook_server::now_ms()
        ));
        fs::create_dir_all(&root).unwrap();
        let endpoint = root.join(ENDPOINT_NAME);
        let listener = bind(&endpoint).unwrap();
        let mut client = connect(&endpoint).unwrap();
        client.write_all(HEALTH_CHECK_PAYLOAD).unwrap();
        client.shutdown(std::net::Shutdown::Write).unwrap();
        let (mut server, address) = listener.accept().unwrap();
        assert!(address.ip().is_loopback());
        let mut payload = Vec::new();
        server.read_to_end(&mut payload).unwrap();
        assert_eq!(payload, HEALTH_CHECK_PAYLOAD);
        drop(listener);
        fs::remove_dir_all(root).unwrap();
    }
}
