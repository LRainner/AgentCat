use super::CodexBundle;
use std::{
    collections::{HashSet, VecDeque},
    fs,
    path::{Path, PathBuf},
};

pub(super) fn installed_bundles(home: &Path) -> Vec<CodexBundle> {
    let local_app_data = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join("AppData/Local"));
    let mut roots = vec![
        local_app_data.join("OpenAI"),
        local_app_data.join("Programs/OpenAI"),
        local_app_data.join("Programs/ChatGPT"),
        local_app_data.join("Programs/Codex"),
        local_app_data.join("ChatGPT"),
        local_app_data.join("Codex"),
    ];
    if let Some(program_files) = std::env::var_os("ProgramFiles").map(PathBuf::from) {
        roots.extend([
            program_files.join("OpenAI"),
            program_files.join("ChatGPT"),
            program_files.join("Codex"),
        ]);
    }
    let mut candidates: Vec<(PathBuf, Option<String>)> = installed_packages()
        .into_iter()
        .filter_map(|(install_location, version)| {
            let app = install_location.join("app");
            app.join("resources/app.asar")
                .is_file()
                .then_some((app, Some(version)))
        })
        .collect();
    for root in roots {
        candidates.extend(
            find_app_roots(&root, 7, 30_000)
                .into_iter()
                .map(|path| (path, None)),
        );
    }
    let mut seen = HashSet::new();
    candidates
        .into_iter()
        .filter_map(|(path, package_version)| {
            let canonical = fs::canonicalize(path).ok()?;
            if !seen.insert(canonical.clone()) {
                return None;
            }
            let version = package_version.or_else(|| {
                canonical
                    .file_name()
                    .and_then(|value| value.to_str())
                    .and_then(|value| value.strip_prefix("app-"))
                    .map(str::to_string)
            });
            Some(CodexBundle {
                path: canonical,
                version,
            })
        })
        .collect()
}

fn installed_packages() -> Vec<(PathBuf, String)> {
    use windows::{
        core::HSTRING,
        Management::Deployment::PackageManager,
        Win32::System::WinRT::{RoInitialize, RoUninitialize, RO_INIT_SINGLETHREADED},
    };

    struct WinRtInitialization(bool);
    impl Drop for WinRtInitialization {
        fn drop(&mut self) {
            if self.0 {
                unsafe { RoUninitialize() };
            }
        }
    }

    let _initialization =
        WinRtInitialization(unsafe { RoInitialize(RO_INIT_SINGLETHREADED) }.is_ok());
    let Ok(manager) = PackageManager::new() else {
        return Vec::new();
    };
    let Ok(packages) = manager.FindPackagesByUserSecurityId(&HSTRING::new()) else {
        return Vec::new();
    };
    let Ok(iterator) = packages.First() else {
        return Vec::new();
    };
    let mut found = Vec::new();
    while iterator.HasCurrent().unwrap_or(false) {
        if let Ok(package) = iterator.Current() {
            let value = (|| {
                let id = package.Id().ok()?;
                let name = id.Name().ok()?.to_string();
                if !is_supported_package(&name) {
                    return None;
                }
                let version = id.Version().ok()?;
                let location = package.InstalledLocation().ok()?.Path().ok()?.to_string();
                Some((
                    PathBuf::from(location),
                    format!(
                        "{}.{}.{}.{}",
                        version.Major, version.Minor, version.Build, version.Revision
                    ),
                ))
            })();
            if let Some(value) = value {
                found.push(value);
            }
        }
        if iterator.MoveNext().is_err() {
            break;
        }
    }
    found
}

fn is_supported_package(name: &str) -> bool {
    name.eq_ignore_ascii_case("OpenAI.Codex")
        || name.eq_ignore_ascii_case("OpenAI.ChatGPT-Desktop")
        || name.eq_ignore_ascii_case("OpenAI.ChatGPT")
}

fn find_app_roots(root: &Path, max_depth: usize, max_entries: usize) -> Vec<PathBuf> {
    let mut found = Vec::new();
    let mut queue = VecDeque::from([(root.to_path_buf(), 0usize)]);
    let mut visited = 0usize;
    while let Some((directory, depth)) = queue.pop_front() {
        if visited >= max_entries {
            break;
        }
        visited += 1;
        if directory.join("resources/app.asar").is_file() {
            found.push(directory);
            continue;
        }
        if depth >= max_depth {
            continue;
        }
        let Ok(entries) = fs::read_dir(&directory) else {
            continue;
        };
        queue.extend(entries.flatten().filter_map(|entry| {
            entry
                .file_type()
                .ok()
                .filter(|kind| kind.is_dir() && !kind.is_symlink())
                .map(|_| (entry.path(), depth + 1))
        }));
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn discovers_msix_codex_install_location_when_installed() {
        let packages = installed_packages();
        for (location, _) in &packages {
            assert!(location.is_absolute());
            assert!(location.join("app/resources/app.asar").is_file());
        }
    }
}
