use crate::config;
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
};

const EVENTS: [&str; 11] = [
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "SubagentStart",
    "SubagentStop",
    "PreCompact",
    "PostCompact",
    "PermissionRequest",
    "Stop",
    "SessionEnd",
];

#[cfg(not(windows))]
mod unix;
#[cfg(windows)]
mod windows;

#[cfg(not(windows))]
use unix as platform;
#[cfg(windows)]
use windows as platform;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HookStatus {
    pub path: String,
    pub exists: bool,
    pub valid: bool,
    pub installed_events: usize,
    pub expected_events: usize,
    pub message: String,
}

fn path() -> Result<PathBuf, String> {
    Ok(config::home_dir()?.join(".codex/hooks.json"))
}

pub fn status() -> Result<HookStatus, String> {
    let path = path()?;
    if !path.exists() {
        return Ok(HookStatus {
            path: path.to_string_lossy().to_string(),
            exists: false,
            valid: true,
            installed_events: 0,
            expected_events: EVENTS.len(),
            message: "尚未安装 Agent Cat Hook".into(),
        });
    }
    let value = parse_existing(&path)?;
    let command = expected_command()?;
    let installed_events = EVENTS
        .iter()
        .filter(|event| event_contains_command(&value, event, &command))
        .count();
    Ok(HookStatus {
        path: path.to_string_lossy().to_string(),
        exists: true,
        valid: true,
        installed_events,
        expected_events: EVENTS.len(),
        message: if installed_events == EVENTS.len() {
            "Agent Cat Hook 已安装".into()
        } else {
            format!(
                "已安装 {installed_events}/{} 个事件，需要修复",
                EVENTS.len()
            )
        },
    })
}

pub(crate) fn verification_fingerprint() -> Result<Option<String>, String> {
    let path = path()?;
    if !path.exists() {
        return Ok(None);
    }
    let value = parse_existing(&path)?;
    let command = expected_command()?;
    Ok(fingerprint_for(&value, &command))
}

fn fingerprint_for(root: &Value, expected_command: &str) -> Option<String> {
    let mut definitions = Vec::with_capacity(EVENTS.len());
    for event in EVENTS {
        let groups = root
            .get("hooks")?
            .get(event)?
            .as_array()?
            .iter()
            .filter_map(|group| {
                let handlers = group
                    .get("hooks")?
                    .as_array()?
                    .iter()
                    .filter(|handler| {
                        handler.get("command").and_then(Value::as_str) == Some(expected_command)
                    })
                    .cloned()
                    .collect::<Vec<_>>();
                if handlers.is_empty() {
                    return None;
                }
                let mut definition = group.clone();
                definition
                    .as_object_mut()?
                    .insert("hooks".into(), Value::Array(handlers));
                Some(definition)
            })
            .collect::<Vec<_>>();
        if groups.is_empty() {
            return None;
        }
        definitions.push(json!({ "event": event, "groups": groups }));
    }

    let bytes = serde_json::to_vec(&definitions).ok()?;
    let hash = bytes.iter().fold(0xcbf29ce484222325_u64, |hash, byte| {
        (hash ^ u64::from(*byte)).wrapping_mul(0x100000001b3)
    });
    Some(format!("v1-{hash:016x}"))
}

pub fn install() -> Result<HookStatus, String> {
    let path = path()?;
    let mut root = if path.exists() {
        parse_existing(&path)?
    } else {
        json!({})
    };
    if !root.is_object() {
        return Err("hooks.json 顶层必须是 JSON 对象；未覆盖原文件".into());
    }
    let command = expected_command()?;
    remove_agent_cat_entries(&mut root);
    add_agent_cat_entries(&mut root, &command)?;
    let bytes = serde_json::to_vec_pretty(&root).map_err(|error| error.to_string())?;
    config::atomic_write(&path, &bytes)?;
    status()
}

