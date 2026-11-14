use image::{ImageReader, RgbaImage};
use resvg::tiny_skia::{Pixmap, Transform};
use resvg::usvg::{self, Tree};
use std::io::Cursor;
use std::path::Path;

use super::error::RendererError;

pub const UI_TEXT_BACKGROUND_SVG: &[u8] =
    include_bytes!("../../../src/story/assets/ui/ui_text_background.svg");
pub const UI_TEXT_UNDERLINE_SVG: &[u8] =
    include_bytes!("../../../src/story/assets/ui/ui_text_underline.svg");
pub const UI_TELOP_SVG: &[u8] = include_bytes!("../../../src/story/assets/ui/ui_telop.svg");
pub const VFX_HOLOGRAM_SVG: &[u8] =
    include_bytes!("../../../src/story/vfx/builtin/assets/vfx_hologram.svg");

/// Decoded RGBA8 buffer ready for GPU upload.
/// When `premultiplied` is `true`, RGB channels are already multiplied by alpha.
#[derive(Debug, Clone)]
pub struct PremulImage {
    pub width: u32,
    pub height: u32,
    pub data: Vec<u8>,
}

impl PremulImage {
    pub fn from_straight_rgba(width: u32, height: u32, mut rgba: Vec<u8>) -> Self {
        for px in rgba.chunks_exact_mut(4) {
            let a = px[3] as u16;
            px[0] = ((px[0] as u16 * a + 127) / 255) as u8;
            px[1] = ((px[1] as u16 * a + 127) / 255) as u8;
            px[2] = ((px[2] as u16 * a + 127) / 255) as u8;
        }
        Self {
            width,
            height,
            data: rgba,
        }
    }

    pub fn from_tiny_skia(pixmap: Pixmap) -> Self {
        let width = pixmap.width();
        let height = pixmap.height();
        Self {
            width,
            height,
            data: pixmap.take(),
        }
    }
}

/// Rasterizes raw SVG bytes at a specific target pixel size `(width, height)`,
/// producing a premultiplied RGBA8 image matching `tiny-skia`'s internal premul buffer.
pub fn rasterize_svg_to_size(
    svg_bytes: &[u8],
    target_width: u32,
    target_height: u32,
    context: &str,
) -> Result<PremulImage, RendererError> {
    let opt = usvg::Options::default();
    let tree = Tree::from_data(svg_bytes, &opt).map_err(|err| {
        RendererError::ImageDecode(format!("Failed to parse SVG '{context}': {err}"))
    })?;
    let w = target_width.max(1);
    let h = target_height.max(1);
    let src_size = tree.size();
    let sx = w as f32 / src_size.width().max(1.0);
    let sy = h as f32 / src_size.height().max(1.0);
    let mut pixmap = Pixmap::new(w, h).ok_or_else(|| {
        RendererError::ImageDecode(format!("Failed to allocate {w}x{h} pixmap for '{context}'"))
    })?;
    resvg::render(&tree, Transform::from_scale(sx, sy), &mut pixmap.as_mut());
    Ok(PremulImage::from_tiny_skia(pixmap))
}

/// Rasterizes raw SVG bytes at their intrinsic viewBox dimensions.
pub fn rasterize_svg_intrinsic(
    svg_bytes: &[u8],
    context: &str,
) -> Result<PremulImage, RendererError> {
    let opt = usvg::Options::default();
    let tree = Tree::from_data(svg_bytes, &opt).map_err(|err| {
        RendererError::ImageDecode(format!("Failed to parse SVG '{context}': {err}"))
    })?;
    let size = tree.size();
    let w = size.width().ceil().max(1.0) as u32;
    let h = size.height().ceil().max(1.0) as u32;
    let mut pixmap = Pixmap::new(w, h).ok_or_else(|| {
        RendererError::ImageDecode(format!("Failed to allocate {w}x{h} pixmap for '{context}'"))
    })?;
    resvg::render(&tree, Transform::identity(), &mut pixmap.as_mut());
    Ok(PremulImage::from_tiny_skia(pixmap))
}

