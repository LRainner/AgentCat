use super::{HookSpec, CODEX, CODEX_EVENTS};
use crate::config;

pub(super) fn spec() -> Result<HookSpec, String> {
    Ok(HookSpec {
        agent: CODEX,
        display_name: "Codex",
        path: config::home_dir()?.join(".codex/hooks.json"),
        events: &CODEX_EVENTS,
    })
}
