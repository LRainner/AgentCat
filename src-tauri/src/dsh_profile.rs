//! DeepSeek Harness plugin installation.
//!
//! Agent Cat "installs" the `dsh-session-agent-cat` plugin into a DeepSeek
//! Harness deployment by writing two things into the user's Harness home:
//!
//! 1. The plugin package source, copied to `$DSH_HOME/profiles/node_modules/
//!    dsh-session-agent-cat/` (so the profile's bare module name resolves).
//! 2. One `insert` entry in the user patch layer `cordis.patch.yml`, which
//!    DeepSeek Harness hot-reloads at runtime.
//!
//! The user patch layer is the ONLY file we touch. We never modify the
//! shipped base bundle or any other Harness-owned file.
//!
//! The patch file may carry `!!js` YAML expressions (Cordis interpolates them
//! at mount), which a strict YAML parser cannot represent. We therefore edit
//! it as text, using a stable, unique marker (`- id: session-agent-cat`) to
//! detect our own insert block and leave every other byte untouched.

use crate::config;
use serde::Serialize;
use std::{
    fs,
    path::{Path, PathBuf},
    sync::OnceLock,
};

pub const PLUGIN_NAME: &str = "dsh-session-agent-cat";
const PATCH_MARKER: &str = "- id: session-agent-cat";

/// The plugin source files we ship inside the Agent Cat binary. Each entry is
/// a path relative to the plugin package root and its file contents.
/// The plugin is shipped as plain JavaScript (`lib/`) so DeepSeek Harness's
/// loader (native ESM import) can run it without any build step.
const PLUGIN_FILES: &[(&str, &str)] = &[
    (
        "package.json",
        include_str!("../../plugins/dsh-session-agent-cat/package.json"),
    ),
    (
        "lib/index.js",
        include_str!("../../plugins/dsh-session-agent-cat/lib/index.js"),
    ),
    (
        "lib/agent-event.js",
        include_str!("../../plugins/dsh-session-agent-cat/lib/agent-event.js"),
    ),
];

static SOURCE_FINGERPRINT: OnceLock<String> = OnceLock::new();

/// Stable identity of the plugin source shipped inside this Agent Cat binary.
/// Basing hook verification on this (rather than a constant) means a future
/// plugin update invalidates previously persisted "connected" state.
pub fn source_fingerprint() -> String {
    SOURCE_FINGERPRINT
        .get_or_init(|| {
            let mut hash = 0xcbf29ce484222325_u64;
            for (relative, contents) in PLUGIN_FILES {
                for byte in relative.bytes().chain([0]).chain(contents.bytes()) {
                    hash = (hash ^ u64::from(byte)).wrapping_mul(0x100000001b3);
                }
            }
            format!("v1-dsh-{hash:016x}")
        })
        .clone()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DshHookStatus {
    pub harness_home: String,
    pub patch_path: String,
    pub patch_exists: bool,
    pub plugin_source_exists: bool,
    pub installed: bool,
    pub message: String,
}

fn dsh_home() -> Result<PathBuf, String> {
    if let Some(value) = std::env::var_os("DSH_HOME") {
        let value = PathBuf::from(value);
        if value.as_os_str().is_empty() {
            return Ok(config::home_dir()?.join(".dsh"));
        }
        return Ok(value);
    }
    Ok(config::home_dir()?.join(".dsh"))
}

fn profile_dirs(home: &Path) -> Vec<PathBuf> {
    let profiles = home.join("profiles");
    let mut dirs = Vec::new();
    for name in ["web", "headless"] {
        let dir = profiles.join(name);
        if dir.is_dir() {
            dirs.push(dir);
        }
    }
    // Fall back to any profile directory present, so a custom profile still works.
    if dirs.is_empty() {
        if let Ok(entries) = fs::read_dir(&profiles) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir()
                    && path.file_name().and_then(|n| n.to_str()) != Some("node_modules")
                {
                    dirs.push(path);
                }
            }
        }
    }
    dirs
}

