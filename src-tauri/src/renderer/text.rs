use cosmic_text::{
    fontdb, Align, Attrs, Buffer, Family, Metrics, Shaping, SwashCache, Wrap,
};
use std::path::Path;
use tiny_skia::{
    BlendMode, Color as SkiaColor, FillRule, LineCap, LineJoin, Paint, PathBuilder, Pixmap,
    Stroke, Transform,
};

use super::error::RendererError;
use super::story::PlaybackFontConfig;
use super::svg_assets::PremulImage;

pub const DEFAULT_PLAYBACK_FONT_BYTES: &[u8] =
    include_bytes!("../../../src/story/assets/fonts/SourceHanSansSC.otf");
pub const DEFAULT_PLAYBACK_FONT_FAMILY: &str = "Source Han Sans SC";

/// Rendered text surface with origin offset (accounting for stroke padding around `(0, 0)`).
#[derive(Debug, Clone)]
pub struct RenderedTextSurface {
    pub image: PremulImage,
    /// Horizontal pixel offset from logical text top-left (or center for Telop) to sprite top-left.
    pub offset_x: f32,
    /// Vertical pixel offset from logical text top-left (or center for Telop) to sprite top-left.
    pub offset_y: f32,
}

#[derive(Debug, Clone, Copy)]
pub struct TextStyleSpec {
    pub font_size: f32,
    pub line_height: f32,
    pub fill_rgba: [u8; 4],
    pub stroke_rgba: Option<[u8; 4]>,
    pub stroke_width: f32,
    pub word_wrap_width: Option<f32>,
    pub align: Align,
    pub anchor_center: bool,
}

pub struct StoryTextRenderer {
    font_system: cosmic_text::FontSystem,
    swash_cache: SwashCache,
    primary_family: String,
}

impl StoryTextRenderer {
    /// Initializes deterministic typography using `PlaybackFontConfig` (`dataPath` font or embedded `SourceHanSansSC.otf`).
    pub fn new(font: &PlaybackFontConfig, data_dir: Option<&Path>) -> Result<Self, RendererError> {
        let mut db = fontdb::Database::new();
        let mut primary_family = DEFAULT_PLAYBACK_FONT_FAMILY.to_string();

        match font {
            PlaybackFontConfig::Default => {}
            PlaybackFontConfig::Data { family, path } => {
                let trimmed_family = family.trim();
                let trimmed_path = path.trim();
                if !trimmed_family.is_empty() && !trimmed_path.is_empty() {
                    if let Some(base) = data_dir {
                        let resolved = resolve_font_path(base, trimmed_path)?;
                        let bytes = std::fs::read(&resolved).map_err(|err| {
                            RendererError::FontLoad(format!(
                                "Failed to read custom font '{}': {err}",
                                resolved.display()
                            ))
                        })?;
                        let before = db.len();
                        db.load_font_data(bytes);
                        if db.len() == before {
                            return Err(RendererError::FontLoad(format!(
                                "Custom font '{}' contains no valid font faces",
                                resolved.display()
                            )));
                        }
                        if let Some(parsed) = db
                            .faces()
                            .find(|face| face.families.iter().any(|(f, _)| f == trimmed_family))
                            .and_then(|f| f.families.first())
                        {
                            primary_family = parsed.0.clone();
                        } else if let Some(first_parsed) =
                            db.faces().next().and_then(|f| f.families.first())
                        {
                            primary_family = first_parsed.0.clone();
                        }
                    }
                }
            }
            PlaybackFontConfig::System { family } => {
                db.load_system_fonts();
                let trimmed_family = family.trim();
                if !trimmed_family.is_empty() {
                    primary_family = trimmed_family.to_string();
                }
            }
        }

        // Always load embedded `SourceHanSansSC.otf` as primary (default) or fallback CJK font.
        let before_default = db.len();
        db.load_font_data(DEFAULT_PLAYBACK_FONT_BYTES.to_vec());
        if db.len() > before_default && primary_family == DEFAULT_PLAYBACK_FONT_FAMILY {
            if let Some(face) = db.faces().last() {
                if let Some((fam, _)) = face.families.first() {
                    if !face.families.iter().any(|(f, _)| f == DEFAULT_PLAYBACK_FONT_FAMILY) {
                        primary_family = fam.clone();
                    }
                }
            }
        }

        let font_system =
            cosmic_text::FontSystem::new_with_locale_and_db("zh-CN".to_string(), db);

        Ok(Self {
            font_system,
            swash_cache: SwashCache::new(),
            primary_family,
        })
    }

