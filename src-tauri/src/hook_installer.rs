use crate::config;
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
};

const CODEX_EVENTS: [&str; 11] = [
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

const CLAUDE_CODE_EVENTS: [&str; 13] = [
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "PostToolUseFailure",
    "SubagentStart",
    "SubagentStop",
    "PreCompact",
    "PostCompact",
    "PermissionRequest",
    "Stop",
    "StopFailure",
    "SessionEnd",
];

pub const CODEX: &str = "codex";
pub const CLAUDE_CODE: &str = "claude-code";

mod claude_code;
mod codex;

struct HookSpec {
    agent: &'static str,
    display_name: &'static str,
    path: PathBuf,
    events: &'static [&'static str],
}

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
    pub globally_disabled: bool,
    pub installed_events: usize,
    pub expected_events: usize,
    pub message: String,
}

fn spec(agent: &str) -> Result<HookSpec, String> {
    match agent {
        CODEX => codex::spec(),
        CLAUDE_CODE => claude_code::spec(),
        _ => Err(format!("不支持的 Agent：{agent}")),
    }
}

pub fn supports_event(agent: &str, event: &str) -> bool {
    match agent {
        CODEX => CODEX_EVENTS.contains(&event),
        CLAUDE_CODE => CLAUDE_CODE_EVENTS.contains(&event),
        _ => false,
    }
}

pub fn status(agent: &str) -> Result<HookStatus, String> {
    let spec = spec(agent)?;
    let path = &spec.path;
    if !path.exists() {
        return Ok(HookStatus {
            path: path.to_string_lossy().to_string(),
            exists: false,
            valid: true,
            globally_disabled: false,
            installed_events: 0,
            expected_events: spec.events.len(),
            message: format!("尚未安装 {} 的 Agent Cat Hook", spec.display_name),
        });
    }
    let value = parse_existing(path)?;
    let command = expected_command(spec.agent)?;
    let globally_disabled = hooks_globally_disabled(spec.agent, &value);
    let installed_events = spec
        .events
        .iter()
        .filter(|event| event_contains_command(&value, event, &command))
        .count();
    Ok(HookStatus {
        path: path.to_string_lossy().to_string(),
        exists: true,
        valid: true,
        globally_disabled,
        installed_events,
        expected_events: spec.events.len(),
        message: if globally_disabled {
            "Claude Code 已全局禁用所有 Hooks".to_string()
        } else if installed_events == spec.events.len() {
            format!("{} 的 Agent Cat Hook 已安装", spec.display_name)
        } else {
            format!(
                "已安装 {installed_events}/{} 个事件，需要修复",
                spec.events.len()
            )
        },
    })
}

pub(crate) fn verification_fingerprint(agent: &str) -> Result<Option<String>, String> {
    let spec = spec(agent)?;
    let path = &spec.path;
    if !path.exists() {
        return Ok(None);
    }
    let value = parse_existing(path)?;
    let command = expected_command(spec.agent)?;
    Ok(fingerprint_for_agent(
        spec.agent,
        &value,
        &command,
        spec.events,
    ))
}

fn hooks_globally_disabled(agent: &str, root: &Value) -> bool {
    agent == CLAUDE_CODE && root.get("disableAllHooks").and_then(Value::as_bool) == Some(true)
}

fn fingerprint_for_agent(
    agent: &str,
    root: &Value,
    expected_command: &str,
    events: &[&str],
) -> Option<String> {
    let hook_fingerprint = fingerprint_for(root, expected_command, events)?;
    if agent != CLAUDE_CODE {
        return Some(hook_fingerprint);
    }
    fingerprint_value(&json!({
        "hookFingerprint": hook_fingerprint,
        "disableAllHooks": hooks_globally_disabled(agent, root),
    }))
}