fn patch_paths(home: &Path) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    for dir in profile_dirs(home) {
        paths.push(dir.join("cordis.patch.yml"));
    }
    // Home-level user patch layer (applied last, highest priority). We do not
    // create it — we only patch it when it already exists.
    let home_patch = home.join("cordis.patch.yml");
    if home_patch.is_file() {
        paths.push(home_patch);
    }
    paths
}

fn node_modules_dir(home: &Path) -> PathBuf {
    home.join("profiles").join("node_modules")
}

fn insert_block() -> String {
    "\n- insert:\n    - id: session-agent-cat\n      name: 'dsh-session-agent-cat'\n      config:\n        enabled: true\n"
        .to_string()
}

/// Replace a standalone empty-list line (`[]`, optionally surrounded by
/// whitespace) with our insert block, or append the block when the file is a
/// non-empty list we do not recognize as ours yet. Editing is line-oriented so
/// every other byte — comments, `!!js` expressions, line endings — is kept
/// verbatim.
fn add_insert_block(content: &str) -> Result<String, String> {
    if content.contains(PATCH_MARKER) {
        // Already present; idempotent.
        return Ok(content.to_string());
    }
    let block = insert_block().trim().to_string();
    let mut out = String::with_capacity(content.len() + block.len());
    let mut cursor = 0;
    let mut replaced = false;
    while cursor < content.len() {
        let line_end = content[cursor..]
            .find('\n')
            .map(|offset| cursor + offset + 1)
            .unwrap_or(content.len());
        let line = &content[cursor..line_end];
        let bare = line.trim_end_matches(['\r', '\n']);
        // Only an unindented line whose trimmed content is exactly `[]` is the
        // canonical empty top-level list. `[]` inside comments, `!!js`
        // expressions, or an indented nested value is left untouched.
        if !replaced && bare.trim_end() == "[]" && bare.starts_with("[]") {
            let marker = line
                .find("[]")
                .expect("an unindented `[]` line contains the marker");
            out.push_str(&line[..marker]);
            out.push_str(&block);
            out.push_str(&line[marker + 2..]);
            replaced = true;
        } else {
            out.push_str(line);
        }
        cursor = line_end;
    }
    if replaced {
        return Ok(out);
    }
    // A user patch layer is a top-level YAML array. When no empty-list marker
    // exists, append the insert block without rewriting any existing bytes.
    let mut out = content.to_string();
    if !out.is_empty() && !out.ends_with('\n') {
        out.push('\n');
    }
    out.push_str(&block);
    out.push('\n');
    Ok(out)
}

/// Remove our `- insert:` block from the patch text, restoring `[]` when the
/// result would otherwise be an empty list.
///
/// The block we write is always exactly six lines (the `- insert:` row plus
/// the five indented lines ending in `enabled: true`). We locate the `- insert:`
/// line that is immediately followed by our marker and drop those six lines.
/// Line endings (LF or CRLF) are preserved byte-for-byte for every line we do
/// not remove.
fn remove_insert_block(content: &str) -> String {
    if !content.contains(PATCH_MARKER) {
        return content.to_string();
    }
    let mut segments = Vec::new();
    let mut cursor = 0;
    while cursor < content.len() {
        let end = content[cursor..]
            .find('\n')
            .map(|offset| cursor + offset + 1)
            .unwrap_or(content.len());
        segments.push(&content[cursor..end]);
        cursor = end;
    }
    let newline = if content.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    };
    let mut kept = Vec::new();
    let mut index = 0;
    while index < segments.len() {
        let is_our_insert = segments[index].trim() == "- insert:"
            && segments
                .get(index + 1)
                .is_some_and(|next| next.trim_start().starts_with(PATCH_MARKER));
        if is_our_insert {
            // Our insert element is exactly five lines:
            //   - insert:
            //       - id: session-agent-cat
            //         name: 'dsh-session-agent-cat'
            //         config:
            //           enabled: true
            index += 5;
            continue;
        }
        kept.push(segments[index]);
        index += 1;
    }
    // Drop trailing blank lines left by the removed block.
    while kept.last().is_some_and(|line| line.trim().is_empty()) {
        kept.pop();
    }
    let mut result = kept.concat();
    if !result.is_empty() && !result.ends_with('\n') {
        result.push_str(newline);
    }
    // If the list no longer has any entries (only comments/blank lines remain),
    // restore the canonical empty-list marker.
    let has_list_item = kept.iter().any(|line| {
        let trimmed = line.trim();
        trimmed.starts_with("- ") || trimmed == "[]" || trimmed.starts_with("- insert:")
    });
    if !has_list_item {
        let mut restored = result.trim_end().to_string();
        if !restored.is_empty() && !restored.ends_with('\n') {
            restored.push_str(newline);
        }
        restored.push_str("[]");
        restored.push_str(newline);
        return restored;
    }
    result
}