    pub fn dialogue_body_style(stage_w: u32, stage_h: u32) -> TextStyleSpec {
        let w = stage_w as f32;
        let h = stage_h as f32;
        TextStyleSpec {
            font_size: h / 26.0,
            line_height: h / 19.0,
            fill_rgba: [0xFF, 0xFF, 0xFF, 0xDC],
            stroke_rgba: Some([0x4A, 0x49, 0x68, 0x8D]),
            stroke_width: h / 120.0,
            word_wrap_width: Some((w - 2.0 * (w / 8.0)).max(1.0)),
            align: Align::Left,
            anchor_center: false,
        }
    }

    pub fn speaker_style(stage_h: u32) -> TextStyleSpec {
        let h = stage_h as f32;
        let font_size = h / 25.0;
        TextStyleSpec {
            font_size,
            line_height: font_size * 1.25,
            fill_rgba: [0xFF, 0xFF, 0xFF, 0xF5],
            stroke_rgba: Some([0x4A, 0x49, 0x68, 0x8D]),
            stroke_width: h / 120.0,
            word_wrap_width: None,
            align: Align::Left,
            anchor_center: false,
        }
    }

    pub fn telop_style(stage_h: u32) -> TextStyleSpec {
        let h = stage_h as f32;
        let font_size = h / 23.0;
        TextStyleSpec {
            font_size,
            line_height: font_size * 1.25,
            fill_rgba: [0xFF, 0xFF, 0xFF, 0xFF],
            stroke_rgba: None,
            stroke_width: 0.0,
            word_wrap_width: None,
            align: Align::Center,
            anchor_center: true,
        }
    }