fn fingerprint_for(root: &Value, expected_command: &str, events: &[&str]) -> Option<String> {
    let mut definitions = Vec::with_capacity(events.len());
    for event in events {
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

    fingerprint_value(&definitions)
}

fn fingerprint_value(value: &impl Serialize) -> Option<String> {
    let bytes = serde_json::to_vec(value).ok()?;
    let hash = bytes.iter().fold(0xcbf29ce484222325_u64, |hash, byte| {
        (hash ^ u64::from(*byte)).wrapping_mul(0x100000001b3)
    });
    Some(format!("v1-{hash:016x}"))
}

pub fn install(agent: &str) -> Result<HookStatus, String> {
    let spec = spec(agent)?;
    let path = &spec.path;
    let mut root = if path.exists() {
        parse_existing(path)?
    } else {
        json!({})
    };
    if !root.is_object() {
        return Err(format!(
            "{} 顶层必须是 JSON 对象；未覆盖原文件",
            path.display()
        ));
    }
    let command = expected_command(spec.agent)?;
    remove_agent_cat_entries(&mut root, &spec);
    add_agent_cat_entries(&mut root, &spec, &command)?;
    let bytes = serde_json::to_vec_pretty(&root).map_err(|error| error.to_string())?;
    config::atomic_write(path, &bytes)?;
    status(agent)
}

fn expected_command(agent: &str) -> Result<String, String> {
    let executable = std::env::current_exe()
        .map_err(|error| format!("无法确定 Agent Cat 可执行文件：{error}"))?;
    Ok(build_hook_command(&executable, agent))
}

fn build_hook_command(executable: &Path, agent: &str) -> String {
    platform::build_hook_command(executable, agent)
}

fn command_handler(command: &str, agent: &str) -> Value {
    let mut handler = json!({
        "type": "command",
        "command": command,
        "timeout": 2
    });
    if agent == CODEX {
        platform::add_platform_fields(handler.as_object_mut().unwrap(), command);
    }
    handler
}

fn add_agent_cat_entries(root: &mut Value, spec: &HookSpec, command: &str) -> Result<(), String> {
    let missing: Vec<&str> = spec
        .events
        .iter()
        .copied()
        .filter(|event| !event_contains_agent_cat(root, event, spec.agent))
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
        groups.push(json!({ "hooks": [command_handler(command, spec.agent)] }));
    }
    Ok(())
}

pub fn uninstall(agent: &str) -> Result<HookStatus, String> {
    let spec = spec(agent)?;
    let path = &spec.path;
    if !path.exists() {
        return status(agent);
    }
    let mut root = parse_existing(path)?;
    remove_agent_cat_entries(&mut root, &spec);
    let bytes = serde_json::to_vec_pretty(&root).map_err(|error| error.to_string())?;
    config::atomic_write(path, &bytes)?;
    status(agent)
}