/// Loads any project background file (`.svg` / `.svgz` / PNG / JPG / WebP / BMP) into premultiplied RGBA8.
pub fn load_image_premul(path: &Path) -> Result<PremulImage, RendererError> {
    let bytes = std::fs::read(path).map_err(|err| {
        RendererError::ImageDecode(format!("Failed to read image '{}': {err}", path.display()))
    })?;
    let is_svg = path
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| {
            let low = s.to_ascii_lowercase();
            low == "svg" || low == "svgz"
        })
        .unwrap_or(false)
        || bytes.lstrip_ascii_svg();

    if is_svg {
        return rasterize_svg_intrinsic(&bytes, &path.display().to_string());
    }

    let reader = ImageReader::new(Cursor::new(&bytes))
        .with_guessed_format()
        .map_err(|err| {
            RendererError::ImageDecode(format!(
                "Failed to probe image format '{}': {err}",
                path.display()
            ))
        })?;
    let img = reader.decode().map_err(|err| {
        RendererError::ImageDecode(format!("Failed to decode image '{}': {err}", path.display()))
    })?;
    let rgba: RgbaImage = img.to_rgba8();
    let (w, h) = rgba.dimensions();
    Ok(PremulImage::from_straight_rgba(w, h, rgba.into_raw()))
}

trait CheckSvgBytes {
    fn lstrip_ascii_svg(&self) -> bool;
}

impl CheckSvgBytes for [u8] {
    fn lstrip_ascii_svg(&self) -> bool {
        let trimmed = self
            .iter()
            .copied()
            .skip_while(|b| b.is_ascii_whitespace())
            .take(64)
            .collect::<Vec<u8>>();
        let s = String::from_utf8_lossy(&trimmed);
        s.starts_with("<svg") || s.starts_with("<?xml")
    }
}

/// Embedded UI & builtin VFX rasterized textures tailored to a given target resolution `(stage_w, stage_h)`.
#[derive(Debug, Clone)]
pub struct BuiltinUiBitmaps {
    pub text_background: PremulImage,
    pub text_underline: PremulImage,
    pub telop: PremulImage,
    pub hologram: PremulImage,
}

impl BuiltinUiBitmaps {
    pub fn render_for_stage(stage_w: u32, stage_h: u32) -> Result<Self, RendererError> {
        let underline_w = ((stage_w as f32) * 0.5).round().max(1.0) as u32;
        let underline_h = ((underline_w as f32) * 11.0 / 1000.0).round().max(1.0) as u32;
        let telop_w = ((960.0 * stage_w as f32) / 1920.0).round().max(1.0) as u32;
        let telop_h = ((stage_h as f32) / 8.0).round().max(1.0) as u32;

        Ok(Self {
            text_background: rasterize_svg_to_size(
                UI_TEXT_BACKGROUND_SVG,
                stage_w,
                stage_h,
                "ui_text_background.svg",
            )?,
            text_underline: rasterize_svg_to_size(
                UI_TEXT_UNDERLINE_SVG,
                underline_w,
                underline_h,
                "ui_text_underline.svg",
            )?,
            telop: rasterize_svg_to_size(UI_TELOP_SVG, telop_w, telop_h, "ui_telop.svg")?,
            hologram: rasterize_svg_intrinsic(VFX_HOLOGRAM_SVG, "vfx_hologram.svg")?,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_svgs_rasterize_cleanly_at_1080p() {
        let bitmaps = BuiltinUiBitmaps::render_for_stage(1920, 1080).expect("svg rasterize");
        assert_eq!(bitmaps.text_background.width, 1920);
        assert_eq!(bitmaps.text_background.height, 1080);
        assert_eq!(bitmaps.telop.width, 960);
        assert_eq!(bitmaps.telop.height, 135);
        assert_eq!(bitmaps.hologram.width, 1920);
        assert_eq!(bitmaps.hologram.height, 1080);
        assert!(bitmaps.text_underline.data.iter().skip(3).step_by(4).any(|&a| a > 0));
        assert!(bitmaps.telop.data.iter().skip(3).step_by(4).any(|&a| a > 0));
        assert!(bitmaps.hologram.data.iter().skip(3).step_by(4).any(|&a| a > 0));
    }
}