    /// Renders `text` with Pixi-equivalent round-joined stroke-before-fill onto a tight premultiplied RGBA surface.
    pub fn render_text(
        &mut self,
        text: &str,
        style: TextStyleSpec,
    ) -> Result<Option<RenderedTextSurface>, RendererError> {
        if text.is_empty() {
            return Ok(None);
        }

        let metrics = Metrics::new(style.font_size.max(1.0), style.line_height.max(1.0));
        let mut buffer = Buffer::new(&mut self.font_system, metrics);
        buffer.set_wrap(if style.word_wrap_width.is_some() {
            Wrap::WordOrGlyph
        } else {
            Wrap::None
        });
        buffer.set_size(style.word_wrap_width, None);

        let attrs = Attrs::new().family(Family::Name(&self.primary_family));
        buffer.set_text(text, &attrs, Shaping::Advanced, Some(style.align));
        buffer.shape_until_scroll(&mut self.font_system, false);

        let mut max_w: f32 = 1.0;
        let mut max_h: f32 = style.line_height.max(1.0);
        let mut pb = PathBuilder::new();
        let mut raster_fallbacks: Vec<(i32, i32, cosmic_text::SwashImage)> = Vec::new();
        let mut line_count: usize = 0;

        for run in buffer.layout_runs() {
            line_count = line_count.max(run.line_i + 1);
            max_w = max_w.max(run.line_w);
            max_h = max_h.max(run.line_top + run.line_height);
            for glyph in run.glyphs {
                let physical = glyph.physical((0.0, run.line_y), 1.0);
                let gx = physical.x as f32;
                let gy = physical.y as f32;
                if let Some(cmds) = self
                    .swash_cache
                    .get_outline_commands(&mut self.font_system, physical.cache_key)
                {
                    for cmd in cmds {
                        match *cmd {
                            cosmic_text::Command::MoveTo(p) => pb.move_to(gx + p.x, gy - p.y),
                            cosmic_text::Command::LineTo(p) => pb.line_to(gx + p.x, gy - p.y),
                            cosmic_text::Command::QuadTo(c, p) => {
                                pb.quad_to(gx + c.x, gy - c.y, gx + p.x, gy - p.y);
                            }
                            cosmic_text::Command::CurveTo(c1, c2, p) => {
                                pb.cubic_to(
                                    gx + c1.x,
                                    gy - c1.y,
                                    gx + c2.x,
                                    gy - c2.y,
                                    gx + p.x,
                                    gy - p.y,
                                );
                            }
                            cosmic_text::Command::Close => pb.close(),
                        }
                    }
                } else if let Some(img) = self
                    .swash_cache
                    .get_image(&mut self.font_system, physical.cache_key)
                {
                    if img.placement.width > 0 && img.placement.height > 0 {
                        raster_fallbacks.push((physical.x, physical.y, img.clone()));
                    }
                }
            }
        }

        let layout_w = style.word_wrap_width.unwrap_or(max_w).max(max_w).max(1.0);
        let layout_h = (line_count.max(1) as f32 * style.line_height).max(max_h).max(1.0);
        let pad = if style.stroke_rgba.is_some() {
            (style.stroke_width * 0.5).ceil() + 3.0
        } else {
            3.0
        };

        let bounds = pb.finish();
        let pixmap_w = (layout_w + pad * 2.0).ceil().max(1.0) as u32;
        let pixmap_h = (layout_h + pad * 2.0).ceil().max(1.0) as u32;
        let mut pixmap = Pixmap::new(pixmap_w, pixmap_h).ok_or_else(|| {
            RendererError::FontLoad(format!("Failed to allocate text pixmap {pixmap_w}x{pixmap_h}"))
        })?;

        let tx = Transform::from_translate(pad, pad);

        if let Some(path) = bounds {
            if let Some(stroke_rgba) = style.stroke_rgba {
                if style.stroke_width > 0.0 && stroke_rgba[3] > 0 {
                    let mut stroke_paint = Paint::default();
                    stroke_paint.set_color(SkiaColor::from_rgba8(
                        stroke_rgba[0],
                        stroke_rgba[1],
                        stroke_rgba[2],
                        stroke_rgba[3],
                    ));
                    stroke_paint.anti_alias = true;
                    stroke_paint.blend_mode = BlendMode::SourceOver;
                    let stroke = Stroke {
                        width: style.stroke_width,
                        line_join: LineJoin::Round,
                        line_cap: LineCap::Round,
                        ..Default::default()
                    };
                    pixmap.stroke_path(&path, &stroke_paint, &stroke, tx, None);
                }
            }

            let mut fill_paint = Paint::default();
            fill_paint.set_color(SkiaColor::from_rgba8(
                style.fill_rgba[0],
                style.fill_rgba[1],
                style.fill_rgba[2],
                style.fill_rgba[3],
            ));
            fill_paint.anti_alias = true;
            fill_paint.blend_mode = BlendMode::SourceOver;
            pixmap.fill_path(&path, &fill_paint, FillRule::Winding, tx, None);
        }

        // Fallback bitmap glyph blitting (e.g. color emoji / bitmap strikes).
        for (px_x, px_y, img) in raster_fallbacks {
            blit_swash_fallback(
                &mut pixmap,
                px_x + pad as i32,
                px_y + pad as i32,
                &img,
                style.fill_rgba,
            );
        }

        let (offset_x, offset_y) = if style.anchor_center {
            (-((pixmap_w as f32) * 0.5), -((pixmap_h as f32) * 0.5))
        } else {
            (-pad, -pad)
        };

        Ok(Some(RenderedTextSurface {
            image: PremulImage::from_tiny_skia(pixmap),
            offset_x,
            offset_y,
        }))
    }
}

