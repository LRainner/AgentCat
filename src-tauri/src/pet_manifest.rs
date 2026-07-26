use image::ImageReader;
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
};

pub const CELL_WIDTH: u32 = 192;
pub const CELL_HEIGHT: u32 = 208;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PetManifest {
    id: String,
    display_name: String,
    description: Option<String>,
    sprite_version_number: Option<u8>,
    spritesheet_path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PetDescriptor {
    pub key: String,
    pub id: String,
    pub display_name: String,
    pub description: Option<String>,
    pub version: u8,
    pub source: String,
    pub manifest_path: String,
    pub spritesheet_path: String,
    pub width: u32,
    pub height: u32,
}

pub fn load(path: &Path, source: &str, key_prefix: &str) -> Result<PetDescriptor, String> {
    let bytes = fs::read(path).map_err(|error| format!("读取 manifest 失败：{error}"))?;
    if bytes.len() > 256 * 1024 {
        return Err("pet.json 超过 256 KiB".into());
    }
    let manifest: PetManifest =
        serde_json::from_slice(&bytes).map_err(|error| format!("pet.json 无效：{error}"))?;
    if manifest.id.trim().is_empty() || manifest.display_name.trim().is_empty() {
        return Err("id 和 displayName 不能为空".into());
    }
    if manifest.id.len() > 128 || manifest.display_name.len() > 256 {
        return Err("id 或 displayName 过长".into());
    }
    if manifest.description.as_ref().map(String::len).unwrap_or(0) > 4096
        || manifest.spritesheet_path.len() > 4096
    {
        return Err("description 或 spritesheetPath 过长".into());
    }
    let version = manifest.sprite_version_number.unwrap_or(1);
    if version != 1 && version != 2 {
        return Err(format!("不支持 spriteVersionNumber={version}"));
    }
    let parent = path
        .parent()
        .ok_or_else(|| "pet.json 没有父目录".to_string())?;
    let relative = PathBuf::from(&manifest.spritesheet_path);
    if relative.is_absolute()
        || relative
            .components()
            .any(|part| matches!(part, std::path::Component::ParentDir))
    {
        return Err("spritesheetPath 必须是宠物目录内的相对路径".into());
    }
    let spritesheet = parent.join(relative);
    let extension = spritesheet
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if extension != "png" && extension != "webp" {
        return Err("spritesheet 只支持 PNG 或 WebP".into());
    }
    let reader = ImageReader::open(&spritesheet)
        .map_err(|error| format!("打开 spritesheet 失败：{error}"))?;
    let (width, height) = reader
        .into_dimensions()
        .map_err(|error| format!("读取 spritesheet 尺寸失败：{error}"))?;
    let expected_height = CELL_HEIGHT * if version == 2 { 11 } else { 9 };
    if width != CELL_WIDTH * 8 || height != expected_height {
        return Err(format!(
            "spritesheet 为 {width}×{height}，{version} 版应为 {}×{expected_height}",
            CELL_WIDTH * 8
        ));
    }
    let manifest_path = canonical_string(path);
    let spritesheet_path = canonical_string(&spritesheet);
    let key = if source == "user-folder" {
        format!("user-folder:{manifest_path}")
    } else {
        format!("{key_prefix}:{}", manifest.id)
    };
    Ok(PetDescriptor {
        key,
        id: manifest.id,
        display_name: manifest.display_name,
        description: manifest.description,
        version,
        source: source.to_string(),
        manifest_path,
        spritesheet_path,
        width,
        height,
    })
}

fn canonical_string(path: &Path) -> String {
    fs::canonicalize(path)
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../fixtures")
            .join(name)
            .join("pet.json")
    }

    #[test]
    fn constants_match_codex_grid() {
        assert_eq!(CELL_WIDTH * 8, 1536);
        assert_eq!(CELL_HEIGHT * 9, 1872);
        assert_eq!(CELL_HEIGHT * 11, 2288);
    }

    #[test]
    fn loads_v1_when_version_is_missing_and_ignores_unknown_fields() {
        let pet = load(&fixture("v1-pet"), "codex-custom", "codex-custom").unwrap();
        assert_eq!(pet.version, 1);
        assert_eq!((pet.width, pet.height), (1536, 1872));
    }

    #[test]
    fn loads_v2_grid() {
        let pet = load(&fixture("v2-pet"), "user-folder", "user-folder").unwrap();
        assert_eq!(pet.version, 2);
        assert_eq!((pet.width, pet.height), (1536, 2288));
        assert_eq!(pet.key, format!("user-folder:{}", pet.manifest_path));
    }

    #[test]
    fn rejects_unsupported_version_and_path_traversal() {
        assert!(load(
            &fixture("invalid-pets/unsupported-version"),
            "user-folder",
            "user-folder"
        )
        .unwrap_err()
        .contains("spriteVersionNumber=3"));
        assert!(load(
            &fixture("invalid-pets/path-traversal"),
            "user-folder",
            "user-folder"
        )
        .unwrap_err()
        .contains("相对路径"));
    }
}