fn write_plugin_source(home: &Path) -> Result<(), String> {
    let root = node_modules_dir(home).join(PLUGIN_NAME);
    // Wipe any previous copy so stale files (e.g. an older `src/*.ts` layout)
    // from an earlier install can never shadow the current `lib/*.js` entry.
    if root.is_dir() {
        fs::remove_dir_all(&root)
            .map_err(|error| format!("清理 {} 失败：{error}", root.display()))?;
    }
    for (relative, contents) in PLUGIN_FILES {
        let target = root.join(relative);
        if let Some(parent) = target.parent() {
            config::ensure_private_dir(parent)?;
        }
        fs::write(&target, contents)
            .map_err(|error| format!("写入 {} 失败：{error}", target.display()))?;
    }
    Ok(())
}

fn remove_plugin_source(home: &Path) -> Result<(), String> {
    let root = node_modules_dir(home).join(PLUGIN_NAME);
    if root.is_dir() {
        fs::remove_dir_all(&root)
            .map_err(|error| format!("删除 {} 失败：{error}", root.display()))?;
    }
    Ok(())
}

pub fn status() -> Result<DshHookStatus, String> {
    let home = dsh_home()?;
    let paths = patch_paths(&home);
    let primary = paths
        .first()
        .cloned()
        .unwrap_or_else(|| home.join("cordis.patch.yml"));
    let patch_installed = paths.iter().any(|path| {
        fs::read_to_string(path)
            .map(|content| content.contains(PATCH_MARKER))
            .unwrap_or(false)
    });
    let plugin_root = node_modules_dir(&home).join(PLUGIN_NAME);
    let plugin_source_exists = ["package.json", "lib/index.js", "lib/agent-event.js"]
        .iter()
        .all(|relative| plugin_root.join(relative).is_file());
    let installed = patch_installed && plugin_source_exists;
    let message = if installed {
        "DeepSeek Harness 插件已安装".to_string()
    } else if patch_installed && !plugin_source_exists {
        "插件入口存在，但插件包缺失；请重新连接以修复".to_string()
    } else {
        "尚未安装 DeepSeek Harness 插件".to_string()
    };
    Ok(DshHookStatus {
        harness_home: home.to_string_lossy().to_string(),
        patch_path: primary.to_string_lossy().to_string(),
        patch_exists: primary.is_file(),
        plugin_source_exists,
        installed,
        message,
    })
}