fn expected_command() -> Result<String, String> {
    let executable = std::env::current_exe()
        .map_err(|error| format!("无法确定 Agent Cat 可执行文件：{error}"))?;
    Ok(build_hook_command(&executable))
}

fn build_hook_command(executable: &Path) -> String {
    platform::build_hook_command(executable)
}

fn command_handler(command: &str) -> Value {
    let mut handler = json!({
        "type": "command",
        "command": command,
        "timeout": 2
    });
    platform::add_platform_fields(handler.as_object_mut().unwrap(), command);
    handler
}

fn add_agent_cat_entries(root: &mut Value, command: &str) -> Result<(), String> {
    let missing: Vec<&str> = EVENTS
        .iter()
        .copied()
        .filter(|event| !event_contains_agent_cat(root, event))
        .collect();
    let root_object = root.as_object_mut().unwrap();
    let hooks = root_object.entry("hooks").or_insert_with(|| json!({}));
    if !hooks.is_object() {
        return Err("hooks.json 的 hooks 字段必须是对象；未覆盖原文件".into());
    }
    for event in missing {
        let event_groups = hooks
            .as_object_mut()
            .unwrap()
            .entry(event)
            .or_insert_with(|| json!([]));
        let groups = event_groups
            .as_array_mut()
            .ok_or_else(|| format!("hooks.{event} 必须是数组；未覆盖原文件"))?;
        groups.push(json!({ "hooks": [command_handler(command)] }));
    }
    Ok(())
}

pub fn uninstall() -> Result<HookStatus, String> {
    let path = path()?;
    if !path.exists() {
        return status();
    }
    let mut root = parse_existing(&path)?;
    remove_agent_cat_entries(&mut root);
    let bytes = serde_json::to_vec_pretty(&root).map_err(|error| error.to_string())?;
    config::atomic_write(&path, &bytes)?;
    status()
}

fn remove_agent_cat_entries(root: &mut Value) {
    if let Some(events) = root.get_mut("hooks").and_then(Value::as_object_mut) {
        for event in EVENTS {
            let Some(groups) = events.get_mut(event).and_then(Value::as_array_mut) else {
                continue;
            };
            for group in groups.iter_mut() {
                if let Some(commands) = group.get_mut("hooks").and_then(Value::as_array_mut) {
                    commands.retain(|command| !is_agent_cat_command(command));
                }
            }
            groups.retain(|group| {
                group
                    .get("hooks")
                    .and_then(Value::as_array)
                    .map(|items| !items.is_empty())
                    .unwrap_or(true)
            });
        }
        events.retain(|_, groups| {
            groups
                .as_array()
                .map(|items| !items.is_empty())
                .unwrap_or(true)
        });
    }
}

fn parse_existing(path: &std::path::Path) -> Result<Value, String> {
    let bytes = fs::read(path).map_err(|error| format!("读取 {} 失败：{error}", path.display()))?;
    serde_json::from_slice(&bytes).map_err(|error| {
        format!(
            "{} 无法解析：{error}。为保护现有 Hook，Agent Cat 不会覆盖它。",
            path.display()
        )
    })
}

fn event_contains_agent_cat(root: &Value, event: &str) -> bool {
    root.get("hooks")
        .and_then(|value| value.get(event))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .any(|group| {
            group
                .get("hooks")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .any(is_agent_cat_command)
        })
}

fn event_contains_command(root: &Value, event: &str, expected: &str) -> bool {
    root.get("hooks")
        .and_then(|value| value.get(event))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .any(|group| {
            group
                .get("hooks")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .any(|command| command.get("command").and_then(Value::as_str) == Some(expected))
        })
}

fn is_agent_cat_command(value: &Value) -> bool {
    ["command", "commandWindows"].into_iter().any(|field| {
        value
            .get(field)
            .and_then(Value::as_str)
            .is_some_and(is_agent_cat_command_text)
    })
}

