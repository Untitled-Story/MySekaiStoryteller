// ============================================================================
// 1. Generic Textured / Colored Quad Pipeline (Stage / UI / VFX / Fade)
// ============================================================================

struct QuadVertexIn {
    @location(0) pos: vec2<f32>,
    @location(1) uv: vec2<f32>,
    @location(2) color: vec4<f32>,
};

struct QuadVertexOut {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
    @location(1) color: vec4<f32>,
};

@group(0) @binding(0) var quad_tex: texture_2d<f32>;
@group(0) @binding(1) var quad_samp: sampler;

@vertex
fn quad_vs(in: QuadVertexIn) -> QuadVertexOut {
    var out: QuadVertexOut;
    out.position = vec4<f32>(in.pos, 0.0, 1.0);
    out.uv = in.uv;
    out.color = in.color;
    return out;
}

@fragment
fn quad_fs(in: QuadVertexOut) -> @location(0) vec4<f32> {
    return textureSample(quad_tex, quad_samp, in.uv) * in.color;
}

// ============================================================================
// 2. Live2D Cubism Mask Setup Pipeline
// ============================================================================

struct Live2dMaskUniforms {
    clip_matrix: mat4x4<f32>,
    base_color: vec4<f32>,
    channel_flag: vec4<f32>,
};

@group(0) @binding(0) var<uniform> mask_u: Live2dMaskUniforms;
@group(1) @binding(0) var mask_src_tex: texture_2d<f32>;
@group(1) @binding(1) var mask_src_samp: sampler;

struct Live2dMaskVsOut {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
    @location(1) my_pos: vec4<f32>,
};

@vertex
fn live2d_mask_vs(@location(0) pos: vec2<f32>, @location(1) uv: vec2<f32>) -> Live2dMaskVsOut {
    var out: Live2dMaskVsOut;
    let p = mask_u.clip_matrix * vec4<f32>(pos, 0.0, 1.0);
    out.position = p;
    out.my_pos = p;
    out.uv = uv;
    return out;
}

@fragment
fn live2d_mask_fs(in: Live2dMaskVsOut) -> @location(0) vec4<f32> {
    let ndc = in.my_pos.xy / in.my_pos.w;
    let is_inside = step(mask_u.base_color.x, ndc.x)
        * step(mask_u.base_color.y, ndc.y)
        * step(ndc.x, mask_u.base_color.z)
        * step(ndc.y, mask_u.base_color.w);
    let a = textureSample(mask_src_tex, mask_src_samp, in.uv).a;
    return mask_u.channel_flag * a * is_inside;
}

// ============================================================================
// 3. Live2D Cubism Drawable Mesh Pipeline (Unmasked / Masked / InvertedMask)
// ============================================================================

struct Live2dDrawUniforms {
    mvp: mat4x4<f32>,
    clip_matrix: mat4x4<f32>,
    base_color: vec4<f32>,
    multiply_color: vec4<f32>,
    screen_color: vec4<f32>,
    channel_flag: vec4<f32>,
    mask_mode: u32,
    _pad0: u32,
    _pad1: u32,
    _pad2: u32,
};

@group(0) @binding(0) var<uniform> draw_u: Live2dDrawUniforms;
@group(1) @binding(0) var draw_color_tex: texture_2d<f32>;
@group(1) @binding(1) var draw_mask_tex: texture_2d<f32>;
@group(1) @binding(2) var draw_samp: sampler;

struct Live2dDrawVsOut {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
    @location(1) clip_pos: vec4<f32>,
};

@vertex
fn live2d_draw_vs(@location(0) pos: vec2<f32>, @location(1) uv: vec2<f32>) -> Live2dDrawVsOut {
    var out: Live2dDrawVsOut;
    out.position = draw_u.mvp * vec4<f32>(pos, 0.0, 1.0);
    out.clip_pos = draw_u.clip_matrix * vec4<f32>(pos, 0.0, 1.0);
    out.uv = uv;
    return out;
}

