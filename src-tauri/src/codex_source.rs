use crate::pet_manifest::PetDescriptor;
use image::ImageReader;
use serde_json::Value;
use std::{
    collections::{BTreeMap, HashMap, VecDeque},
    fs,
    io::{Cursor, Read, Seek, SeekFrom},
    path::{Component, Path, PathBuf},
    sync::{Mutex, OnceLock},
};

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "windows")]
mod windows;

const ASAR_LOCATOR_PREFIX: &str = "asar:";
const MAX_ASAR_HEADER_BYTES: usize = 32 * 1024 * 1024;
const MAX_ASAR_ASSET_BYTES: u64 = 24 * 1024 * 1024;
static BUILTIN_CACHE: OnceLock<Mutex<HashMap<String, BuiltinPetScan>>> = OnceLock::new();

#[derive(Debug, Clone)]
pub struct CodexBundle {
    pub path: PathBuf,
    pub version: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct BuiltinPetScan {
    pub pets: Vec<PetDescriptor>,
    pub errors: Vec<(String, String)>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct AsarEntry {
    path: String,
    offset: u64,
    size: u64,
}

#[derive(Debug)]
struct AsarIndex {
    data_offset: u64,
    entries: Vec<AsarEntry>,
}

pub fn installed_bundles(home: &Path) -> Vec<CodexBundle> {
    #[cfg(target_os = "macos")]
    return macos::installed_bundles(home);
    #[cfg(target_os = "windows")]
    return windows::installed_bundles(home);
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    Vec::new()
}

pub fn resources_dir(bundle: &CodexBundle) -> Option<PathBuf> {
    let macos = bundle.path.join("Contents/Resources");
    if macos.is_dir() {
        return Some(macos);
    }
    let windows = bundle.path.join("resources");
    windows.is_dir().then_some(windows)
}

pub fn archive_path(bundle: &CodexBundle) -> PathBuf {
    resources_dir(bundle)
        .unwrap_or_else(|| bundle.path.join("resources"))
        .join("app.asar")
}

pub fn manifests(bundle: &CodexBundle) -> Vec<PathBuf> {
    let Some(resources) = resources_dir(bundle) else {
        return Vec::new();
    };
    find_manifests(&resources, 9, 30_000)
}

pub fn builtin_pets(bundle: &CodexBundle) -> Result<BuiltinPetScan, String> {
    let archive = archive_path(bundle);
    if !archive.is_file() {
        return Ok(BuiltinPetScan::default());
    }
    let metadata = fs::metadata(&archive)
        .map_err(|error| format!("读取 {} 元数据失败：{error}", archive.display()))?;
    let modified = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|value| value.as_nanos())
        .unwrap_or_default();
    let cache_key = format!(
        "{}:{}:{}:{modified}",
        archive.display(),
        bundle.version.as_deref().unwrap_or("unknown"),
        metadata.len()
    );
    let cache = BUILTIN_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Ok(values) = cache.lock() {
        if let Some(cached) = values.get(&cache_key) {
            return Ok(cached.clone());
        }
    }
    let index = AsarIndex::open(&archive)?;
    let mut newest_assets: BTreeMap<String, (u32, String)> = BTreeMap::new();
    for entry in &index.entries {
        let Some(file_name) = Path::new(&entry.path)
            .file_name()
            .and_then(|value| value.to_str())
        else {
            continue;
        };
        let Some((id, revision)) = asset_identity(file_name) else {
            continue;
        };
        if !entry.path.starts_with("webview/assets/") {
            continue;
        }
        match newest_assets.get(&id) {
            Some((current, _)) if *current >= revision => {}
            _ => {
                newest_assets.insert(id, (revision, entry.path.clone()));
            }
        }
    }

    let mut file = fs::File::open(&archive)
        .map_err(|error| format!("打开 {} 失败：{error}", archive.display()))?;
    let mut result = BuiltinPetScan::default();
    for (id, (_, internal_path)) in newest_assets {
        let locator = asar_locator(&archive, &internal_path);
        let Some(entry) = index.entry(&internal_path) else {
            continue;
        };
        let bytes = match index.read_entry(&mut file, entry) {
            Ok(bytes) => bytes,
            Err(error) => {
                result.errors.push((locator, error));
                continue;
            }
        };
        let dimensions = ImageReader::new(Cursor::new(&bytes))
            .with_guessed_format()
            .map_err(|error| error.to_string())
            .and_then(|reader| reader.into_dimensions().map_err(|error| error.to_string()));
        let (width, height) = match dimensions {
            Ok(value) => value,
            Err(error) => {
                result
                    .errors
                    .push((locator, format!("读取内置 spritesheet 失败：{error}")));
                continue;
            }
        };
        if width != 1536 || height != 2288 {
            result.errors.push((
                locator,
                format!("内置 spritesheet 为 {width}×{height}，v2 应为 1536×2288"),
            ));
            continue;
        }
        result.pets.push(PetDescriptor {
            key: format!("codex-builtin:{id}"),
            id: id.clone(),
            display_name: builtin_display_name(&id),
            description: None,
            version: 2,
            source: "codex-builtin".into(),
            manifest_path: format!("{}builtin/{id}/pet.json", asar_locator_prefix(&archive)),
            spritesheet_path: asar_locator(&archive, &internal_path),
            width,
            height,
        });
    }
    if let Ok(mut values) = cache.lock() {
        values.retain(|key, _| !key.starts_with(&format!("{}:", archive.display())));
        values.insert(cache_key, result.clone());
    }
    Ok(result)
}

pub fn read_asset_locator(locator: &str) -> Option<Result<Vec<u8>, String>> {
    let (archive, internal_path) = parse_asar_locator(locator)?;
    Some((|| {
        let index = AsarIndex::open(&archive)?;
        let entry = index
            .entry(&internal_path)
            .ok_or_else(|| format!("ASAR 中不存在 {internal_path}"))?;
        let mut file = fs::File::open(&archive)
            .map_err(|error| format!("打开 {} 失败：{error}", archive.display()))?;
        index.read_entry(&mut file, entry)
    })())
}

pub fn find_manifests(root: &Path, max_depth: usize, max_entries: usize) -> Vec<PathBuf> {
    let mut queue = VecDeque::from([(root.to_path_buf(), 0usize)]);
    let mut found = Vec::new();
    let mut visited = 0usize;
    while let Some((directory, depth)) = queue.pop_front() {
        if depth > max_depth || visited >= max_entries {
            continue;
        }
        let Ok(entries) = fs::read_dir(directory) else {
            continue;
        };
        for entry in entries.flatten() {
            visited += 1;
            if visited > max_entries {
                break;
            }
            let path = entry.path();
            if path.file_name().and_then(|value| value.to_str()) == Some("pet.json") {
                found.push(path);
            } else if depth < max_depth
                && entry
                    .file_type()
                    .map(|value| value.is_dir())
                    .unwrap_or(false)
            {
                queue.push_back((path, depth + 1));
            }
        }
    }
    found
}

impl AsarIndex {
    fn open(path: &Path) -> Result<Self, String> {
        let mut file = fs::File::open(path)
            .map_err(|error| format!("打开 {} 失败：{error}", path.display()))?;
        Self::read(&mut file)
    }

