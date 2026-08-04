use crate::{config, hook_installer};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::{Mutex, OnceLock},
};

#[derive(Debug, Clone)]
struct MemoryVerification {
    fingerprint: String,
    verified_at: u64,
}

#[derive(Debug, Clone, Default)]
enum RuntimeVerification {
    #[default]
    Uninitialized,
    Verified(MemoryVerification),
    Cleared,
}

#[derive(Debug, PartialEq, Eq)]
enum RuntimeMatch {
    Verified(u64),
    Cleared,
    Unavailable,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VerificationState {
    #[serde(default)]
    fingerprint: Option<String>,
    #[serde(default)]
    verified_at: Option<u64>,
}

static RUNTIME_VERIFICATION: OnceLock<Mutex<HashMap<String, RuntimeVerification>>> =
    OnceLock::new();

fn path(agent: &str) -> Result<std::path::PathBuf, String> {
    let name = if agent == hook_installer::CODEX {
        "hook-verification.json".to_string()
    } else {
        format!("hook-verification-{agent}.json")
    };
    Ok(config::config_dir()?.join(name))
}

pub fn verified_at(agent: &str) -> Option<u64> {
    let fingerprint = hook_installer::verification_fingerprint(agent)
        .ok()
        .flatten()?;
    let runtime = RUNTIME_VERIFICATION
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .ok()
        .and_then(|states| states.get(agent).cloned())
        .unwrap_or_default();
    match match_runtime(&runtime, &fingerprint) {
        RuntimeMatch::Verified(timestamp) => return Some(timestamp),
        RuntimeMatch::Cleared => return None,
        RuntimeMatch::Unavailable => {}
    }
    let state = load(agent).ok()?;
    persisted_verified_at(&state, &fingerprint)
}

fn match_runtime(runtime: &RuntimeVerification, fingerprint: &str) -> RuntimeMatch {
    match runtime {
        RuntimeVerification::Verified(memory) if memory.fingerprint == fingerprint => {
            RuntimeMatch::Verified(memory.verified_at)
        }
        RuntimeVerification::Cleared => RuntimeMatch::Cleared,
        _ => RuntimeMatch::Unavailable,
    }
}

fn persisted_verified_at(state: &VerificationState, fingerprint: &str) -> Option<u64> {
    if state.fingerprint.as_deref() != Some(fingerprint) {
        return None;
    }
    state.verified_at
}

pub fn record(agent: &str, timestamp: u64) -> Result<(), String> {
    let Some(fingerprint) = hook_installer::verification_fingerprint(agent)? else {
        return Ok(());
    };
    let verified_at = RUNTIME_VERIFICATION
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .map(|mut states| {
            let state = states.entry(agent.to_string()).or_default();
            let verified_at = match &*state {
                RuntimeVerification::Verified(memory) if memory.fingerprint == fingerprint => {
                    memory.verified_at
                }
                _ => timestamp,
            };
            *state = RuntimeVerification::Verified(MemoryVerification {
                fingerprint: fingerprint.clone(),
                verified_at,
            });
            verified_at
        })
        .unwrap_or(timestamp);
    let existing = load(agent).unwrap_or_default();
    if existing.fingerprint.as_deref() == Some(fingerprint.as_str())
        && existing.verified_at.is_some()
    {
        return Ok(());
    }
    save(
        agent,
        &VerificationState {
            fingerprint: Some(fingerprint),
            verified_at: Some(verified_at),
        },
    )
}

pub fn clear(agent: &str) -> Result<(), String> {
    if let Ok(mut states) = RUNTIME_VERIFICATION
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
    {
        states.insert(agent.to_string(), RuntimeVerification::Cleared);
    }
    save(agent, &VerificationState::default())
}

fn load(agent: &str) -> Result<VerificationState, String> {
    let path = path(agent)?;
    if !path.exists() {
        return Ok(VerificationState::default());
    }
    let bytes =
        std::fs::read(&path).map_err(|error| format!("读取 {} 失败：{error}", path.display()))?;
    serde_json::from_slice(&bytes).map_err(|error| format!("解析 {} 失败：{error}", path.display()))
}

fn save(agent: &str, state: &VerificationState) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(state).map_err(|error| error.to_string())?;
    config::atomic_write(&path(agent)?, &bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_state_is_not_verified() {
        let state = VerificationState::default();
        assert!(persisted_verified_at(&state, "v1-current").is_none());
    }

    #[test]
    fn persisted_verification_only_matches_the_same_hook_fingerprint() {
        let state = || VerificationState {
            fingerprint: Some("v1-current".into()),
            verified_at: Some(42),
        };

        assert_eq!(persisted_verified_at(&state(), "v1-current"), Some(42));
        assert!(persisted_verified_at(&state(), "v1-changed").is_none());
    }

    #[test]
    fn persisted_state_does_not_store_a_stale_last_event() {
        let state = VerificationState {
            fingerprint: Some("v1-current".into()),
            verified_at: Some(42),
        };
        let value = serde_json::to_value(state).unwrap();
        assert!(value.get("lastEvent").is_none());
    }

    #[test]
    fn runtime_verification_survives_a_persistence_failure_for_the_current_fingerprint() {
        let runtime = RuntimeVerification::Verified(MemoryVerification {
            fingerprint: "v1-current".into(),
            verified_at: 42,
        });
        assert_eq!(
            match_runtime(&runtime, "v1-current"),
            RuntimeMatch::Verified(42)
        );
        assert_eq!(
            match_runtime(&runtime, "v1-changed"),
            RuntimeMatch::Unavailable
        );
        assert_eq!(
            match_runtime(&RuntimeVerification::Cleared, "v1-current"),
            RuntimeMatch::Cleared
        );
    }
}
