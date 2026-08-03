use super::{HookSpec, CLAUDE_CODE, CLAUDE_CODE_EVENTS};
use crate::config;
use std::{
    ffi::OsStr,
    path::{Path, PathBuf},
};

fn settings_path(config_dir: Option<&OsStr>, home: Option<&Path>) -> Option<PathBuf> {
    config_dir
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| home.map(|path| path.join(".claude")))
        .map(|path| path.join("settings.json"))
}

pub(super) fn spec() -> Result<HookSpec, String> {
    let config_dir = std::env::var_os("CLAUDE_CONFIG_DIR");
    let path = if let Some(path) = settings_path(config_dir.as_deref(), None) {
        path
    } else {
        settings_path(None, Some(&config::home_dir()?)).expect("home path is present")
    };
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
}