    fn read(reader: &mut impl Read) -> Result<Self, String> {
        let mut prefix = [0u8; 16];
        reader
            .read_exact(&mut prefix)
            .map_err(|error| format!("ASAR header 不完整：{error}"))?;
        if u32::from_le_bytes(prefix[0..4].try_into().unwrap()) != 4 {
            return Err("ASAR magic 无效".into());
        }
        let header_size = u32::from_le_bytes(prefix[4..8].try_into().unwrap()) as usize;
        let json_size = u32::from_le_bytes(prefix[12..16].try_into().unwrap()) as usize;
        if json_size == 0
            || json_size > MAX_ASAR_HEADER_BYTES
            || header_size < json_size + 4
            || header_size > MAX_ASAR_HEADER_BYTES + 8
        {
            return Err(format!(
                "ASAR header 尺寸无效：header={header_size}, json={json_size}"
            ));
        }
        let mut json = vec![0u8; json_size];
        reader
            .read_exact(&mut json)
            .map_err(|error| format!("读取 ASAR 索引失败：{error}"))?;
        let root: Value = serde_json::from_slice(&json)
            .map_err(|error| format!("解析 ASAR 索引失败：{error}"))?;
        let mut entries = Vec::new();
        collect_asar_entries(&root, "", 0, &mut entries)?;
        Ok(Self {
            data_offset: header_size as u64 + 8,
            entries,
        })
    }

    fn entry(&self, path: &str) -> Option<&AsarEntry> {
        self.entries.iter().find(|entry| entry.path == path)
    }

