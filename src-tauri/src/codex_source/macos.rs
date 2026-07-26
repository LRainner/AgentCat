use super::CodexBundle;
use plist::Value as PlistValue;
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
};

const CODEX_BUNDLE_ID: &str = "com.openai.codex";

pub(super) fn installed_bundles(home: &Path) -> Vec<CodexBundle> {
    let candidates = [
        PathBuf::from("/Applications/ChatGPT.app"),
        home.join("Applications/ChatGPT.app"),
        PathBuf::from("/Applications/Codex.app"),
        home.join("Applications/Codex.app"),
    ];
    let mut seen = HashSet::new();
    candidates
        .into_iter()
        .filter_map(|path| {
            let canonical = fs::canonicalize(&path).ok()?;
            if !seen.insert(canonical.clone()) {
                return None;
            }
            let info = read_bundle_info(&canonical)?;
            (info.bundle_id == CODEX_BUNDLE_ID).then_some(CodexBundle {
                path: canonical,
                version: info.version,
            })
        })
        .collect()
}

struct BundleInfo {
    bundle_id: String,
    version: Option<String>,
}

fn read_bundle_info(bundle: &Path) -> Option<BundleInfo> {
    let value = PlistValue::from_file(bundle.join("Contents/Info.plist")).ok()?;
    let dictionary = value.as_dictionary()?;
    let bundle_id = dictionary
        .get("CFBundleIdentifier")?
        .as_string()?
        .to_string();
    let version = dictionary
        .get("CFBundleShortVersionString")
        .or_else(|| dictionary.get("CFBundleVersion"))
        .and_then(PlistValue::as_string)
        .map(str::to_string);
    Some(BundleInfo { bundle_id, version })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codex_source::{builtin_pets, read_asset_locator};

    #[test]
    fn scans_installed_chatgpt_bundle_when_available() {
        let path = PathBuf::from("/Applications/ChatGPT.app");
        if !path.is_dir() {
            return;
        }
        let info = read_bundle_info(&path).expect("read ChatGPT Info.plist");
        assert_eq!(info.bundle_id, CODEX_BUNDLE_ID);
        let bundle = CodexBundle {
            path,
            version: info.version,
        };
        let scan = builtin_pets(&bundle).expect("scan ChatGPT app.asar");
        assert!(scan.errors.is_empty(), "{:#?}", scan.errors);
        assert!(scan.pets.len() >= 9, "found {} pets", scan.pets.len());
        assert!(scan.pets.iter().any(|pet| pet.id == "codex"));
        assert!(scan.pets.iter().any(|pet| pet.id == "null-signal"));
        assert!(scan
            .pets
            .iter()
            .all(|pet| pet.version == 2 && pet.width == 1536 && pet.height == 2288));
        let bytes = read_asset_locator(&scan.pets[0].spritesheet_path)
            .expect("ASAR locator")
            .expect("read ASAR pet");
        assert!(!bytes.is_empty());
    }
}
