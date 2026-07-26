use serde_json::{Map, Value};
use std::path::Path;

pub(super) fn build_hook_command(executable: &Path) -> String {
    format!(
        "{} hook --agent codex >/dev/null 2>&1 || true",
        shell_quote(&executable.to_string_lossy())
    )
}

pub(super) fn add_platform_fields(_handler: &mut Map<String, Value>, _command: &str) {}

pub(super) fn is_encoded_agent_cat_command(_command: &str) -> bool {
    false
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hook_command_never_surfaces_relay_failures_to_codex() {
        let command = build_hook_command(Path::new(
            "/Applications/Agent Cat.app/Contents/MacOS/agent-cat",
        ));
        assert_eq!(
            command,
            "'/Applications/Agent Cat.app/Contents/MacOS/agent-cat' hook --agent codex >/dev/null 2>&1 || true"
        );
    }
}