    fn read_entry(
        &self,
        reader: &mut (impl Read + Seek),
        entry: &AsarEntry,
    ) -> Result<Vec<u8>, String> {
        if entry.size > MAX_ASAR_ASSET_BYTES {
            return Err(format!("ASAR asset 超过 24 MiB：{}", entry.path));
        }
        let start = self
            .data_offset
            .checked_add(entry.offset)
            .ok_or_else(|| "ASAR offset 溢出".to_string())?;
        reader
            .seek(SeekFrom::Start(start))
            .map_err(|error| format!("定位 ASAR asset 失败：{error}"))?;
        let mut bytes = vec![0u8; entry.size as usize];
        reader
            .read_exact(&mut bytes)
            .map_err(|error| format!("读取 ASAR asset 失败：{error}"))?;
        Ok(bytes)
    }
}

fn collect_asar_entries(
    node: &Value,
    parent: &str,
    depth: usize,
    output: &mut Vec<AsarEntry>,
) -> Result<(), String> {
    if depth > 32 || output.len() > 100_000 {
        return Err("ASAR 索引层级或条目数超限".into());
    }
    let Some(files) = node.get("files").and_then(Value::as_object) else {
        return Ok(());
    };
    for (name, child) in files {
        if name.contains('/') || name == "." || name == ".." {
            continue;
        }
        let path = if parent.is_empty() {
            name.clone()
        } else {
            format!("{parent}/{name}")
        };
        if child.get("files").is_some() {
            collect_asar_entries(child, &path, depth + 1, output)?;
            continue;
        }
        let Some(size) = child.get("size").and_then(Value::as_u64) else {
            continue;
        };
        let Some(offset) = child
            .get("offset")
            .and_then(Value::as_str)
            .and_then(|value| value.parse::<u64>().ok())
        else {
            continue;
        };
        output.push(AsarEntry { path, offset, size });
    }
    Ok(())
}

fn parse_asar_locator(locator: &str) -> Option<(PathBuf, String)> {
    let remainder = locator.strip_prefix(ASAR_LOCATOR_PREFIX)?;
    let (archive, internal) = remainder.split_once("!/")?;
    if archive.is_empty() || internal.is_empty() {
        return None;
    }
    let internal_path = Path::new(internal);
    if internal_path.is_absolute()
        || internal_path
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return None;
    }
    Some((PathBuf::from(archive), internal.replace('\\', "/")))
}

fn asar_locator(archive: &Path, internal: &str) -> String {
    format!("{}{}!/{}", ASAR_LOCATOR_PREFIX, archive.display(), internal)
}

fn asar_locator_prefix(archive: &Path) -> String {
    format!("{}{}!/", ASAR_LOCATOR_PREFIX, archive.display())
}

fn asset_identity(file_name: &str) -> Option<(String, u32)> {
    let extension = Path::new(file_name)
        .extension()
        .and_then(|value| value.to_str())?
        .to_ascii_lowercase();
    if extension != "webp" && extension != "png" {
        return None;
    }
    let (id, suffix) = file_name.split_once("-spritesheet-")?;
    if id.is_empty() {
        return None;
    }
    let revision = suffix
        .strip_prefix('v')
        .unwrap_or(suffix)
        .chars()
        .take_while(char::is_ascii_digit)
        .collect::<String>()
        .parse()
        .unwrap_or(0);
    Some((id.to_string(), revision))
}

fn builtin_display_name(id: &str) -> String {
    match id {
        "codex" => "Codex".into(),
        "dewey" => "Dewey".into(),
        "fireball" => "Fireball".into(),
        "hoots" => "Hoots".into(),
        "rocky" => "Rocky".into(),
        "seedy" => "Seedy".into(),
        "stacky" => "Stacky".into(),
        "bsod" => "BSOD".into(),
        "null-signal" => "Null Signal".into(),
        _ => id
            .split('-')
            .map(|part| {
                let mut chars = part.chars();
                chars
                    .next()
                    .map(|first| first.to_uppercase().collect::<String>() + chars.as_str())
                    .unwrap_or_default()
            })
            .collect::<Vec<_>>()
            .join(" "),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_small_asar_without_loading_the_archive() {
        let json = br#"{"files":{"webview":{"files":{"assets":{"files":{"codex-spritesheet-v2-test.webp":{"size":4,"offset":"0"}}}}}}}"#;
        let aligned = json.len().div_ceil(4) * 4;
        let mut archive = Vec::new();
        archive.extend_from_slice(&4u32.to_le_bytes());
        archive.extend_from_slice(&((aligned + 8) as u32).to_le_bytes());
        archive.extend_from_slice(&((aligned + 4) as u32).to_le_bytes());
        archive.extend_from_slice(&(json.len() as u32).to_le_bytes());
        archive.extend_from_slice(json);
        archive.resize(16 + aligned, 0);
        archive.extend_from_slice(b"RIFF");
        let mut cursor = Cursor::new(archive);
        let index = AsarIndex::read(&mut cursor).unwrap();
        let entry = index
            .entry("webview/assets/codex-spritesheet-v2-test.webp")
            .unwrap();
        assert_eq!(index.read_entry(&mut cursor, entry).unwrap(), b"RIFF");
    }

    #[test]
    fn extracts_id_and_prefers_numeric_asset_revision() {
        assert_eq!(
            asset_identity("null-signal-spritesheet-v7-hash.webp"),
            Some(("null-signal".into(), 7))
        );
        assert_eq!(asset_identity("not-a-pet.webp"), None);
    }

    #[test]
    fn rejects_parent_components_in_virtual_paths() {
        assert!(parse_asar_locator("asar:/Applications/ChatGPT.app!/../secret").is_none());
        assert!(
            parse_asar_locator("asar:/Applications/ChatGPT.app!/webview/assets/pet.webp").is_some()
        );
    }
}