fn remove_agent_cat_entries(root: &mut Value, spec: &HookSpec) {
    if let Some(events) = root.get_mut("hooks").and_then(Value::as_object_mut) {
        for event in spec.events {
            let Some(groups) = events.get_mut(*event).and_then(Value::as_array_mut) else {
                continue;
            };
            for group in groups.iter_mut() {
                if let Some(commands) = group.get_mut("hooks").and_then(Value::as_array_mut) {
                    commands.retain(|command| !is_agent_cat_command(command, spec.agent));
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

fn event_contains_agent_cat(root: &Value, event: &str, agent: &str) -> bool {
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
                .any(|handler| is_agent_cat_command(handler, agent))
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

fn is_agent_cat_command(value: &Value, agent: &str) -> bool {
    ["command", "commandWindows"].into_iter().any(|field| {
        value
            .get(field)
            .and_then(Value::as_str)
            .is_some_and(|command| is_agent_cat_command_text(command, agent))
    })
}

fn is_agent_cat_command_text(command: &str, agent: &str) -> bool {
    let lower = command.to_ascii_lowercase();
    if lower.contains("agent-cat")
        && (lower.contains(&format!("hook --agent {agent}"))
            || lower.contains(&format!("hook --agent '{agent}'")))
    {
        return true;
    }
    platform::is_encoded_agent_cat_command(command, agent)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn codex_spec() -> HookSpec {
        HookSpec {
            agent: CODEX,
            display_name: "Codex",
            path: PathBuf::from("hooks.json"),
            events: &CODEX_EVENTS,
        }
    }

    #[test]
    fn marker_detection_is_narrow() {
        assert!(is_agent_cat_command(
            &json!({"command": "'/Applications/Agent Cat.app/Contents/MacOS/agent-cat' hook --agent codex"}),
            CODEX
        ));
        assert!(!is_agent_cat_command(
            &json!({"command": "other-tool hook --agent codex"}),
            CODEX
        ));
    }

    #[test]
    fn install_is_idempotent_and_uninstall_preserves_other_hooks() {
        let mut root = json!({
            "futureTopLevel": true,
            "hooks": { "SessionStart": [{ "matcher": "startup", "hooks": [{ "type": "command", "command": "other-tool notify" }] }] }
        });
        let spec = codex_spec();
        add_agent_cat_entries(
            &mut root,
            &spec,
            "'/Applications/Agent Cat.app/Contents/MacOS/agent-cat' hook --agent codex",
        )
        .unwrap();
        add_agent_cat_entries(
            &mut root,
            &spec,
            "'/Applications/Agent Cat.app/Contents/MacOS/agent-cat' hook --agent codex",
        )
        .unwrap();
        assert_eq!(
            CODEX_EVENTS
                .iter()
                .filter(|event| event_contains_agent_cat(&root, event, CODEX))
                .count(),
            CODEX_EVENTS.len()
        );
        for event in CODEX_EVENTS {
            let agent_cat_handler = root["hooks"][event]
                .as_array()
                .unwrap()
                .iter()
                .flat_map(|group| group["hooks"].as_array().into_iter().flatten())
                .find(|handler| is_agent_cat_command(handler, CODEX))
                .unwrap();
            assert!(agent_cat_handler.get("async").is_none());
            assert_eq!(agent_cat_handler["timeout"], 2);
        }
        let session_groups = root["hooks"]["SessionStart"].as_array().unwrap();
        assert_eq!(session_groups.len(), 2);
        remove_agent_cat_entries(&mut root, &spec);
        assert_eq!(root["futureTopLevel"], true);
        assert_eq!(
            root["hooks"]["SessionStart"][0]["hooks"][0]["command"],
            "other-tool notify"
        );
        assert!(CODEX_EVENTS
            .iter()
            .all(|event| !event_contains_agent_cat(&root, event, CODEX)));
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
        assert!(event_contains_agent_cat(&root, "SessionStart", CODEX));
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
        let spec = codex_spec();
        add_agent_cat_entries(&mut root, &spec, command).unwrap();
        let original = fingerprint_for(&root, command, &CODEX_EVENTS).unwrap();

        root["unrelated"] = json!(true);
        assert_eq!(
            fingerprint_for(&root, command, &CODEX_EVENTS).as_deref(),
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
            fingerprint_for(&root, command, &CODEX_EVENTS).as_deref(),
            Some(original.as_str())
        );

        root["hooks"]["Stop"][0]["hooks"][0]["timeout"] = json!(3);
        assert_ne!(
            fingerprint_for(&root, command, &CODEX_EVENTS).as_deref(),
            Some(original.as_str())
        );
    }

    #[test]
    fn claude_verification_fingerprint_tracks_global_hook_disable_without_changing_codex() {
        let command = "agent-cat hook --agent claude-code";
        let mut root = json!({});
        let spec = HookSpec {
            agent: CLAUDE_CODE,
            display_name: "Claude Code",
            path: PathBuf::from("settings.json"),
            events: &CLAUDE_CODE_EVENTS,
        };
        add_agent_cat_entries(&mut root, &spec, command).unwrap();

        let codex_before = fingerprint_for_agent(CODEX, &root, command, &CLAUDE_CODE_EVENTS);
        let claude_before = fingerprint_for_agent(CLAUDE_CODE, &root, command, &CLAUDE_CODE_EVENTS);
        root["disableAllHooks"] = json!(true);

        assert_eq!(
            fingerprint_for_agent(CODEX, &root, command, &CLAUDE_CODE_EVENTS),
            codex_before
        );
        assert_ne!(
            fingerprint_for_agent(CLAUDE_CODE, &root, command, &CLAUDE_CODE_EVENTS),
            claude_before
        );
        assert!(hooks_globally_disabled(CLAUDE_CODE, &root));
        assert!(!hooks_globally_disabled(CODEX, &root));
    }

    #[test]
    fn claude_settings_keep_existing_preferences_and_include_failure_events() {
        let spec = HookSpec {
            agent: CLAUDE_CODE,
            display_name: "Claude Code",
            path: PathBuf::from("settings.json"),
            events: &CLAUDE_CODE_EVENTS,
        };
        let command = "agent-cat hook --agent claude-code";
        let mut root = json!({
            "model": "claude-opus-4-1",
            "permissions": { "allow": ["Bash(git status)"] },
            "hooks": { "PreToolUse": [{ "matcher": "Bash", "hooks": [{ "type": "command", "command": "other-tool" }] }] }
        });
        add_agent_cat_entries(&mut root, &spec, command).unwrap();
        assert_eq!(root["model"], "claude-opus-4-1");
        assert_eq!(root["permissions"]["allow"][0], "Bash(git status)");
        assert!(event_contains_agent_cat(
            &root,
            "PostToolUseFailure",
            CLAUDE_CODE
        ));
        assert!(event_contains_agent_cat(&root, "StopFailure", CLAUDE_CODE));
        let handler = root["hooks"]["StopFailure"][0]["hooks"][0]
            .as_object()
            .unwrap();
        assert!(handler.get("commandWindows").is_none());
        remove_agent_cat_entries(&mut root, &spec);
        assert_eq!(
            root["hooks"]["PreToolUse"][0]["hooks"][0]["command"],
            "other-tool"
        );
    }
}