@fragment
fn live2d_draw_fs(in: Live2dDrawVsOut) -> @location(0) vec4<f32> {
    var tex_color = textureSample(draw_color_tex, draw_samp, in.uv);
    var rgb = tex_color.rgb * draw_u.multiply_color.rgb;
    rgb = (rgb + draw_u.screen_color.rgb * tex_color.a) - (rgb * draw_u.screen_color.rgb);
    tex_color = vec4<f32>(rgb, tex_color.a);
    var col = tex_color * draw_u.base_color;

    if (draw_u.mask_mode != 0u) {
        let clip_uv = in.clip_pos.xy / in.clip_pos.w;
        let clip_mask = (vec4<f32>(1.0) - textureSampleLevel(draw_mask_tex, draw_samp, clip_uv, 0.0)) * draw_u.channel_flag;
        let mask_val = clip_mask.r + clip_mask.g + clip_mask.b + clip_mask.a;
        if (draw_u.mask_mode == 1u) {
            col = col * mask_val;
        } else if (draw_u.mask_mode == 2u) {
            col = col * (1.0 - mask_val);
        }
    }
    return col;
}

// ============================================================================
// 4. Shared Fullscreen Filter Vertex Shader
// ============================================================================

struct FilterVsOut {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

@vertex
fn filter_vs(@builtin(vertex_index) vid: u32) -> FilterVsOut {
    var pos = array<vec2<f32>, 3>(
        vec2<f32>(-1.0, 1.0),
        vec2<f32>(-1.0, -3.0),
        vec2<f32>(3.0, 1.0),
    );
    let p = pos[vid];
    var out: FilterVsOut;
    out.position = vec4<f32>(p, 0.0, 1.0);
    out.uv = vec2<f32>((p.x + 1.0) * 0.5, (1.0 - p.y) * 0.5);
    return out;
}

@group(0) @binding(0) var flt_tex: texture_2d<f32>;
@group(0) @binding(1) var flt_samp: sampler;
@group(2) @binding(0) var cs_dst_tex: texture_storage_2d<rgba8unorm, write>;
@group(3) @binding(0) var cs_bloom_orig_tex: texture_2d<f32>;

fn cs_uv(gid: vec3<u32>) -> vec2<f32> {
    let dims = textureDimensions(cs_dst_tex);
    return vec2<f32>(
        (f32(gid.x) + 0.5) / f32(dims.x),
        (f32(gid.y) + 0.5) / f32(dims.y)
    );
}

fn cs_in_bounds(gid: vec3<u32>) -> bool {
    let dims = textureDimensions(cs_dst_tex);
    return gid.x < dims.x && gid.y < dims.y;
}

// ---- 4a. AlphaFilter ----
struct AlphaFilterUniforms {
    alpha: f32,
    _pad0: f32,
    _pad1: f32,
    _pad2: f32,
};
@group(1) @binding(0) var<uniform> alpha_u: AlphaFilterUniforms;

fn eval_alpha(uv: vec2<f32>) -> vec4<f32> {
    return textureSampleLevel(flt_tex, flt_samp, uv, 0.0) * alpha_u.alpha;
}

@fragment
fn filter_alpha_fs(in: FilterVsOut) -> @location(0) vec4<f32> {
    return eval_alpha(in.uv);
}

@compute @workgroup_size(16, 16, 1)
fn filter_alpha_cs(@builtin(global_invocation_id) gid: vec3<u32>) {
    if (!cs_in_bounds(gid)) { return; }
    let out_col = clamp(eval_alpha(cs_uv(gid)), vec4<f32>(0.0), vec4<f32>(1.0));
    textureStore(cs_dst_tex, vec2<i32>(gid.xy), out_col);
}

// ---- 4b. AdjustmentFilter (matches pixi-filters adjustment.mjs) ----
struct AdjustmentUniforms {
    color: vec4<f32>,
    gamma: f32,
    contrast: f32,
    saturation: f32,
    brightness: f32,
};
@group(1) @binding(0) var<uniform> adj_u: AdjustmentUniforms;

fn eval_adjustment(uv: vec2<f32>) -> vec4<f32> {
    var c = textureSampleLevel(flt_tex, flt_samp, uv, 0.0);
    if (c.a > 0.0) {
        var rgb = max(c.rgb / c.a, vec3<f32>(0.0));
        rgb = pow(rgb, vec3<f32>(1.0 / max(adj_u.gamma, 1e-4)));
        let luma = vec3<f32>(dot(vec3<f32>(0.2125, 0.7154, 0.0721), rgb));
        rgb = mix(vec3<f32>(0.5), mix(luma, rgb, adj_u.saturation), adj_u.contrast);
        rgb.r *= adj_u.color.r;
        rgb.g *= adj_u.color.g;
        rgb.b *= adj_u.color.b;
        c = vec4<f32>(rgb * adj_u.brightness * c.a, c.a);
    }
    return c * adj_u.color.a;
}

@fragment
fn filter_adjustment_fs(in: FilterVsOut) -> @location(0) vec4<f32> {
    return eval_adjustment(in.uv);
}

@compute @workgroup_size(16, 16, 1)
fn filter_adjustment_cs(@builtin(global_invocation_id) gid: vec3<u32>) {
    if (!cs_in_bounds(gid)) { return; }
    let out_col = clamp(eval_adjustment(cs_uv(gid)), vec4<f32>(0.0), vec4<f32>(1.0));
    textureStore(cs_dst_tex, vec2<i32>(gid.xy), out_col);
}

// ---- 4c. ColorOverlayFilter (matches pixi-filters color-overlay.mjs) ----
struct ColorOverlayUniforms {
    color: vec3<f32>,
    alpha: f32,
};
@group(1) @binding(0) var<uniform> overlay_u: ColorOverlayUniforms;

fn eval_color_overlay(uv: vec2<f32>) -> vec4<f32> {
    let c = textureSampleLevel(flt_tex, flt_samp, uv, 0.0);
    return vec4<f32>(mix(c.rgb, overlay_u.color * c.a, overlay_u.alpha), c.a);
}

@fragment
fn filter_color_overlay_fs(in: FilterVsOut) -> @location(0) vec4<f32> {
    return eval_color_overlay(in.uv);
}

@compute @workgroup_size(16, 16, 1)
fn filter_color_overlay_cs(@builtin(global_invocation_id) gid: vec3<u32>) {
    if (!cs_in_bounds(gid)) { return; }
    let out_col = clamp(eval_color_overlay(cs_uv(gid)), vec4<f32>(0.0), vec4<f32>(1.0));
    textureStore(cs_dst_tex, vec2<i32>(gid.xy), out_col);
}

// ---- 4d. BlurFilterPass (matches Pixi BlurFilterPass + GAUSSIAN_VALUES) ----
struct BlurUniforms {
    weights: array<vec4<f32>, 4>,
    texel_size: vec2<f32>,
    strength: f32,
    horizontal: u32,
    kernel_size: i32,
    _pad0: i32,
    _pad1: i32,
    _pad2: i32,
};
@group(1) @binding(0) var<uniform> blur_u: BlurUniforms;

fn blur_weight(idx: i32) -> f32 {
    let slot = idx / 4;
    var v = blur_u.weights[0];
    if (slot == 1) { v = blur_u.weights[1]; }
    else if (slot == 2) { v = blur_u.weights[2]; }
    else if (slot >= 3) { v = blur_u.weights[3]; }
    let rem = idx % 4;
    if (rem == 0) { return v.x; }
    if (rem == 1) { return v.y; }
    if (rem == 2) { return v.z; }
    return v.w;
}

fn eval_blur(uv: vec2<f32>) -> vec4<f32> {
    let half_len = (blur_u.kernel_size + 1) / 2;
    var sum = vec4<f32>(0.0);
    let step_uv = select(
        vec2<f32>(0.0, blur_u.texel_size.y * blur_u.strength),
        vec2<f32>(blur_u.texel_size.x * blur_u.strength, 0.0),
        blur_u.horizontal != 0u
    );
    for (var i: i32 = 0; i < 15; i = i + 1) {
        if (i >= blur_u.kernel_size) {
            break;
        }
        let offset_steps = f32(i - half_len + 1);
        let k_idx = select(blur_u.kernel_size - i - 1, i, i < half_len);
        let uv_off = clamp(uv + step_uv * offset_steps, vec2<f32>(0.0), vec2<f32>(1.0));
        sum = sum + textureSampleLevel(flt_tex, flt_samp, uv_off, 0.0) * blur_weight(k_idx);
    }
    return sum;
}

@fragment
fn filter_blur_fs(in: FilterVsOut) -> @location(0) vec4<f32> {
    return eval_blur(in.uv);
}

@compute @workgroup_size(16, 16, 1)
fn filter_blur_cs(@builtin(global_invocation_id) gid: vec3<u32>) {
    if (!cs_in_bounds(gid)) { return; }
    let out_col = clamp(eval_blur(cs_uv(gid)), vec4<f32>(0.0), vec4<f32>(1.0));
    textureStore(cs_dst_tex, vec2<i32>(gid.xy), out_col);
}

@compute @workgroup_size(16, 16, 1)
fn filter_blur_screen_cs(@builtin(global_invocation_id) gid: vec3<u32>) {
    if (!cs_in_bounds(gid)) { return; }
    let src = clamp(eval_blur(cs_uv(gid)), vec4<f32>(0.0), vec4<f32>(1.0));
    let dst = textureLoad(cs_bloom_orig_tex, vec2<i32>(gid.xy), 0);
    let out_col = clamp(src + dst - src * dst, vec4<f32>(0.0), vec4<f32>(1.0));
    textureStore(cs_dst_tex, vec2<i32>(gid.xy), out_col);
}

// ---- 4e. CRTFilter (matches pixi-filters crt.mjs) ----
struct CrtUniforms {
    u_line: vec4<f32>,
    u_noise: vec2<f32>,
    u_dimensions: vec2<f32>,
    u_vignette: vec3<f32>,
    u_seed: f32,
    u_time: f32,
    _pad0: f32,
    _pad1: f32,
    _pad2: f32,
};
@group(1) @binding(0) var<uniform> crt_u: CrtUniforms;

const SQRT_2: f32 = 1.414213;

fn pixi_modulo(x: f32, y: f32) -> f32 {
    return x - y * floor(x / y);
}

fn pixi_rand(co: vec2<f32>) -> f32 {
    return fract(sin(dot(co, vec2<f32>(12.9898, 78.233))) * 43758.5453);
}

fn crt_vignette(coord: vec2<f32>) -> f32 {
    let outter = SQRT_2 - crt_u.u_vignette.x * SQRT_2;
    var dir = vec2<f32>(0.5) - coord;
    dir.y *= crt_u.u_dimensions.y / crt_u.u_dimensions.x;
    let darker = clamp((outter - length(dir) * SQRT_2) / (0.00001 + crt_u.u_vignette.z * SQRT_2), 0.0, 1.0);
    return darker + (1.0 - darker) * (1.0 - crt_u.u_vignette.y);
}

fn crt_noise(uv: vec2<f32>) -> f32 {
    var px = uv * crt_u.u_dimensions;
    px.x = floor(px.x / crt_u.u_noise.y);
    px.y = floor(px.y / crt_u.u_noise.y);
    return (pixi_rand(px * crt_u.u_noise.y * crt_u.u_seed) - 0.5) * crt_u.u_noise.x;
}

fn crt_interlace_lines(co: vec3<f32>, coord: vec2<f32>) -> vec3<f32> {
    var color = co;
    let curvature = crt_u.u_line.x;
    let line_width = crt_u.u_line.y;
    let line_contrast = crt_u.u_line.z;
    let vertical_line = crt_u.u_line.w;

    let dir = coord - 0.5;
    let _c = select(1.0, curvature, curvature > 0.0);
    let k = select(1.0, length(dir * dir) * 0.25 * _c * _c + 0.935 * _c, curvature > 0.0);
    let uv = dir * k;
    let v = select(uv.y * crt_u.u_dimensions.y, uv.x * crt_u.u_dimensions.x, vertical_line > 0.5)
        * min(1.0, 2.0 / line_width) / _c;
    let j = 1.0 + cos(v * 1.2 - crt_u.u_time) * 0.5 * line_contrast;
    color *= j;

    let segment = select(
        pixi_modulo((dir.y + 0.5) * crt_u.u_dimensions.y, 4.0),
        pixi_modulo((dir.x + 0.5) * crt_u.u_dimensions.x, 4.0),
        vertical_line > 0.5
    );
    color *= 0.99 + ceil(segment) * 0.015;
    return color;
}

fn eval_crt(uv: vec2<f32>) -> vec4<f32> {
    var color = textureSampleLevel(flt_tex, flt_samp, uv, 0.0);
    let coord = uv;
    if (crt_u.u_noise.x > 0.0 && crt_u.u_noise.y > 0.0) {
        color += vec4<f32>(vec3<f32>(crt_noise(uv)), color.a);
    }
    if (crt_u.u_vignette.x > 0.0) {
        color *= vec4<f32>(vec3<f32>(crt_vignette(coord)), color.a);
    }
    if (crt_u.u_line.y > 0.0) {
        color = vec4<f32>(crt_interlace_lines(color.rgb, uv), color.a);
    }
    return color;
}

@fragment
fn filter_crt_fs(in: FilterVsOut) -> @location(0) vec4<f32> {
    return eval_crt(in.uv);
}

@compute @workgroup_size(16, 16, 1)
fn filter_crt_cs(@builtin(global_invocation_id) gid: vec3<u32>) {
    if (!cs_in_bounds(gid)) { return; }
    let out_col = clamp(eval_crt(cs_uv(gid)), vec4<f32>(0.0), vec4<f32>(1.0));
    textureStore(cs_dst_tex, vec2<i32>(gid.xy), out_col);
}

// ---- 4f. OldFilmFilter (matches pixi-filters old-film.mjs) ----
struct OldFilmUniforms {
    u_scratch: vec3<f32>,
    u_sepia: f32,
    u_vignetting: vec3<f32>,
    u_seed: f32,
    u_noise: vec2<f32>,
    u_dimensions: vec2<f32>,
};
@group(1) @binding(0) var<uniform> old_u: OldFilmUniforms;

const SEPIA_RGB: vec3<f32> = vec3<f32>(112.0 / 255.0, 66.0 / 255.0, 20.0 / 255.0);

fn overlay_blend(src: vec3<f32>, dst: vec3<f32>) -> vec3<f32> {
    let r = select(1.0 - 2.0 * (1.0 - dst.x) * (1.0 - src.x), 2.0 * src.x * dst.x, dst.x <= 0.5);
    let g = select(1.0 - 2.0 * (1.0 - dst.y) * (1.0 - src.y), 2.0 * src.y * dst.y, dst.y <= 0.5);
    let b = select(1.0 - 2.0 * (1.0 - dst.z) * (1.0 - src.z), 2.0 * src.z * dst.z, dst.z <= 0.5);
    return vec3<f32>(r, g, b);
}

fn eval_old_film(uv: vec2<f32>) -> vec4<f32> {
    let orig = textureSampleLevel(flt_tex, flt_samp, uv, 0.0);
    var color = orig.rgb;
    if (old_u.u_sepia > 0.0) {
        let gray = (color.x + color.y + color.z) / 3.0;
        let grayscale = vec3<f32>(gray);
        let sep = overlay_blend(SEPIA_RGB, grayscale);
        color = grayscale + old_u.u_sepia * (sep - grayscale);
    }
    let coord = uv;
    let vignette = old_u.u_vignetting.x;
    let vignette_alpha = old_u.u_vignetting.y;
    let vignette_blur = old_u.u_vignetting.z;
    if (vignette > 0.0) {
        let outter = SQRT_2 - vignette * SQRT_2;
        var dir = vec2<f32>(0.5, 0.5) - coord;
        dir.y *= old_u.u_dimensions.y / old_u.u_dimensions.x;
        let darker = clamp((outter - length(dir) * SQRT_2) / (0.00001 + vignette_blur * SQRT_2), 0.0, 1.0);
        color *= darker + (1.0 - darker) * (1.0 - vignette_alpha);
    }
    let scratch = old_u.u_scratch.x;
    let scratch_density = old_u.u_scratch.y;
    let scratch_width = old_u.u_scratch.z;
    if (scratch_density > old_u.u_seed && scratch != 0.0) {
        let phase = old_u.u_seed * 256.0;
        let s = pixi_modulo(floor(phase), 2.0);
        let dist = 1.0 / scratch_density;
        let d = distance(coord, vec2<f32>(old_u.u_seed * dist, abs(s - old_u.u_seed * dist)));
        if (d < old_u.u_seed * 0.6 + 0.4) {
            let period = scratch_density * 10.0;
            let xx = coord.x * period + phase;
            let aa = abs(pixi_modulo(xx, 0.5) * 4.0);
            let bb = pixi_modulo(floor(xx / 0.5), 2.0);
            let yy = (1.0 - bb) * aa + bb * (2.0 - aa);
            let kk = 2.0 * period;
            let dw = scratch_width / old_u.u_dimensions.x * (0.75 + old_u.u_seed);
            let dh = dw * kk;
            let tine_raw = yy - (2.0 - dh);
            if (tine_raw > 0.0) {
                let _sign = sign(scratch);
                var tine = s * tine_raw / period + scratch + 0.1;
                tine = clamp(tine + 1.0, 0.5 + _sign * 0.5, 1.5 + _sign * 0.5);
                color *= tine;
            }
        }
    }
    let noise = old_u.u_noise.x;
    let noise_size = old_u.u_noise.y;
    if (noise > 0.0 && noise_size > 0.0) {
        var px = uv * old_u.u_dimensions;
        px.x = floor(px.x / noise_size);
        px.y = floor(px.y / noise_size);
        let _noise = pixi_rand(px * noise_size * old_u.u_seed) - 0.5;
        color += _noise * noise;
    }
    return vec4<f32>(color, orig.a);
}

@fragment
fn filter_old_film_fs(in: FilterVsOut) -> @location(0) vec4<f32> {
    return eval_old_film(in.uv);
}

@compute @workgroup_size(16, 16, 1)
fn filter_old_film_cs(@builtin(global_invocation_id) gid: vec3<u32>) {
    if (!cs_in_bounds(gid)) { return; }
    let out_col = clamp(eval_old_film(cs_uv(gid)), vec4<f32>(0.0), vec4<f32>(1.0));
    textureStore(cs_dst_tex, vec2<i32>(gid.xy), out_col);
}

// ============================================================================
// 5. GPU RGBA8 -> BT.709 Limited-Range Planar YUV420p Compute Packing
// ============================================================================

struct YuvConvertUniforms {
    width: u32,
    height: u32,
    y_words: u32,
    uv_words: u32,
};

@group(1) @binding(1) var<storage, read_write> yuv_out: array<u32>;
@group(1) @binding(2) var<uniform> yuv_u: YuvConvertUniforms;

fn load_rgb_i32(px: i32, py: i32) -> vec3<i32> {
    let c = textureLoad(flt_tex, vec2<i32>(px, py), 0).rgb;
    return vec3<i32>(round(c * 255.0));
}

@compute @workgroup_size(64, 1, 1)
fn rgba_to_yuv420p_bt709_cs(@builtin(global_invocation_id) gid: vec3<u32>) {
    let idx = gid.y * (256u * 64u) + gid.x;
    let total_words = yuv_u.y_words + yuv_u.uv_words;
    if (idx >= total_words) {
        return;
    }
    if (idx < yuv_u.y_words) {
        let base_px = idx * 4u;
        var packed: u32 = 0u;
        for (var i: u32 = 0u; i < 4u; i = i + 1u) {
            let p = base_px + i;
            let px = i32(p % yuv_u.width);
            let py = i32(p / yuv_u.width);
            let rgb = load_rgb_i32(px, py);
            let y = clamp(
                ((11966 * rgb.r + 40254 * rgb.g + 4064 * rgb.b + 32768) >> 16) + 16,
                16,
                235
            );
            packed = packed | (u32(y) << (i * 8u));
        }
        yuv_out[idx] = packed;
        return;
    }

    let u_word = idx - yuv_u.y_words;
    let cw = yuv_u.width / 2u;
    let ch = yuv_u.height / 2u;
    let uv_total = cw * ch;
    let base_c = u_word * 4u;
    var packed_u: u32 = 0u;
    var packed_v: u32 = 0u;
    for (var i: u32 = 0u; i < 4u; i = i + 1u) {
        let c_idx = base_c + i;
        if (c_idx < uv_total) {
            let cx = i32(c_idx % cw);
            let cy = i32(c_idx / cw);
            let x0 = cx * 2;
            let y0 = cy * 2;
            let rgb_sum = load_rgb_i32(x0, y0)
                + load_rgb_i32(x0 + 1, y0)
                + load_rgb_i32(x0, y0 + 1)
                + load_rgb_i32(x0 + 1, y0 + 1);
            let cb = clamp(
                ((-6596 * rgb_sum.r - 22188 * rgb_sum.g + 28784 * rgb_sum.b + 131072) >> 18) + 128,
                16,
                240
            );
            let cr = clamp(
                ((28784 * rgb_sum.r - 26145 * rgb_sum.g - 2639 * rgb_sum.b + 131072) >> 18) + 128,
                16,
                240
            );
            packed_u = packed_u | (u32(cb) << (i * 8u));
            packed_v = packed_v | (u32(cr) << (i * 8u));
        }
    }
    yuv_out[yuv_u.y_words + u_word] = packed_u;
    yuv_out[yuv_u.y_words + yuv_u.uv_words + u_word] = packed_v;
}
