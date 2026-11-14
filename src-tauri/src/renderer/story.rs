use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::f32::consts::{FRAC_PI_2, PI};
use std::fs;
use std::path::{Component, Path, PathBuf};

use super::error::RendererError;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
pub enum LayoutMode {
    #[default]
    Normal,
    Three,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
pub enum Side {
    #[default]
    Center,
    Left,
    Right,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
pub enum MoveSpeed {
    Slow,
    #[default]
    Normal,
    Fast,
    Immediate,
}

impl MoveSpeed {
    pub fn duration_ms(self) -> f64 {
        match self {
            Self::Slow => 700.0,
            Self::Normal => 500.0,
            Self::Fast => 300.0,
            Self::Immediate => 0.0,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
pub enum Curve {
    #[default]
    Linear,
    Sine,
    Cosine,
}

impl Curve {
    /// Matches `curveProgress` in `src/story/scene.ts`.
    pub fn apply(self, progress: f32) -> f32 {
        match self {
            Self::Linear => progress,
            Self::Sine => (progress * FRAC_PI_2).sin(),
            Self::Cosine => (1.0 - (progress * PI).cos()) / 2.0,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PositionData {
    pub side: Side,
    #[serde(default)]
    pub offset: f32,
}

impl Default for PositionData {
    fn default() -> Self {
        Self {
            side: Side::Center,
            offset: 0.0,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type")]
pub enum EffectTargetData {
    Model { model: String },
    Stage,
    Screen,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type")]
pub enum VisualEffectData {
    Grayscale {
        #[serde(default = "default_one")]
        intensity: f32,
    },
    Blur {
        #[serde(default = "default_blur_strength")]
        strength: f32,
        #[serde(default = "default_blur_quality")]
        quality: u32,
        #[serde(rename = "kernelSize", default = "default_blur_kernel_size")]
        kernel_size: u32,
    },
    #[serde(rename_all = "camelCase")]
    OldFilm {
        #[serde(default = "default_03")]
        sepia: f32,
        #[serde(default = "default_03")]
        noise: f32,
        #[serde(default = "default_one")]
        noise_size: f32,
        #[serde(default = "default_05")]
        scratch: f32,
        #[serde(default = "default_03")]
        scratch_density: f32,
        #[serde(default = "default_one")]
        scratch_width: f32,
        #[serde(default = "default_03")]
        vignetting: f32,
        #[serde(default = "default_one")]
        vignetting_alpha: f32,
        #[serde(default = "default_03")]
        vignetting_blur: f32,
    },
    #[serde(rename = "CRT", rename_all = "camelCase")]
    Crt {
        #[serde(default = "default_one")]
        curvature: f32,
        #[serde(default = "default_one")]
        line_width: f32,
        #[serde(default = "default_025")]
        line_contrast: f32,
        #[serde(default)]
        vertical_line: bool,
        #[serde(default = "default_03")]
        noise: f32,
        #[serde(default = "default_one")]
        noise_size: f32,
        #[serde(default = "default_03")]
        vignetting: f32,
        #[serde(default = "default_one")]
        vignetting_alpha: f32,
        #[serde(default = "default_03")]
        vignetting_blur: f32,
    },
    ColorOverlay {
        #[serde(default = "default_black_hex")]
        color: String,
        #[serde(default = "default_05")]
        alpha: f32,
    },
    Hologram,
    TriangleParticles,
}

fn default_one() -> f32 {
    1.0
}
fn default_blur_strength() -> f32 {
    8.0
}
fn default_blur_quality() -> u32 {
    2
}
fn default_blur_kernel_size() -> u32 {
    5
}
fn default_03() -> f32 {
    0.3
}
fn default_05() -> f32 {
    0.5
}
fn default_025() -> f32 {
    0.25
}
fn default_03_f64() -> f64 {
    0.3
}
fn default_black_hex() -> String {
    "#000000".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ParamAnimationData {
    pub param_id: String,
    pub start: f32,
    pub end: f32,
    pub curve: Curve,
    pub duration: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ChangeLayoutModeData {
    pub mode: LayoutMode,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ChangeBackgroundImageData {
    pub background: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LayoutAppearData {
    pub model: String,
    #[serde(default)]
    pub position: PositionData,
    pub motion: Option<String>,
    pub facial: Option<String>,
    #[serde(default)]
    pub hologram: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LayoutClearData {
    pub model: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TalkData {
    pub speaker: String,
    pub content: String,
    pub model: Option<String>,
    pub voice: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MoveData {
    pub model: String,
    pub from: PositionData,
    pub to: PositionData,
    pub move_speed: MoveSpeed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MotionData {
    pub model: String,
    pub motion: Option<String>,
    pub facial: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TelopData {
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DoParamData {
    pub model: String,
    pub params: Vec<ParamAnimationData>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ScreenFadeOutData {
    pub color: String,
    pub duration: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ScreenFadeInData {
    pub duration: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ApplyEffectData {
    pub effect_id: String,
    pub target: EffectTargetData,
    pub effect: VisualEffectData,
    #[serde(default = "default_03_f64")]
    pub duration: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RemoveEffectData {
    pub effect_id: String,
    #[serde(default = "default_03_f64")]
    pub duration: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type")]
pub enum SnippetData {
    ChangeLayoutMode {
        #[serde(default)]
        id: Option<String>,
        #[serde(default)]
        delay: f64,
        data: ChangeLayoutModeData,
    },
    ChangeBackgroundImage {
        #[serde(default)]
        id: Option<String>,
        #[serde(default)]
        delay: f64,
        data: ChangeBackgroundImageData,
    },
    LayoutAppear {
        #[serde(default)]
        id: Option<String>,
        #[serde(default)]
        delay: f64,
        data: LayoutAppearData,
    },
    LayoutClear {
        #[serde(default)]
        id: Option<String>,
        #[serde(default)]
        delay: f64,
        data: LayoutClearData,
    },
    Talk {
        #[serde(default)]
        id: Option<String>,
        #[serde(default)]
        delay: f64,
        data: TalkData,
    },
    HideTalk {
        #[serde(default)]
        id: Option<String>,
        #[serde(default)]
        delay: f64,
    },
    Move {
        #[serde(default)]
        id: Option<String>,
        #[serde(default)]
        delay: f64,
        data: MoveData,
    },
    Motion {
        #[serde(default)]
        id: Option<String>,
        #[serde(default)]
        delay: f64,
        data: MotionData,
    },
    Telop {
        #[serde(default)]
        id: Option<String>,
        #[serde(default)]
        delay: f64,
        data: TelopData,
    },
    DoParam {
        #[serde(default)]
        id: Option<String>,
        #[serde(default)]
        delay: f64,
        data: DoParamData,
    },
    ScreenFadeOut {
        #[serde(default)]
        id: Option<String>,
        #[serde(default)]
        delay: f64,
        data: ScreenFadeOutData,
    },
    ScreenFadeIn {
        #[serde(default)]
        id: Option<String>,
        #[serde(default)]
        delay: f64,
        data: ScreenFadeInData,
    },
    ApplyEffect {
        #[serde(default)]
        id: Option<String>,
        #[serde(default)]
        delay: f64,
        data: ApplyEffectData,
    },
    RemoveEffect {
        #[serde(default)]
        id: Option<String>,
        #[serde(default)]
        delay: f64,
        data: RemoveEffectData,
    },
    Parallel {
        #[serde(default)]
        id: Option<String>,
        #[serde(default)]
        delay: f64,
        #[serde(default)]
        snippets: Vec<SnippetData>,
    },
}

impl SnippetData {
    pub fn delay_ms(&self) -> f64 {
        let secs = match self {
            Self::ChangeLayoutMode { delay, .. }
            | Self::ChangeBackgroundImage { delay, .. }
            | Self::LayoutAppear { delay, .. }
            | Self::LayoutClear { delay, .. }
            | Self::Talk { delay, .. }
            | Self::HideTalk { delay, .. }
            | Self::Move { delay, .. }
            | Self::Motion { delay, .. }
            | Self::Telop { delay, .. }
            | Self::DoParam { delay, .. }
            | Self::ScreenFadeOut { delay, .. }
            | Self::ScreenFadeIn { delay, .. }
            | Self::ApplyEffect { delay, .. }
            | Self::RemoveEffect { delay, .. }
            | Self::Parallel { delay, .. } => *delay,
        };
        if secs.is_finite() && secs > 0.0 {
            secs * 1000.0
        } else {
            0.0
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StoryData {
    #[serde(default = "default_story_version")]
    pub version: u32,
    #[serde(default)]
    pub snippets: Vec<SnippetData>,
}

fn default_story_version() -> u32 {
    1
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModelAsset {
    #[serde(default)]
    pub name: Option<String>,
    pub model_id: String,
    #[serde(default = "default_normal_scale")]
    pub normal_scale: f32,
    #[serde(default = "default_small_scale")]
    pub small_scale: f32,
    #[serde(default = "default_anchor")]
    pub anchor: f32,
}

fn default_normal_scale() -> f32 {
    2.1
}
fn default_small_scale() -> f32 {
    1.8
}
fn default_anchor() -> f32 {
    0.5
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BackgroundAsset {
    #[serde(default)]
    pub name: Option<String>,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct VoiceAsset {
    #[serde(default)]
    pub name: Option<String>,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct ProjectAssets {
    #[serde(default)]
    pub models: HashMap<String, ModelAsset>,
    #[serde(default)]
    pub backgrounds: HashMap<String, BackgroundAsset>,
    #[serde(default)]
    pub voices: HashMap<String, VoiceAsset>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ModelRegistryEntry {
    #[serde(default)]
    pub name: Option<String>,
    pub entry: String,
    #[serde(default)]
    pub motions: Vec<String>,
    #[serde(default)]
    pub facials: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ModelRegistry {
    #[serde(default = "default_story_version")]
    pub version: u32,
    #[serde(default)]
    pub models: HashMap<String, ModelRegistryEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(tag = "source", rename_all = "camelCase")]
pub enum PlaybackFontConfig {
    #[default]
    Default,
    Data {
        family: String,
        path: String,
    },
    System {
        family: String,
    },
}

/// Complete workspace inputs required to render a project cleanly without Tauri handles.
#[derive(Debug, Clone)]
pub struct ProjectRenderInput {
    pub data_dir: PathBuf,
    pub project_dir: PathBuf,
    pub story: StoryData,
    pub assets: ProjectAssets,
    pub model_registry: ModelRegistry,
    pub font: PlaybackFontConfig,
}

impl ProjectRenderInput {
    pub fn load_from_dirs(
        data_dir: PathBuf,
        project_dir: PathBuf,
        story_override: Option<StoryData>,
        font: PlaybackFontConfig,
    ) -> Result<Self, RendererError> {
        let story: StoryData = match story_override {
            Some(story) => story,
            None => read_json_or_default(
                &project_dir.join("story.json"),
                Some(&project_dir.join("story.json.bak")),
                StoryData {
                    version: 1,
                    snippets: Vec::new(),
                },
                "story.json",
            )?,
        };
        if story.version != 1 {
            return Err(RendererError::InvalidConfig(format!(
                "Unsupported story schema version: {}",
                story.version
            )));
        }

        let assets: ProjectAssets = read_json_or_default(
            &project_dir.join("assets.json"),
            None,
            ProjectAssets::default(),
            "assets.json",
        )?;

        let model_registry = load_model_registry(&data_dir)?;

        Ok(Self {
            data_dir,
            project_dir,
            story,
            assets,
            model_registry,
            font,
        })
    }

    /// Resolves a path strictly inside `data_dir` or `project_dir` (matching `src-tauri/src/protocol.rs` / `paths.rs`).
    pub fn resolve_data_rel_path(&self, rel: &str) -> Result<PathBuf, RendererError> {
        resolve_safe_relative(&self.data_dir, rel)
    }

    pub fn resolve_project_rel_path(&self, rel: &str) -> Result<PathBuf, RendererError> {
        resolve_safe_relative(&self.project_dir, rel)
    }

    pub fn resolve_model_asset(&self, model_key: &str) -> Result<(&ModelAsset, PathBuf), RendererError> {
        let asset = self
            .assets
            .models
            .get(model_key)
            .ok_or_else(|| RendererError::MissingAsset(format!("model '{model_key}'")))?;
        let reg = self.model_registry.models.get(&asset.model_id).ok_or_else(|| {
            RendererError::MissingAsset(format!(
                "model registry entry '{}' for model '{model_key}'",
                asset.model_id
            ))
        })?;
        let rel = format!("models/{}/{}", asset.model_id, reg.entry);
        let entry_path = self.resolve_data_rel_path(&rel)?;
        if !entry_path.is_file() {
            return Err(RendererError::MissingAsset(format!(
                "model entry file {}",
                entry_path.display()
            )));
        }
        Ok((asset, entry_path))
    }

    pub fn resolve_background_path(&self, bg_key: &str) -> Result<PathBuf, RendererError> {
        let asset = self
            .assets
            .backgrounds
            .get(bg_key)
            .ok_or_else(|| RendererError::MissingAsset(format!("background '{bg_key}'")))?;
        let path = resolve_asset_file(&self.project_dir, &self.data_dir, &asset.path)?;
        if !path.is_file() {
            return Err(RendererError::MissingAsset(format!(
                "background image {}",
                path.display()
            )));
        }
        Ok(path)
    }

    pub fn resolve_voice_path(&self, voice_key: &str) -> Result<PathBuf, RendererError> {
        let asset = self
            .assets
            .voices
            .get(voice_key)
            .ok_or_else(|| RendererError::MissingAsset(format!("voice '{voice_key}'")))?;
        let path = resolve_asset_file(&self.project_dir, &self.data_dir, &asset.path)?;
        if !path.is_file() {
            return Err(RendererError::MissingAsset(format!(
                "voice audio {}",
                path.display()
            )));
        }
        Ok(path)
    }
}

fn read_json_or_default<T: for<'de> Deserialize<'de>>(
    primary: &Path,
    backup: Option<&Path>,
    default_value: T,
    context: &str,
) -> Result<T, RendererError> {
    if primary.exists() {
        let raw = fs::read_to_string(primary)?;
        match serde_json::from_str(&raw) {
            Ok(val) => return Ok(val),
            Err(err) => {
                if let Some(bak) = backup.filter(|p| p.exists()) {
                    let bak_raw = fs::read_to_string(bak)?;
                    return serde_json::from_str(&bak_raw).map_err(|bak_err| RendererError::Json {
                        context: format!("{context} (primary failed: {err}; backup failed)"),
                        source: bak_err,
                    });
                }
                return Err(RendererError::Json {
                    context: context.to_string(),
                    source: err,
                });
            }
        }
    }
    if let Some(bak) = backup.filter(|p| p.exists()) {
        let bak_raw = fs::read_to_string(bak)?;
        return serde_json::from_str(&bak_raw).map_err(|source| RendererError::Json {
            context: format!("{context}.bak"),
            source,
        });
    }
    Ok(default_value)
}

fn is_model_entry_file_name(file_name: &str) -> bool {
    let normalized = file_name.to_ascii_lowercase();
    normalized.ends_with(".model3.json")
        || normalized == "model.json"
        || normalized.ends_with(".model.json")
}

fn scan_model_entry_file(model_dir: &Path) -> Result<Option<String>, RendererError> {
    let mut candidates: Vec<String> = fs::read_dir(model_dir)?
        .filter_map(|entry| entry.ok())
        .filter(|entry| {
            entry
                .file_type()
                .map(|file_type| file_type.is_file())
                .unwrap_or(false)
        })
        .filter_map(|entry| {
            let file_name = entry.file_name().to_string_lossy().to_string();
            is_model_entry_file_name(&file_name).then_some(file_name)
        })
        .collect();
    candidates.sort();
    Ok(candidates.into_iter().next())
}

fn load_model_registry(data_dir: &Path) -> Result<ModelRegistry, RendererError> {
    let models_dir = data_dir.join("models");
    let index_path = models_dir.join("index.json");
    let legacy_path = data_dir.join("model_registry.json");

    let mut registry: ModelRegistry = if index_path.exists() {
        read_json_or_default(
            &index_path,
            None,
            ModelRegistry {
                version: 1,
                models: HashMap::new(),
            },
            "models/index.json",
        )?
    } else if legacy_path.exists() {
        read_json_or_default(
            &legacy_path,
            None,
            ModelRegistry {
                version: 1,
                models: HashMap::new(),
            },
            "model_registry.json",
        )?
    } else {
        ModelRegistry {
            version: 1,
            models: HashMap::new(),
        }
    };

    if models_dir.is_dir() {
        for entry in fs::read_dir(&models_dir)?.filter_map(|item| item.ok()) {
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if !file_type.is_dir() {
                continue;
            }
            let model_id = entry.file_name().to_string_lossy().to_string();
            let has_valid_entry = registry
                .models
                .get(&model_id)
                .map(|item| entry.path().join(&item.entry).is_file())
                .unwrap_or(false);
            if has_valid_entry {
                continue;
            }
            if let Some(entry_file) = scan_model_entry_file(&entry.path())? {
                registry.models.insert(
                    model_id,
                    ModelRegistryEntry {
                        name: None,
                        entry: entry_file,
                        motions: Vec::new(),
                        facials: Vec::new(),
                    },
                );
            }
        }
    }

    Ok(registry)
}

pub fn resolve_safe_relative(base: &Path, rel: &str) -> Result<PathBuf, RendererError> {
    let trimmed = rel.trim();
    if trimmed.is_empty() {
        return Err(RendererError::InvalidAssetPath(
            "Asset path cannot be empty".into(),
        ));
    }
    let path = Path::new(trimmed);
    if path.is_absolute() {
        return Err(RendererError::InvalidAssetPath(format!(
            "Absolute asset path is not allowed: {trimmed}"
        )));
    }
    let mut clean = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => clean.push(part),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(RendererError::InvalidAssetPath(format!(
                    "Path escapes workspace root: {trimmed}"
                )));
            }
        }
    }
    Ok(base.join(clean))
}

fn resolve_asset_file(
    project_dir: &Path,
    data_dir: &Path,
    rel: &str,
) -> Result<PathBuf, RendererError> {
    let in_project = resolve_safe_relative(project_dir, rel)?;
    if in_project.is_file() {
        return Ok(in_project);
    }
    let in_data = resolve_safe_relative(data_dir, rel)?;
    if in_data.is_file() {
        return Ok(in_data);
    }
    Ok(in_project)
}

/// Parses `#RRGGBB` or `#RRGGBBAA` hex colors into normalized `[r, g, b, a]` floats (`0.0..=1.0`).
pub fn parse_hex_color(hex: &str) -> Result<[f32; 4], RendererError> {
    let stripped = hex.trim().strip_prefix('#').unwrap_or(hex.trim());
    let parse_byte = |s: &str| -> Result<f32, RendererError> {
        u8::from_str_radix(s, 16)
            .map(|b| b as f32 / 255.0)
            .map_err(|_| RendererError::InvalidConfig(format!("Invalid hex color: {hex}")))
    };
    match stripped.len() {
        6 => Ok([
            parse_byte(&stripped[0..2])?,
            parse_byte(&stripped[2..4])?,
            parse_byte(&stripped[4..6])?,
            1.0,
        ]),
        8 => Ok([
            parse_byte(&stripped[0..2])?,
            parse_byte(&stripped[2..4])?,
            parse_byte(&stripped[4..6])?,
            parse_byte(&stripped[6..8])?,
        ]),
        _ => Err(RendererError::InvalidConfig(format!(
            "Invalid hex color length: {hex}"
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_hex_color_works_with_and_without_alpha() {
        assert_eq!(parse_hex_color("#000000").unwrap(), [0.0, 0.0, 0.0, 1.0]);
        let rgba = parse_hex_color("#4A49688D").unwrap();
        assert!((rgba[0] - 0x4a as f32 / 255.0).abs() < 1e-6);
        assert!((rgba[3] - 0x8d as f32 / 255.0).abs() < 1e-6);
        assert!(parse_hex_color("#123").is_err());
    }

    #[test]
    fn story_deserializes_all_builtin_snippets_and_defaults() {
        let json = r##"{
          "version": 1,
          "snippets": [
            { "type": "ChangeLayoutMode", "data": { "mode": "Three" } },
            { "type": "ChangeBackgroundImage", "data": { "background": "bg1" } },
            { "type": "LayoutAppear", "delay": 0.1, "data": { "model": "ichika", "position": { "side": "Left" } } },
            { "type": "Talk", "data": { "speaker": "一歌", "content": "你好", "model": "ichika", "voice": "v1" } },
            { "type": "Parallel", "snippets": [
              { "type": "Move", "data": { "model": "ichika", "from": { "side": "Left" }, "to": { "side": "Center", "offset": 20 }, "moveSpeed": "Fast" } },
              { "type": "Motion", "data": { "model": "ichika", "motion": "m1", "facial": "f1" } },
              { "type": "DoParam", "data": { "model": "ichika", "params": [{ "paramId": "ParamAngleX", "start": 0, "end": 15, "curve": "Sine", "duration": 0.5 }] } },
              { "type": "ApplyEffect", "data": { "effectId": "e1", "target": { "type": "Screen" }, "effect": { "type": "Blur" } } }
            ]},
            { "type": "Telop", "data": { "content": "Chapter 1" } },
            { "type": "HideTalk" },
            { "type": "RemoveEffect", "data": { "effectId": "e1" } },
            { "type": "ScreenFadeOut", "data": { "color": "#000000", "duration": 0.5 } },
            { "type": "ScreenFadeIn", "data": { "duration": 0.4 } },
            { "type": "LayoutClear", "data": { "model": "ichika" } }
          ]
        }"##;
        let story: StoryData = serde_json::from_str(json).expect("story parse");
        assert_eq!(story.version, 1);
        assert_eq!(story.snippets.len(), 11);
        if let SnippetData::ApplyEffect { data, .. } = match &story.snippets[4] {
            SnippetData::Parallel { snippets, .. } => &snippets[3],
            _ => unreachable!(),
        } {
            assert_eq!(data.duration, 0.3);
            assert_eq!(
                data.effect,
                VisualEffectData::Blur {
                    strength: 8.0,
                    quality: 2,
                    kernel_size: 5
                }
            );
        } else {
            panic!("expected ApplyEffect");
        }
    }

    #[test]
    fn load_model_registry_reads_models_index_and_scans_missing_dirs() {
        let unique_id = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system clock")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "mss_renderer_registry_test_{}_{}",
            std::process::id(),
            unique_id
        ));
        let models_dir = root.join("models");
        let indexed_dir = models_dir.join("01ichika");
        let scanned_dir = models_dir.join("21miku");
        fs::create_dir_all(&indexed_dir).expect("create indexed model dir");
        fs::create_dir_all(&scanned_dir).expect("create scanned model dir");

        fs::write(indexed_dir.join("01ichika.model3.json"), "{}").expect("write indexed model");
        fs::write(scanned_dir.join("21miku.model3.json"), "{}").expect("write scanned model");
        fs::write(
            models_dir.join("index.json"),
            r#"{
              "version": 1,
              "models": {
                "01ichika": {
                  "name": "Ichika",
                  "entry": "01ichika.model3.json",
                  "motions": ["w-cute-happy01"],
                  "facials": ["face_smile_01"]
                }
              }
            }"#,
        )
        .expect("write models/index.json");

        let registry = load_model_registry(&root).expect("load model registry");
        let _ = fs::remove_dir_all(&root);

        assert_eq!(registry.models.len(), 2);
        let ichika = registry.models.get("01ichika").expect("indexed model");
        assert_eq!(ichika.entry, "01ichika.model3.json");
        assert_eq!(ichika.motions, vec!["w-cute-happy01".to_string()]);
        assert_eq!(ichika.facials, vec!["face_smile_01".to_string()]);

        let miku = registry
            .models
            .get("21miku")
            .expect("scanned fallback model");
        assert_eq!(miku.entry, "21miku.model3.json");
    }
}