pub fn install() -> Result<DshHookStatus, String> {
    let home = dsh_home()?;
    config::ensure_private_dir(&home)?;
    write_plugin_source(&home)?;

    let paths = patch_paths(&home);
    // Ensure a profile directory exists so there is always at least one patch
    // target. Prefer `web` (the primary surface).
    if paths.is_empty() {
        let web = home.join("profiles").join("web");
        config::ensure_private_dir(&web)?;
        let patch = web.join("cordis.patch.yml");
        if !patch.exists() {
            fs::write(&patch, "[]\n")
                .map_err(|error| format!("创建 {} 失败：{error}", patch.display()))?;
        }
    }
    let paths = patch_paths(&home);
    for path in &paths {
        let content = if path.is_file() {
            fs::read_to_string(path)
                .map_err(|error| format!("读取 {} 失败：{error}", path.display()))?
        } else {
            "[]\n".to_string()
        };
        let updated = add_insert_block(&content)?;
        config::atomic_write(path, updated.as_bytes())?;
    }
    status()
}

pub fn uninstall() -> Result<DshHookStatus, String> {
    let home = dsh_home()?;
    for path in patch_paths(&home) {
        if path.is_file() {
            let content = fs::read_to_string(&path)
                .map_err(|error| format!("读取 {} 失败：{error}", path.display()))?;
            let updated = remove_insert_block(&content);
            if updated != content {
                config::atomic_write(&path, updated.as_bytes())?;
            }
        }
    }
    remove_plugin_source(&home)?;
    status()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn insert_into_empty_list_replaces_the_marker() {
        let updated = add_insert_block("# comment\n[]\n").unwrap();
        assert!(updated.contains(PATCH_MARKER));
        assert!(updated.contains("- insert:"));
        assert!(!updated.contains("[]"));
        // Re-adding is idempotent.
        let again = add_insert_block(&updated).unwrap();
        assert_eq!(again, updated);
    }

    #[test]
    fn insert_is_skipped_when_already_present() {
        let content =
            "- insert:\n    - id: session-agent-cat\n      name: 'dsh-session-agent-cat'\n";
        assert_eq!(add_insert_block(content).unwrap(), content);
    }

    #[test]
    fn remove_restores_an_empty_list() {
        let content = "# comment\n- insert:\n    - id: session-agent-cat\n      name: 'dsh-session-agent-cat'\n      config:\n        enabled: true\n";
        let updated = remove_insert_block(content);
        assert!(!updated.contains(PATCH_MARKER));
        assert!(updated.contains("[]"));
    }

    #[test]
    fn remove_is_idempotent_without_our_marker() {
        let content = "# user comment\n[]\n";
        assert_eq!(remove_insert_block(content), content);
    }

    #[test]
    fn insert_only_replaces_a_standalone_empty_list_line() {
        let content = "# note: [] must stay\n- config:\n    allow: []\n\n[]\n";
        let updated = add_insert_block(content).unwrap();
        assert!(updated.contains(PATCH_MARKER));
        assert!(updated.contains("# note: [] must stay"));
        assert!(updated.contains("allow: []"));
        assert!(updated.ends_with("- insert:\n    - id: session-agent-cat\n      name: 'dsh-session-agent-cat'\n      config:\n        enabled: true\n"));
    }

    #[test]
    fn insert_never_rewrites_an_indented_empty_list_value() {
        let content = "    []\n";
        let updated = add_insert_block(content).unwrap();
        assert!(updated.starts_with(content));
        assert!(updated.contains(PATCH_MARKER));
    }

    #[test]
    fn insert_and_remove_preserve_crlf_line_endings() {
        let content = "# comment\r\n[]\r\n";
        let updated = add_insert_block(content).unwrap();
        assert!(updated.starts_with("# comment\r\n"));
        assert!(updated.ends_with("enabled: true\r\n"));
        let removed = remove_insert_block(&updated);
        assert_eq!(removed, content);
    }

    #[test]
    fn insert_appends_after_existing_list_entries_without_rewriting_them() {
        let content = "# header\r\n- disable:\r\n    id: some-plugin\r\n";
        let updated = add_insert_block(content).unwrap();
        assert!(updated.starts_with(content));
        assert!(updated.ends_with("enabled: true\n"));
        assert!(updated.contains(PATCH_MARKER));
    }
}