fn is_agent_cat_command_text(command: &str) -> bool {
    let lower = command.to_ascii_lowercase();
    if lower.contains("agent-cat") && lower.contains("hook --agent codex") {
        return true;
    }
    platform::is_encoded_agent_cat_command(command)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn marker_detection_is_narrow() {
        assert!(is_agent_cat_command(
            &json!({"command": "'/Applications/Agent Cat.app/Contents/MacOS/agent-cat' hook --agent codex"})
        ));
        assert!(!is_agent_cat_command(
            &json!({"command": "other-tool hook --agent codex"})
        ));
    }

    #[test]
    fn install_is_idempotent_and_uninstall_preserves_other_hooks() {
        let mut root = json!({
            "futureTopLevel": true,
            "hooks": { "SessionStart": [{ "matcher": "startup", "hooks": [{ "type": "command", "command": "other-tool notify" }] }] }
        });
        add_agent_cat_entries(
            &mut root,
            "'/Applications/Agent Cat.app/Contents/MacOS/agent-cat' hook --agent codex",
        )
        .unwrap();
        add_agent_cat_entries(
            &mut root,
            "'/Applications/Agent Cat.app/Contents/MacOS/agent-cat' hook --agent codex",
        )
        .unwrap();
        assert_eq!(
            EVENTS
                .iter()
                .filter(|event| event_contains_agent_cat(&root, event))
                .count(),
            EVENTS.len()
        );
        for event in EVENTS {
            let agent_cat_handler = root["hooks"][event]
                .as_array()
                .unwrap()
                .iter()
                .flat_map(|group| group["hooks"].as_array().into_iter().flatten())
                .find(|handler| is_agent_cat_command(handler))
                .unwrap();
            assert!(agent_cat_handler.get("async").is_none());
            assert_eq!(agent_cat_handler["timeout"], 2);
        }
        let session_groups = root["hooks"]["SessionStart"].as_array().unwrap();
        assert_eq!(session_groups.len(), 2);
        remove_agent_cat_entries(&mut root);
        assert_eq!(root["futureTopLevel"], true);
        assert_eq!(
            root["hooks"]["SessionStart"][0]["hooks"][0]["command"],
            "other-tool notify"
        );
        assert!(EVENTS
            .iter()
            .all(|event| !event_contains_agent_cat(&root, event)));
    }

    #[test]
    fn exact_command_detection_marks_moved_apps_for_repair() {
        let root = json!({
            "hooks": {
                "SessionStart": [{
                    "hooks": [{
                        "type": "command",
                        "command": "'/Applications/Old Agent Cat.app/Contents/MacOS/agent-cat' hook --agent codex"
                    }]
                }]
            }
        });
        assert!(event_contains_agent_cat(&root, "SessionStart"));
        assert!(!event_contains_command(
            &root,
            "SessionStart",
            "'/Applications/Agent Cat.app/Contents/MacOS/agent-cat' hook --agent codex"
        ));
    }

    #[test]
    fn verification_fingerprint_tracks_agent_cat_hook_definitions() {
        let command = "'/Applications/Agent Cat.app/Contents/MacOS/agent-cat' hook --agent codex";
        let mut root = json!({});
        add_agent_cat_entries(&mut root, command).unwrap();
        let original = fingerprint_for(&root, command).unwrap();

        root["unrelated"] = json!(true);
        assert_eq!(
            fingerprint_for(&root, command).as_deref(),
            Some(original.as_str())
        );

        root["hooks"]["Stop"][0]["hooks"]
            .as_array_mut()
            .unwrap()
            .push(json!({
                "type": "command",
                "command": "other-tool notify",
                "timeout": 30
            }));
        assert_eq!(
            fingerprint_for(&root, command).as_deref(),
            Some(original.as_str())
        );

        root["hooks"]["Stop"][0]["hooks"][0]["timeout"] = json!(3);
        assert_ne!(
            fingerprint_for(&root, command).as_deref(),
            Some(original.as_str())
        );
    }
}
