use super::{HookSpec, CLAUDE_CODE, CLAUDE_CODE_EVENTS};
use crate::config;
use std::{
    ffi::OsStr,
    path::{Path, PathBuf},
};

#[cfg(test)]
fn settings_path(config_dir: Option<&OsStr>, home: Option<&Path>) -> Option<PathBuf> {
    config_root(config_dir, home).map(|path| path.join("settings.json"))
}

fn config_root(config_dir: Option<&OsStr>, home: Option<&Path>) -> Option<PathBuf> {
    config_dir
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| home.map(|path| path.join(".claude")))
}

pub(super) fn resolved_config_root() -> Result<PathBuf, String> {
    let config_dir = std::env::var_os("CLAUDE_CONFIG_DIR");
    config_root(config_dir.as_deref(), Some(&config::home_dir()?))
        .ok_or_else(|| "无法确定 Claude Code 配置目录".to_string())
}

pub(super) fn spec() -> Result<HookSpec, String> {
    let path = resolved_config_root()?.join("settings.json");
    Ok(HookSpec {
        agent: CLAUDE_CODE,
        display_name: "Claude Code",
        path,
        events: &CLAUDE_CODE_EVENTS,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_path_prefers_non_empty_config_directory() {
        assert_eq!(
            settings_path(Some(OsStr::new("custom-claude")), None),
            Some(Path::new("custom-claude").join("settings.json"))
        );
    }

    #[test]
    fn settings_path_falls_back_to_home_for_missing_or_empty_config_directory() {
        let expected = Path::new("home").join(".claude").join("settings.json");
        assert_eq!(
            settings_path(None, Some(Path::new("home"))),
            Some(expected.clone())
        );
        assert_eq!(
            settings_path(Some(OsStr::new("")), Some(Path::new("home"))),
            Some(expected)
        );
    }

    #[test]
    fn config_root_matches_the_settings_parent() {
        let root = config_root(Some(OsStr::new("custom-claude")), Some(Path::new("home"))).unwrap();
        assert_eq!(
            settings_path(Some(OsStr::new("custom-claude")), Some(Path::new("home")))
                .unwrap()
                .parent(),
            Some(root.as_path())
        );
    }
}
