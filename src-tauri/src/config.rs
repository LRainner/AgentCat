use crate::platform;
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

static TEMP_FILE_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    pub version: u8,
    #[serde(default)]
    pub language: LanguagePreference,
    pub pet: Option<SelectedPet>,
    pub pet_sources: PetSourcesConfig,
    pub window: WindowConfig,
    pub behavior: BehaviorConfig,
    pub codex: CodexConfig,
    #[serde(default)]
    pub claude_code: ClaudeCodeConfig,
    #[serde(default)]
    pub dsh: DshConfig,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum LanguagePreference {
    #[default]
    System,
    En,
    Cn,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectedPet {
    pub source: String,
    pub id: String,
    pub manifest_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PetSourcesConfig {
    pub scan_codex_builtin: bool,
    pub scan_codex_custom: bool,
    pub extra_directories: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowConfig {
    pub x: Option<i32>,
    pub y: Option<i32>,
    pub scale: f64,
    #[serde(default = "default_one")]
    pub pet_opacity: f64,
    pub always_on_top: bool,
    pub mouse_passthrough: bool,
    pub lock_position: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BehaviorConfig {
    pub follow_pointer: bool,
    pub pointer_radius: f64,
    pub pointer_deadzone: f64,
    pub click_to_wave: bool,
    pub double_click_to_jump: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexConfig {
    #[serde(default = "default_true")]
    pub hooks_enabled: bool,
    #[serde(default = "default_true")]
    pub show_live_status: bool,
    #[serde(default = "default_true")]
    pub show_task_summary: bool,
    #[serde(default = "default_one")]
    pub bubble_scale: f64,
    #[serde(default = "default_bubble_opacity")]
    pub bubble_opacity: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeCodeConfig {
    #[serde(default)]
    pub hooks_enabled: bool,
    #[serde(default = "default_true")]
    pub show_live_status: bool,
    #[serde(default = "default_true")]
    pub show_task_summary: bool,
}

impl Default for ClaudeCodeConfig {
    fn default() -> Self {
        Self {
            hooks_enabled: false,
            show_live_status: true,
            show_task_summary: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DshConfig {
    #[serde(default)]
    pub hooks_enabled: bool,
    #[serde(default = "default_true")]
    pub show_live_status: bool,
    #[serde(default = "default_true")]
    pub show_task_summary: bool,
}

impl Default for DshConfig {
    fn default() -> Self {
        Self {
            hooks_enabled: false,
            show_live_status: true,
            show_task_summary: true,
        }
    }
}

fn default_true() -> bool {
    true
}

fn default_one() -> f64 {
    1.0
}

fn default_bubble_opacity() -> f64 {
    0.92
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            version: 1,
            language: LanguagePreference::System,
            pet: None,
            pet_sources: PetSourcesConfig {
                scan_codex_builtin: true,
                scan_codex_custom: true,
                extra_directories: Vec::new(),
            },
            window: WindowConfig {
                x: None,
                y: None,
                scale: 0.75,
                pet_opacity: 1.0,
                always_on_top: true,
                mouse_passthrough: false,
                lock_position: false,
            },
            behavior: BehaviorConfig {
                follow_pointer: true,
                pointer_radius: 500.0,
                pointer_deadzone: 36.0,
                click_to_wave: true,
                double_click_to_jump: true,
            },
            codex: CodexConfig {
                hooks_enabled: true,
                show_live_status: true,
                show_task_summary: true,
                bubble_scale: 1.0,
                bubble_opacity: 0.92,
            },
            claude_code: ClaudeCodeConfig::default(),
            dsh: DshConfig::default(),
        }
    }
}

pub fn home_dir() -> Result<PathBuf, String> {
    #[cfg(windows)]
    let value = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"));
    #[cfg(not(windows))]
    let value = std::env::var_os("HOME");

    value
        .map(PathBuf::from)
        .ok_or_else(|| "无法确定用户主目录".to_string())
}

pub fn config_dir() -> Result<PathBuf, String> {
    #[cfg(windows)]
    {
        std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .map(|path| path.join("io.github.agent-cat"))
            .ok_or_else(|| "APPDATA is not available".to_string())
    }
    #[cfg(not(windows))]
    Ok(home_dir()?.join(".config/agent-cat"))
}

pub fn config_path() -> Result<PathBuf, String> {
    Ok(config_dir()?.join("config.json"))
}

pub fn load() -> Result<AppConfig, String> {
    let path = config_path()?;
    if !path.exists() {
        return Ok(AppConfig::default());
    }
    let bytes =
        fs::read(&path).map_err(|error| format!("读取 {} 失败：{error}", path.display()))?;
    serde_json::from_slice(&bytes).map_err(|error| format!("解析 {} 失败：{error}", path.display()))
}

pub fn save(config: &AppConfig) -> Result<(), String> {
    if config.version != 1 {
        return Err(format!("不支持配置版本 {}", config.version));
    }
    let path = config_path()?;
    let bytes = serde_json::to_vec_pretty(config).map_err(|error| error.to_string())?;
    atomic_write(&path, &bytes)
}

pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "目标路径没有父目录".to_string())?;
    ensure_private_dir(parent)?;
    #[cfg(unix)]
    let target_mode = match fs::metadata(path) {
        Ok(metadata) => metadata.permissions().mode() & 0o7777,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => 0o600,
        Err(error) => return Err(format!("读取 {} 权限失败：{error}", path.display())),
    };
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let counter = TEMP_FILE_COUNTER.fetch_add(1, Ordering::Relaxed);
    let temp = parent.join(format!(
        ".{}.tmp-{}-{nonce}-{counter}",
        path.file_name().unwrap_or_default().to_string_lossy(),
        std::process::id()
    ));
    let result = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        options.mode(0o600);
        let mut file = options
            .open(&temp)
            .map_err(|error| format!("创建 {} 失败：{error}", temp.display()))?;
        #[cfg(unix)]
        file.set_permissions(fs::Permissions::from_mode(target_mode))
            .map_err(|error| format!("设置 {} 权限失败：{error}", temp.display()))?;
        file.write_all(bytes)
            .map_err(|error| format!("写入 {} 失败：{error}", temp.display()))?;
        file.sync_all()
            .map_err(|error| format!("同步 {} 失败：{error}", temp.display()))?;
        platform::replace_file(&temp, path)
            .map_err(|error| format!("替换 {} 失败：{error}", path.display()))?;
        #[cfg(unix)]
        fs::File::open(parent)
            .and_then(|directory| directory.sync_all())
            .map_err(|error| format!("同步 {} 失败：{error}", parent.display()))?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

pub fn ensure_private_dir(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path).map_err(|error| format!("创建 {} 失败：{error}", path.display()))?;
    #[cfg(unix)]
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
        .map_err(|error| format!("设置 {} 权限失败：{error}", path.display()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::de::{Error as _, IgnoredAny, MapAccess, Visitor};
    use serde::Deserializer as _;
    use serde_json::json;
    use std::{collections::HashSet, fmt};

    struct UniqueTranslationKeys;

    impl<'de> Visitor<'de> for UniqueTranslationKeys {
        type Value = usize;

        fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            formatter.write_str("an i18n JSON object with unique top-level keys")
        }

        fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
        where
            A: MapAccess<'de>,
        {
            let mut keys = HashSet::new();
            while let Some(key) = map.next_key::<String>()? {
                if !keys.insert(key.clone()) {
                    return Err(A::Error::custom(format!("duplicate i18n key: {key}")));
                }
                map.next_value::<IgnoredAny>()?;
            }
            Ok(keys.len())
        }
    }

    #[test]
    fn i18n_message_keys_are_unique() {
        let source = include_str!("../../src/i18n/messages.json");
        let mut deserializer = serde_json::Deserializer::from_str(source);
        let key_count = deserializer
            .deserialize_map(UniqueTranslationKeys)
            .expect("i18n messages must be valid JSON with unique top-level keys");
        assert!(key_count > 0);
    }

    #[test]
    fn new_display_fields_have_backward_compatible_defaults() {
        let window: WindowConfig = serde_json::from_value(json!({
            "x": null,
            "y": null,
            "scale": 0.75,
            "alwaysOnTop": true,
            "mousePassthrough": false,
            "lockPosition": false
        }))
        .unwrap();
        let codex: CodexConfig = serde_json::from_value(json!({
            "hooksEnabled": true,
            "showLiveStatus": true,
            "showTaskSummary": true
        }))
        .unwrap();
        assert_eq!(window.pet_opacity, 1.0);
        assert_eq!(codex.bubble_scale, 1.0);
        assert_eq!(codex.bubble_opacity, 0.92);

        let app: AppConfig = serde_json::from_value(serde_json::json!({
            "version": 1,
            "pet": null,
            "petSources": { "scanCodexBuiltin": true, "scanCodexCustom": true, "extraDirectories": [] },
            "window": { "x": null, "y": null, "scale": 0.75, "alwaysOnTop": true, "mousePassthrough": false, "lockPosition": false },
            "behavior": { "followPointer": true, "pointerRadius": 500.0, "pointerDeadzone": 36.0, "clickToWave": true, "doubleClickToJump": true },
            "codex": { "hooksEnabled": true, "showLiveStatus": true, "showTaskSummary": true }
        })).unwrap();
        assert!(!app.claude_code.hooks_enabled);
        assert!(app.claude_code.show_live_status);
        assert!(!app.dsh.hooks_enabled);
        assert!(app.dsh.show_live_status);
        assert!(app.dsh.show_task_summary);
        assert_eq!(app.language, LanguagePreference::System);
    }

    #[cfg(unix)]
    #[test]
    fn atomic_write_uses_private_defaults_and_preserves_existing_mode() {
        let root = std::env::temp_dir().join(format!(
            "agent-cat-atomic-write-{}-{}",
            std::process::id(),
            TEMP_FILE_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let path = root.join("config.json");
        atomic_write(&path, b"first").unwrap();
        assert_eq!(
            fs::metadata(&root).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );

        fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).unwrap();
        atomic_write(&path, b"second").unwrap();
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o640
        );
        assert_eq!(fs::read(&path).unwrap(), b"second");
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn atomic_write_replaces_existing_file_on_windows() {
        let root = std::env::temp_dir().join(format!(
            "agent-cat-atomic-write-{}-{}",
            std::process::id(),
            TEMP_FILE_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let path = root.join("config.json");
        atomic_write(&path, b"first").unwrap();
        atomic_write(&path, b"second").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"second");
        fs::remove_dir_all(root).unwrap();
    }
}