fn blit_swash_fallback(
    pixmap: &mut Pixmap,
    gx: i32,
    gy: i32,
    img: &cosmic_text::SwashImage,
    fill: [u8; 4],
) {
    let pw = pixmap.width() as i32;
    let ph = pixmap.height() as i32;
    let x0 = gx + img.placement.left;
    let y0 = gy - img.placement.top;
    let w = img.placement.width as i32;
    let h = img.placement.height as i32;
    let buf = pixmap.data_mut();

    match img.content {
        cosmic_text::SwashContent::Mask | cosmic_text::SwashContent::SubpixelMask => {
            let stride = img.data.len() / (h.max(1) as usize * w.max(1) as usize);
            let ch_step = stride.max(1);
            for yy in 0..h {
                for xx in 0..w {
                    let dx = x0 + xx;
                    let dy = y0 + yy;
                    if dx < 0 || dy < 0 || dx >= pw || dy >= ph {
                        continue;
                    }
                    let idx = ((yy * w + xx) as usize) * ch_step;
                    let cov = *img.data.get(idx).unwrap_or(&0) as f32 / 255.0;
                    if cov <= 0.0 {
                        continue;
                    }
                    let a = (fill[3] as f32 / 255.0) * cov;
                    let dst_i = ((dy * pw + dx) * 4) as usize;
                    blend_premul_over(
                        &mut buf[dst_i..dst_i + 4],
                        fill[0] as f32 / 255.0 * a,
                        fill[1] as f32 / 255.0 * a,
                        fill[2] as f32 / 255.0 * a,
                        a,
                    );
                }
            }
        }
        cosmic_text::SwashContent::Color => {
            for yy in 0..h {
                for xx in 0..w {
                    let dx = x0 + xx;
                    let dy = y0 + yy;
                    if dx < 0 || dy < 0 || dx >= pw || dy >= ph {
                        continue;
                    }
                    let idx = ((yy * w + xx) * 4) as usize;
                    if idx + 3 >= img.data.len() {
                        continue;
                    }
                    let sa = img.data[idx + 3] as f32 / 255.0 * (fill[3] as f32 / 255.0);
                    let dst_i = ((dy * pw + dx) * 4) as usize;
                    blend_premul_over(
                        &mut buf[dst_i..dst_i + 4],
                        img.data[idx] as f32 / 255.0 * sa,
                        img.data[idx + 1] as f32 / 255.0 * sa,
                        img.data[idx + 2] as f32 / 255.0 * sa,
                        sa,
                    );
                }
            }
        }
    }
}

fn blend_premul_over(dst: &mut [u8], sr: f32, sg: f32, sb: f32, sa: f32) {
    let inv = 1.0 - sa;
    let dr = (sr + (dst[0] as f32 / 255.0) * inv).clamp(0.0, 1.0);
    let dg = (sg + (dst[1] as f32 / 255.0) * inv).clamp(0.0, 1.0);
    let db = (sb + (dst[2] as f32 / 255.0) * inv).clamp(0.0, 1.0);
    let da = (sa + (dst[3] as f32 / 255.0) * inv).clamp(0.0, 1.0);
    dst[0] = (dr * 255.0).round() as u8;
    dst[1] = (dg * 255.0).round() as u8;
    dst[2] = (db * 255.0).round() as u8;
    dst[3] = (da * 255.0).round() as u8;
}

fn resolve_font_path(data_dir: &Path, rel: &str) -> Result<std::path::PathBuf, RendererError> {
    let mut cur = data_dir.to_path_buf();
    for comp in Path::new(rel).components() {
        match comp {
            std::path::Component::Normal(p) => cur.push(p),
            std::path::Component::CurDir => {}
            _ => {
                return Err(RendererError::InvalidAssetPath(format!(
                    "Invalid font relative path: '{rel}'"
                )))
            }
        }
    }
    Ok(cur)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_source_han_sans_renders_cjk_and_ascii_with_stroke() {
        let mut renderer = StoryTextRenderer::new(&PlaybackFontConfig::Default, None)
            .expect("load embedded font");
        let body = renderer
            .render_text(
                "一歌：Hello, 世界！Testing line wrapping for long dialogue content.",
                StoryTextRenderer::dialogue_body_style(1920, 1080),
            )
            .expect("render body")
            .expect("non-empty body");
        assert!(body.image.width > 100);
        assert!(body.image.height > 40);
        assert!(body.image.data.iter().skip(3).step_by(4).any(|&a| a > 200));

        // Verify glyph orientation: exclamation '!' should have tall stem at top and small gap/dot near bottom,
        // and 'T' should have crossbar in the top half of its inked bounding box.
        let t_img = renderer
            .render_text("T", StoryTextRenderer::telop_style(1080))
            .expect("render T")
            .expect("non-empty T");
        let mut min_y = u32::MAX;
        let mut max_y = 0u32;
        let mut top_ink = 0usize;
        let mut bot_ink = 0usize;
        for y in 0..t_img.image.height {
            let mut row_ink = 0usize;
            for x in 0..t_img.image.width {
                let a = t_img.image.data[((y * t_img.image.width + x) * 4 + 3) as usize];
                if a > 32 {
                    min_y = min_y.min(y);
                    max_y = max_y.max(y);
                    row_ink += 1;
                }
            }
            if y < t_img.image.height / 2 {
                top_ink += row_ink;
            } else {
                bot_ink += row_ink;
            }
        }
        assert!(min_y < max_y);
        assert!(
            top_ink > bot_ink,
            "Glyph 'T' should have wider crossbar in upper half ({top_ink} vs {bot_ink})"
        );
    }
}
