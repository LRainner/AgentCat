use crate::{
    codex_source, config,
    pet_manifest::{self, PetDescriptor},
};
use serde::Serialize;
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogDiagnostic {
    pub path: String,
    pub source: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogResult {
    pub pets: Vec<PetDescriptor>,
    pub diagnostics: Vec<CatalogDiagnostic>,
    pub codex_bundles: Vec<CodexBundleSummary>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexBundleSummary {
    pub path: String,
    pub version: Option<String>,
}

pub fn scan(app_config: &config::AppConfig) -> Result<CatalogResult, String> {
    let home = config::home_dir()?;
    let mut candidates: Vec<(PathBuf, &str, &str)> = Vec::new();
    let mut pets = Vec::new();
    let mut diagnostics = Vec::new();
    let bundles = if app_config.pet_sources.scan_codex_builtin {
        codex_source::installed_bundles(&home)
    } else {
        Vec::new()
    };
    for bundle in &bundles {
        match codex_source::builtin_pets(bundle) {
            Ok(scan) => {
                pets.extend(scan.pets);
                diagnostics.extend(scan.errors.into_iter().map(|(path, message)| {
                    CatalogDiagnostic {
                        path,
                        source: "codex-builtin".into(),
                        message,
                    }
                }));
            }
            Err(message) => diagnostics.push(CatalogDiagnostic {
                path: codex_source::archive_path(bundle)
                    .to_string_lossy()
                    .to_string(),
                source: "codex-builtin".into(),
                message,
            }),
        }
        candidates.extend(
            codex_source::manifests(bundle)
                .into_iter()
                .map(|path| (path, "codex-builtin", "codex-builtin")),
        );
    }
    if app_config.pet_sources.scan_codex_custom {
        let root = home.join(".codex/pets");
        candidates.extend(
            direct_pet_manifests(&root)
                .into_iter()
                .map(|path| (path, "codex-custom", "codex-custom")),
        );
    }
    for directory in &app_config.pet_sources.extra_directories {
        let root = expand_home(directory, &home);
        candidates.extend(
            codex_source::find_manifests(&root, 4, 10_000)
                .into_iter()
                .map(|path| (path, "user-folder", "user-folder")),
        );
    }

    let mut seen = HashSet::new();
    for (manifest, source, prefix) in candidates {
        let canonical = std::fs::canonicalize(&manifest).unwrap_or_else(|_| manifest.clone());
        if !seen.insert(canonical) {
            continue;
        }
        match pet_manifest::load(&manifest, source, prefix) {
            Ok(pet) => pets.push(pet),
            Err(message) => diagnostics.push(CatalogDiagnostic {
                path: manifest.to_string_lossy().to_string(),
                source: source.to_string(),
                message,
            }),
        }
    }
    let mut seen_keys = HashSet::new();
    pets.retain(|pet| seen_keys.insert(pet.key.clone()));
    pets.sort_by(|a, b| {
        source_rank(&a.source)
            .cmp(&source_rank(&b.source))
            .then_with(|| {
                a.display_name
                    .to_lowercase()
                    .cmp(&b.display_name.to_lowercase())
            })
    });
    Ok(CatalogResult {
        pets,
        diagnostics,
        codex_bundles: bundles
            .into_iter()
            .map(|bundle| CodexBundleSummary {
                path: bundle.path.to_string_lossy().to_string(),
                version: bundle.version,
            })
            .collect(),
    })
}

fn direct_pet_manifests(root: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter_map(|entry| {
            let manifest = entry.path().join("pet.json");
            manifest.is_file().then_some(manifest)
        })
        .collect()
}

fn expand_home(value: &str, home: &Path) -> PathBuf {
    if value == "~" {
        return home.to_path_buf();
    }
    if let Some(rest) = value.strip_prefix("~/") {
        return home.join(rest);
    }
    if let Some(rest) = value.strip_prefix("~\\") {
        return home.join(rest);
    }
    PathBuf::from(value)
}

fn source_rank(source: &str) -> u8 {
    match source {
        "codex-builtin" => 0,
        "codex-custom" => 1,
        _ => 2,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scans_valid_fixtures_and_isolates_invalid_pets() {
        let mut value = config::AppConfig::default();
        value.pet_sources.scan_codex_builtin = false;
        value.pet_sources.scan_codex_custom = false;
        value.pet_sources.extra_directories = vec![PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../fixtures")
            .to_string_lossy()
            .to_string()];
        let result = scan(&value).unwrap();
        assert_eq!(result.pets.len(), 2);
        assert_eq!(result.diagnostics.len(), 2);
        assert_eq!(
            result
                .pets
                .iter()
                .map(|pet| pet.version)
                .collect::<Vec<_>>(),
            vec![1, 2]
        );
    }
}
