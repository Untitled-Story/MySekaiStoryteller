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

@fragment
fn quad_pointwise_fs(in: QuadVertexOut) -> @location(0) vec4<f32> {
    let col_in = textureSample(quad_tex, quad_samp, in.uv) * in.color;
    if (chain_cs_u.skip_transparent != 0u && col_in.a <= 0.0) {
        discard;
    }
    var col = col_in;
    let uv = (in.position.xy + chain_cs_u.uv_px_offset) * chain_cs_u.stage_inv_dims;
    for (var i: u32 = 0u; i < chain_cs_u.op_count; i = i + 1u) {
        col = apply_pointwise_op(col, uv, chain_cs_u.ops[i]);
    }
    return col;
}

@fragment
fn bloom_quad_fs(in: QuadVertexOut) -> @location(0) vec4<f32> {
    let base = textureSample(quad_tex, quad_samp, in.uv);
    let glow_dims = vec2<f32>(textureDimensions(fused_bloom_tex));
    let uv_min = vec2<f32>(0.5) / glow_dims;
    let glow_uv = clamp(in.color.xy, uv_min, in.color.zw);
    let glow = clamp(textureSampleLevel(fused_bloom_tex, fused_bloom_samp, glow_uv, 0.0), vec4<f32>(0.0), vec4<f32>(1.0));
    let out_c = clamp(glow + base - glow * base, vec4<f32>(0.0), vec4<f32>(1.0));
    if (out_c.a <= 0.0) {
        discard;
    }
    return out_c;
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
// 3. Live2D Cubism Drawable Mesh Pipeline (Storage Uniforms + DrawBatching)
// ============================================================================

struct Live2dVsParams {
    mvp: mat4x4<f32>,
    clip_matrix: mat4x4<f32>,
};

struct Live2dFsParams {
    base_color: vec4<f32>,
    multiply_color: vec4<f32>,
    screen_color: vec4<f32>,
    channel_flag: vec4<f32>,
    mask_mode: u32,
    _pad0: u32,
    _pad1: u32,
    _pad2: u32,
};

@group(0) @binding(0) var<storage, read> draw_vs_table: array<Live2dVsParams>;
@group(0) @binding(1) var<storage, read> draw_fs_table: array<Live2dFsParams>;
@group(1) @binding(0) var draw_color_tex: texture_2d<f32>;
@group(1) @binding(1) var draw_mask_tex: texture_2d<f32>;
@group(1) @binding(2) var draw_samp: sampler;

struct Live2dDrawVsOut {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
    @location(1) clip_pos: vec4<f32>,
    @location(2) @interpolate(flat) draw_id: u32,
};

@vertex
fn live2d_draw_vs(
    @location(0) pos: vec2<f32>,
    @location(1) uv: vec2<f32>,
    @location(2) draw_id: u32,
) -> Live2dDrawVsOut {
    let p = draw_vs_table[draw_id];
    var out: Live2dDrawVsOut;
    out.position = p.mvp * vec4<f32>(pos, 0.0, 1.0);
    out.clip_pos = p.clip_matrix * vec4<f32>(pos, 0.0, 1.0);
    out.uv = uv;
    out.draw_id = draw_id;
    return out;
}

@fragment
fn live2d_draw_fs(in: Live2dDrawVsOut) -> @location(0) vec4<f32> {
    let p = draw_fs_table[in.draw_id];
    var tex_color = textureSample(draw_color_tex, draw_samp, in.uv);
    var rgb = tex_color.rgb * p.multiply_color.rgb;
    rgb = (rgb + p.screen_color.rgb * tex_color.a) - (rgb * p.screen_color.rgb);
    tex_color = vec4<f32>(rgb, tex_color.a);
    var col = tex_color * p.base_color;

    if (p.mask_mode != 0u) {
        let clip_uv = in.clip_pos.xy / in.clip_pos.w;
        let clip_mask = (vec4<f32>(1.0) - textureSampleLevel(draw_mask_tex, draw_samp, clip_uv, 0.0)) * p.channel_flag;
        let mask_val = clip_mask.r + clip_mask.g + clip_mask.b + clip_mask.a;
        if (p.mask_mode == 1u) {
            col = col * mask_val;
        } else if (p.mask_mode == 2u) {
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

fn apply_adjustment_col(
    c_in: vec4<f32>,
    color: vec4<f32>,
    gamma: f32,
    contrast: f32,
    saturation: f32,
    brightness: f32,
) -> vec4<f32> {
    var c = c_in;
    if (c.a > 0.0) {
        var rgb = max(c.rgb / c.a, vec3<f32>(0.0));
        if (abs(gamma - 1.0) > 1e-4) {
            rgb = pow(rgb, vec3<f32>(1.0 / max(gamma, 1e-4)));
        }
        if (abs(saturation - 1.0) > 1e-4 || abs(contrast - 1.0) > 1e-4) {
            let luma = vec3<f32>(dot(vec3<f32>(0.2125, 0.7154, 0.0721), rgb));
            rgb = mix(vec3<f32>(0.5), mix(luma, rgb, saturation), contrast);
        }
        rgb.r *= color.r;
        rgb.g *= color.g;
        rgb.b *= color.b;
        c = vec4<f32>(rgb * brightness * c.a, c.a);
    }
    return c * color.a;
}

fn eval_adjustment(uv: vec2<f32>) -> vec4<f32> {
    let c = textureSampleLevel(flt_tex, flt_samp, uv, 0.0);
    return apply_adjustment_col(c, adj_u.color, adj_u.gamma, adj_u.contrast, adj_u.saturation, adj_u.brightness);
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

fn apply_color_overlay_col(c: vec4<f32>, overlay_col: vec3<f32>, alpha: f32) -> vec4<f32> {
    return vec4<f32>(mix(c.rgb, overlay_col * c.a, alpha), c.a);
}

fn eval_color_overlay(uv: vec2<f32>) -> vec4<f32> {
    let c = textureSampleLevel(flt_tex, flt_samp, uv, 0.0);
    return apply_color_overlay_col(c, overlay_u.color, overlay_u.alpha);
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

// ---- 4d. BlurFilterPass & Resolution-Scaled Pyramid Helpers ----
struct BlurUniforms {
    weights: array<vec4<f32>, 4>,
    texel_size: vec2<f32>,
    strength: f32,
    horizontal: u32,
    kernel_size: i32,
    dst_offset_x: u32,
    dst_offset_y: u32,
    dispatch_w: u32,
    dispatch_h: u32,
    _pad0: u32,
    uv_min: vec2<f32>,
    uv_max: vec2<f32>,
    src_origin: vec2<f32>,
    src_scale: vec2<f32>,
    _pad1: vec2<u32>,
};
@group(1) @binding(0) var<uniform> blur_u: BlurUniforms;

fn eval_blur(uv: vec2<f32>) -> vec4<f32> {
    let half_len = (blur_u.kernel_size + 1) / 2;
    let center_idx = half_len - 1;
    let step_uv = select(
        vec2<f32>(0.0, blur_u.texel_size.y * blur_u.strength),
        vec2<f32>(blur_u.texel_size.x * blur_u.strength, 0.0),
        blur_u.horizontal != 0u
    );
    let center_w = blur_u.weights[u32(center_idx) >> 2u][u32(center_idx) & 3u];
    var sum = textureSampleLevel(flt_tex, flt_samp, clamp(uv, blur_u.uv_min, blur_u.uv_max), 0.0) * center_w;
    for (var d: i32 = 1; d < 8; d = d + 1) {
        if (d >= half_len) {
            break;
        }
        let k_idx = u32(center_idx - d);
        let w = blur_u.weights[k_idx >> 2u][k_idx & 3u];
        let delta = step_uv * f32(d);
        let s_pos = textureSampleLevel(flt_tex, flt_samp, clamp(uv + delta, blur_u.uv_min, blur_u.uv_max), 0.0);
        let s_neg = textureSampleLevel(flt_tex, flt_samp, clamp(uv - delta, blur_u.uv_min, blur_u.uv_max), 0.0);
        sum = sum + (s_pos + s_neg) * w;
    }
    return sum;
}

@fragment
fn filter_blur_fs(in: FilterVsOut) -> @location(0) vec4<f32> {
    return eval_blur(in.uv);
}

@compute @workgroup_size(16, 16, 1)
fn filter_blur_cs(@builtin(global_invocation_id) gid: vec3<u32>) {
    if (gid.x >= blur_u.dispatch_w || gid.y >= blur_u.dispatch_h) { return; }
    let uv = blur_u.src_origin + (vec2<f32>(gid.xy) + 0.5) * blur_u.src_scale;
    let out_col = clamp(eval_blur(uv), vec4<f32>(0.0), vec4<f32>(1.0));
    let out_px = vec2<i32>(i32(blur_u.dst_offset_x + gid.x), i32(blur_u.dst_offset_y + gid.y));
    textureStore(cs_dst_tex, out_px, out_col);
}

@compute @workgroup_size(16, 16, 1)
fn filter_blur_screen_cs(@builtin(global_invocation_id) gid: vec3<u32>) {
    if (gid.x >= blur_u.dispatch_w || gid.y >= blur_u.dispatch_h) { return; }
    let uv = blur_u.src_origin + (vec2<f32>(gid.xy) + 0.5) * blur_u.src_scale;
    let src = clamp(eval_blur(uv), vec4<f32>(0.0), vec4<f32>(1.0));
    let out_px = vec2<i32>(i32(blur_u.dst_offset_x + gid.x), i32(blur_u.dst_offset_y + gid.y));
    let dst = textureLoad(cs_bloom_orig_tex, out_px, 0);
    let out_col = clamp(src + dst - src * dst, vec4<f32>(0.0), vec4<f32>(1.0));
    textureStore(cs_dst_tex, out_px, out_col);
}

@compute @workgroup_size(16, 16, 1)
fn filter_downsample_2x_cs(@builtin(global_invocation_id) gid: vec3<u32>) {
    if (gid.x >= blur_u.dispatch_w || gid.y >= blur_u.dispatch_h) { return; }
    let uv = clamp(
        blur_u.src_origin + (vec2<f32>(gid.xy) + 0.5) * blur_u.src_scale,
        blur_u.uv_min,
        blur_u.uv_max
    );
    let c = clamp(textureSampleLevel(flt_tex, flt_samp, uv, 0.0), vec4<f32>(0.0), vec4<f32>(1.0));
    let out_px = vec2<i32>(i32(blur_u.dst_offset_x + gid.x), i32(blur_u.dst_offset_y + gid.y));
    textureStore(cs_dst_tex, out_px, c);
}

@compute @workgroup_size(16, 16, 1)
fn filter_downsample_4x_cs(@builtin(global_invocation_id) gid: vec3<u32>) {
    if (gid.x >= blur_u.dispatch_w || gid.y >= blur_u.dispatch_h) { return; }
    let base = blur_u.src_origin + (vec2<f32>(gid.xy) + 0.5) * blur_u.src_scale;
    let d = blur_u.texel_size;
    let s0 = textureSampleLevel(flt_tex, flt_samp, clamp(base + vec2<f32>(-d.x, -d.y), blur_u.uv_min, blur_u.uv_max), 0.0);
    let s1 = textureSampleLevel(flt_tex, flt_samp, clamp(base + vec2<f32>( d.x, -d.y), blur_u.uv_min, blur_u.uv_max), 0.0);
    let s2 = textureSampleLevel(flt_tex, flt_samp, clamp(base + vec2<f32>(-d.x,  d.y), blur_u.uv_min, blur_u.uv_max), 0.0);
    let s3 = textureSampleLevel(flt_tex, flt_samp, clamp(base + vec2<f32>( d.x,  d.y), blur_u.uv_min, blur_u.uv_max), 0.0);
    let c = clamp((s0 + s1 + s2 + s3) * 0.25, vec4<f32>(0.0), vec4<f32>(1.0));
    let out_px = vec2<i32>(i32(blur_u.dst_offset_x + gid.x), i32(blur_u.dst_offset_y + gid.y));
    textureStore(cs_dst_tex, out_px, c);
}

@compute @workgroup_size(16, 16, 1)
fn filter_upsample_cs(@builtin(global_invocation_id) gid: vec3<u32>) {
    if (gid.x >= blur_u.dispatch_w || gid.y >= blur_u.dispatch_h) { return; }
    let uv = clamp(
        blur_u.src_origin + (vec2<f32>(gid.xy) + 0.5) * blur_u.src_scale,
        blur_u.uv_min,
        blur_u.uv_max
    );
    let c = clamp(textureSampleLevel(flt_tex, flt_samp, uv, 0.0), vec4<f32>(0.0), vec4<f32>(1.0));
    let out_px = vec2<i32>(i32(blur_u.dst_offset_x + gid.x), i32(blur_u.dst_offset_y + gid.y));
    textureStore(cs_dst_tex, out_px, c);
}

@compute @workgroup_size(16, 16, 1)
fn filter_bloom_upsample_screen_cs(@builtin(global_invocation_id) gid: vec3<u32>) {
    if (gid.x >= blur_u.dispatch_w || gid.y >= blur_u.dispatch_h) { return; }
    let uv = clamp(
        blur_u.src_origin + (vec2<f32>(gid.xy) + 0.5) * blur_u.src_scale,
        blur_u.uv_min,
        blur_u.uv_max
    );
    let src = clamp(textureSampleLevel(flt_tex, flt_samp, uv, 0.0), vec4<f32>(0.0), vec4<f32>(1.0));
    let out_px = vec2<i32>(i32(blur_u.dst_offset_x + gid.x), i32(blur_u.dst_offset_y + gid.y));
    let dst = textureLoad(cs_bloom_orig_tex, out_px, 0);
    let out_col = clamp(src + dst - src * dst, vec4<f32>(0.0), vec4<f32>(1.0));
    textureStore(cs_dst_tex, out_px, out_col);
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

fn crt_vignette(coord: vec2<f32>, dims: vec2<f32>, vig: vec3<f32>) -> f32 {
    let outter = SQRT_2 - vig.x * SQRT_2;
    var dir = vec2<f32>(0.5) - coord;
    dir.y *= dims.y / dims.x;
    let darker = clamp((outter - length(dir) * SQRT_2) / (0.00001 + vig.z * SQRT_2), 0.0, 1.0);
    return darker + (1.0 - darker) * (1.0 - vig.y);
}

fn crt_noise(uv: vec2<f32>, noise: vec2<f32>, dims: vec2<f32>, seed: f32) -> f32 {
    var px = uv * dims;
    px.x = floor(px.x / noise.y);
    px.y = floor(px.y / noise.y);
    return (pixi_rand(px * noise.y * seed) - 0.5) * noise.x;
}

fn crt_interlace_lines(co: vec3<f32>, coord: vec2<f32>, line: vec4<f32>, dims: vec2<f32>, time: f32) -> vec3<f32> {
    var color = co;
    let curvature = line.x;
    let line_width = line.y;
    let line_contrast = line.z;
    let vertical_line = line.w;

    let dir = coord - 0.5;
    var _c = 1.0;
    var k = 1.0;
    if (curvature > 0.0) {
        _c = curvature;
        k = length(dir * dir) * 0.25 * _c * _c + 0.935 * _c;
    }
    let uv = dir * k;
    let v = select(uv.y * dims.y, uv.x * dims.x, vertical_line > 0.5)
        * min(1.0, 2.0 / line_width) / _c;
    let j = 1.0 + cos(v * 1.2 - time) * 0.5 * line_contrast;
    color *= j;

    let seg_arg = select((dir.y + 0.5) * dims.y, (dir.x + 0.5) * dims.x, vertical_line > 0.5);
    let segment = seg_arg - 4.0 * floor(seg_arg * 0.25);
    color *= 0.99 + ceil(segment) * 0.015;
    return color;
}

fn apply_crt_col(
    c_in: vec4<f32>,
    uv: vec2<f32>,
    u_line: vec4<f32>,
    u_noise: vec2<f32>,
    u_dimensions: vec2<f32>,
    u_vignette: vec3<f32>,
    u_seed: f32,
    u_time: f32,
) -> vec4<f32> {
    var color = c_in;
    if (u_noise.x > 0.0 && u_noise.y > 0.0) {
        color += vec4<f32>(vec3<f32>(crt_noise(uv, u_noise, u_dimensions, u_seed)), color.a);
    }
    if (u_vignette.x > 0.0) {
        color *= vec4<f32>(vec3<f32>(crt_vignette(uv, u_dimensions, u_vignette)), color.a);
    }
    if (u_line.y > 0.0) {
        color = vec4<f32>(crt_interlace_lines(color.rgb, uv, u_line, u_dimensions, u_time), color.a);
    }
    return color;
}

fn eval_crt(uv: vec2<f32>) -> vec4<f32> {
    let c = textureSampleLevel(flt_tex, flt_samp, uv, 0.0);
    return apply_crt_col(c, uv, crt_u.u_line, crt_u.u_noise, crt_u.u_dimensions, crt_u.u_vignette, crt_u.u_seed, crt_u.u_time);
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
    return select(1.0 - 2.0 * (1.0 - dst) * (1.0 - src), 2.0 * src * dst, dst <= vec3<f32>(0.5));
}

fn apply_old_film_col(
    orig: vec4<f32>,
    uv: vec2<f32>,
    u_scratch: vec3<f32>,
    u_sepia: f32,
    u_vignetting: vec3<f32>,
    u_seed: f32,
    u_noise: vec2<f32>,
    u_dimensions: vec2<f32>,
) -> vec4<f32> {
    var color = orig.rgb;
    if (u_sepia > 0.0) {
        let gray = (color.x + color.y + color.z) / 3.0;
        let grayscale = vec3<f32>(gray);
        let sep = overlay_blend(SEPIA_RGB, grayscale);
        color = grayscale + u_sepia * (sep - grayscale);
    }
    let coord = uv;
    let vignette = u_vignetting.x;
    let vignette_alpha = u_vignetting.y;
    let vignette_blur = u_vignetting.z;
    if (vignette > 0.0) {
        let outter = SQRT_2 - vignette * SQRT_2;
        var dir = vec2<f32>(0.5, 0.5) - coord;
        dir.y *= u_dimensions.y / u_dimensions.x;
        let darker = clamp((outter - length(dir) * SQRT_2) / (0.00001 + vignette_blur * SQRT_2), 0.0, 1.0);
        color *= darker + (1.0 - darker) * (1.0 - vignette_alpha);
    }
    let scratch = u_scratch.x;
    let scratch_density = u_scratch.y;
    let scratch_width = u_scratch.z;
    if (scratch_density > u_seed && scratch != 0.0) {
        let phase = u_seed * 256.0;
        let s = pixi_modulo(floor(phase), 2.0);
        let dist = 1.0 / scratch_density;
        let d = distance(coord, vec2<f32>(u_seed * dist, abs(s - u_seed * dist)));
        if (d < u_seed * 0.6 + 0.4) {
            let period = scratch_density * 10.0;
            let xx = coord.x * period + phase;
            let aa = abs(pixi_modulo(xx, 0.5) * 4.0);
            let bb = pixi_modulo(floor(xx / 0.5), 2.0);
            let yy = (1.0 - bb) * aa + bb * (2.0 - aa);
            let kk = 2.0 * period;
            let dw = scratch_width / u_dimensions.x * (0.75 + u_seed);
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
    let noise = u_noise.x;
    let noise_size = u_noise.y;
    if (noise > 0.0 && noise_size > 0.0) {
        var px = uv * u_dimensions;
        px.x = floor(px.x / noise_size);
        px.y = floor(px.y / noise_size);
        let _noise = pixi_rand(px * noise_size * u_seed) - 0.5;
        color += _noise * noise;
    }
    return vec4<f32>(color, orig.a);
}

fn eval_old_film(uv: vec2<f32>) -> vec4<f32> {
    let orig = textureSampleLevel(flt_tex, flt_samp, uv, 0.0);
    return apply_old_film_col(orig, uv, old_u.u_scratch, old_u.u_sepia, old_u.u_vignetting, old_u.u_seed, old_u.u_noise, old_u.u_dimensions);
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

// ---- 4g. Fused Pointwise Filter Chain (Region-Aware & Post+YUV Shared) ----
// op kinds: 1=Alpha, 2=Adjustment, 3=ColorOverlay, 4=Crt, 5=OldFilm, 6=UiOverlay
struct PointwiseOp {
    kind: u32,
    _pad0: u32,
    _pad1: u32,
    _pad2: u32,
    p0: vec4<f32>,
    p1: vec4<f32>,
    p2: vec4<f32>,
    p3: vec4<f32>,
};

struct PostChainUniforms {
    width: u32,
    height: u32,
    y_words: u32,
    uv_words: u32,
    dst_offset_x: u32,
    dst_offset_y: u32,
    dispatch_w: u32,
    dispatch_h: u32,
    op_count: u32,
    apply_backdrop: u32,
    has_bloom_glow: u32,
    skip_transparent: u32,
    backdrop_clear: vec4<f32>,
    fade_color_premul: vec4<f32>,
    bloom_uv_scale: vec2<f32>,
    bloom_uv_max: vec2<f32>,
    stage_inv_dims: vec2<f32>,
    uv_px_offset: vec2<f32>,
    fade_alpha: f32,
    _pad_t0: u32,
    _pad_t1: u32,
    _pad_t2: u32,
    ops: array<PointwiseOp, 8>,
};

@group(1) @binding(0) var<storage, read> chain_cs_u: PostChainUniforms;
@group(2) @binding(0) var<storage, read> chain_yuv_u: PostChainUniforms;
@group(3) @binding(0) var fused_bloom_tex: texture_2d<f32>;
@group(3) @binding(1) var fused_bloom_samp: sampler;
@group(3) @binding(2) var ui_overlay_tex: texture_2d<f32>;

fn apply_pointwise_op(col_in: vec4<f32>, uv: vec2<f32>, op: PointwiseOp) -> vec4<f32> {
    if (op.kind == 1u) {
        return clamp(col_in * op.p0.x, vec4<f32>(0.0), vec4<f32>(1.0));
    } else if (op.kind == 2u) {
        let out_c = apply_adjustment_col(col_in, op.p0, op.p1.x, op.p1.y, op.p1.z, op.p1.w);
        return clamp(out_c, vec4<f32>(0.0), vec4<f32>(1.0));
    } else if (op.kind == 3u) {
        let out_c = apply_color_overlay_col(col_in, op.p0.xyz, op.p0.w);
        return clamp(out_c, vec4<f32>(0.0), vec4<f32>(1.0));
    } else if (op.kind == 4u) {
        let out_c = apply_crt_col(col_in, uv, op.p0, op.p1.xy, op.p1.zw, op.p2.xyz, op.p2.w, op.p3.x);
        return clamp(out_c, vec4<f32>(0.0), vec4<f32>(1.0));
    } else if (op.kind == 5u) {
        let out_c = apply_old_film_col(col_in, uv, op.p0.xyz, op.p0.w, op.p1.xyz, op.p1.w, op.p2.xy, op.p2.zw);
        return clamp(out_c, vec4<f32>(0.0), vec4<f32>(1.0));
    }
    return col_in;
}

fn eval_crt_4x1(
    in_c0: vec4<f32>,
    in_c1: vec4<f32>,
    in_c2: vec4<f32>,
    in_c3: vec4<f32>,
    uv0_x: f32,
    uv1_x: f32,
    uv2_x: f32,
    uv3_x: f32,
    uv_y: f32,
    op: PointwiseOp,
) -> array<vec4<f32>, 4> {
    var c0 = in_c0;
    var c1 = in_c1;
    var c2 = in_c2;
    var c3 = in_c3;
    let u_line = op.p0;
    let u_noise = op.p1.xy;
    let u_dims = op.p1.zw;
    let u_vig = op.p2.xyz;
    let u_seed = op.p2.w;
    let u_time = op.p3.x;
    if (u_noise.x > 0.0 && u_noise.y > 0.0) {
        let inv_n = 1.0 / u_noise.y;
        let sx = u_dims.x * inv_n;
        let ny = floor(uv_y * (u_dims.y * inv_n));
        let k = u_noise.y * u_seed;
        let n_mul = u_noise.x;
        c0 += vec4<f32>(vec3<f32>((pixi_rand(vec2<f32>(floor(uv0_x * sx), ny) * k) - 0.5) * n_mul), c0.a);
        c1 += vec4<f32>(vec3<f32>((pixi_rand(vec2<f32>(floor(uv1_x * sx), ny) * k) - 0.5) * n_mul), c1.a);
        c2 += vec4<f32>(vec3<f32>((pixi_rand(vec2<f32>(floor(uv2_x * sx), ny) * k) - 0.5) * n_mul), c2.a);
        c3 += vec4<f32>(vec3<f32>((pixi_rand(vec2<f32>(floor(uv3_x * sx), ny) * k) - 0.5) * n_mul), c3.a);
    }
    if (u_vig.x > 0.0) {
        let outter = SQRT_2 - u_vig.x * SQRT_2;
        let inv_blur = 1.0 / (0.00001 + u_vig.z * SQRT_2);
        let vy = (0.5 - uv_y) * (u_dims.y / u_dims.x);
        let vy2 = vy * vy;
        let d0 = sqrt((0.5 - uv0_x) * (0.5 - uv0_x) + vy2);
        let d1 = sqrt((0.5 - uv1_x) * (0.5 - uv1_x) + vy2);
        let d2 = sqrt((0.5 - uv2_x) * (0.5 - uv2_x) + vy2);
        let d3 = sqrt((0.5 - uv3_x) * (0.5 - uv3_x) + vy2);
        let k0 = clamp((outter - d0 * SQRT_2) * inv_blur, 0.0, 1.0);
        let k1 = clamp((outter - d1 * SQRT_2) * inv_blur, 0.0, 1.0);
        let k2 = clamp((outter - d2 * SQRT_2) * inv_blur, 0.0, 1.0);
        let k3 = clamp((outter - d3 * SQRT_2) * inv_blur, 0.0, 1.0);
        let va = 1.0 - u_vig.y;
        c0 *= vec4<f32>(vec3<f32>(k0 + (1.0 - k0) * va), c0.a);
        c1 *= vec4<f32>(vec3<f32>(k1 + (1.0 - k1) * va), c1.a);
        c2 *= vec4<f32>(vec3<f32>(k2 + (1.0 - k2) * va), c2.a);
        c3 *= vec4<f32>(vec3<f32>(k3 + (1.0 - k3) * va), c3.a);
    }
    if (u_line.y > 0.0) {
        if (u_line.x <= 0.0 && u_line.w <= 0.5) {
            let v = (uv_y - 0.5) * u_dims.y * min(1.0, 2.0 / u_line.y);
            let j = 1.0 + cos(v * 1.2 - u_time) * 0.5 * u_line.z;
            let seg_arg = uv_y * u_dims.y;
            let segment = seg_arg - 4.0 * floor(seg_arg * 0.25);
            let scan_mul = j * (0.99 + ceil(segment) * 0.015);
            c0 = vec4<f32>(c0.rgb * scan_mul, c0.a);
            c1 = vec4<f32>(c1.rgb * scan_mul, c1.a);
            c2 = vec4<f32>(c2.rgb * scan_mul, c2.a);
            c3 = vec4<f32>(c3.rgb * scan_mul, c3.a);
        } else if (u_line.w <= 0.5) {
            let dy = uv_y - 0.5;
            let dy2 = dy * dy;
            let dy4 = dy2 * dy2;
            let scale_y = u_dims.y * min(1.0, 2.0 / u_line.y);
            let seg_arg = uv_y * u_dims.y;
            let seg_mul = 0.99 + ceil(seg_arg - 4.0 * floor(seg_arg * 0.25)) * 0.015;
            let half_c = 0.5 * u_line.z;
            let c_quarter = 0.25 * u_line.x;
            let dx0 = uv0_x - 0.5; let dx1 = uv1_x - 0.5; let dx2 = uv2_x - 0.5; let dx3 = uv3_x - 0.5;
            let l0 = sqrt(dx0 * dx0 * dx0 * dx0 + dy4) * c_quarter + 0.935;
            let l1 = sqrt(dx1 * dx1 * dx1 * dx1 + dy4) * c_quarter + 0.935;
            let l2 = sqrt(dx2 * dx2 * dx2 * dx2 + dy4) * c_quarter + 0.935;
            let l3 = sqrt(dx3 * dx3 * dx3 * dx3 + dy4) * c_quarter + 0.935;
            let m0 = (1.0 + cos(dy * l0 * scale_y * 1.2 - u_time) * half_c) * seg_mul;
            let m1 = (1.0 + cos(dy * l1 * scale_y * 1.2 - u_time) * half_c) * seg_mul;
            let m2 = (1.0 + cos(dy * l2 * scale_y * 1.2 - u_time) * half_c) * seg_mul;
            let m3 = (1.0 + cos(dy * l3 * scale_y * 1.2 - u_time) * half_c) * seg_mul;
            c0 = vec4<f32>(c0.rgb * m0, c0.a);
            c1 = vec4<f32>(c1.rgb * m1, c1.a);
            c2 = vec4<f32>(c2.rgb * m2, c2.a);
            c3 = vec4<f32>(c3.rgb * m3, c3.a);
        } else {
            c0 = vec4<f32>(crt_interlace_lines(c0.rgb, vec2<f32>(uv0_x, uv_y), u_line, u_dims, u_time), c0.a);
            c1 = vec4<f32>(crt_interlace_lines(c1.rgb, vec2<f32>(uv1_x, uv_y), u_line, u_dims, u_time), c1.a);
            c2 = vec4<f32>(crt_interlace_lines(c2.rgb, vec2<f32>(uv2_x, uv_y), u_line, u_dims, u_time), c2.a);
            c3 = vec4<f32>(crt_interlace_lines(c3.rgb, vec2<f32>(uv3_x, uv_y), u_line, u_dims, u_time), c3.a);
        }
    }
    return array<vec4<f32>, 4>(
        clamp(c0, vec4<f32>(0.0), vec4<f32>(1.0)),
        clamp(c1, vec4<f32>(0.0), vec4<f32>(1.0)),
        clamp(c2, vec4<f32>(0.0), vec4<f32>(1.0)),
        clamp(c3, vec4<f32>(0.0), vec4<f32>(1.0)),
    );
}

fn eval_old_film_4x1(
    in_c0: vec4<f32>,
    in_c1: vec4<f32>,
    in_c2: vec4<f32>,
    in_c3: vec4<f32>,
    uv0_x: f32,
    uv1_x: f32,
    uv2_x: f32,
    uv3_x: f32,
    uv_y: f32,
    op: PointwiseOp,
) -> array<vec4<f32>, 4> {
    let u_scratch = op.p0.xyz;
    let u_sepia = op.p0.w;
    let u_vig = op.p1.xyz;
    let u_seed = op.p1.w;
    let u_noise = op.p2.xy;
    let u_dims = op.p2.zw;
    var r0 = in_c0.rgb; var r1 = in_c1.rgb; var r2 = in_c2.rgb; var r3 = in_c3.rgb;
    if (u_sepia > 0.0) {
        let g0 = vec3<f32>((r0.x + r0.y + r0.z) / 3.0);
        let g1 = vec3<f32>((r1.x + r1.y + r1.z) / 3.0);
        let g2 = vec3<f32>((r2.x + r2.y + r2.z) / 3.0);
        let g3 = vec3<f32>((r3.x + r3.y + r3.z) / 3.0);
        r0 = g0 + u_sepia * (overlay_blend(SEPIA_RGB, g0) - g0);
        r1 = g1 + u_sepia * (overlay_blend(SEPIA_RGB, g1) - g1);
        r2 = g2 + u_sepia * (overlay_blend(SEPIA_RGB, g2) - g2);
        r3 = g3 + u_sepia * (overlay_blend(SEPIA_RGB, g3) - g3);
    }
    if (u_vig.x > 0.0) {
        let outter = SQRT_2 - u_vig.x * SQRT_2;
        let inv_blur = 1.0 / (0.00001 + u_vig.z * SQRT_2);
        let vy = (0.5 - uv_y) * (u_dims.y / u_dims.x);
        let vy2 = vy * vy;
        let d0 = sqrt((0.5 - uv0_x) * (0.5 - uv0_x) + vy2);
        let d1 = sqrt((0.5 - uv1_x) * (0.5 - uv1_x) + vy2);
        let d2 = sqrt((0.5 - uv2_x) * (0.5 - uv2_x) + vy2);
        let d3 = sqrt((0.5 - uv3_x) * (0.5 - uv3_x) + vy2);
        let k0 = clamp((outter - d0 * SQRT_2) * inv_blur, 0.0, 1.0);
        let k1 = clamp((outter - d1 * SQRT_2) * inv_blur, 0.0, 1.0);
        let k2 = clamp((outter - d2 * SQRT_2) * inv_blur, 0.0, 1.0);
        let k3 = clamp((outter - d3 * SQRT_2) * inv_blur, 0.0, 1.0);
        let va = 1.0 - u_vig.y;
        r0 *= k0 + (1.0 - k0) * va;
        r1 *= k1 + (1.0 - k1) * va;
        r2 *= k2 + (1.0 - k2) * va;
        r3 *= k3 + (1.0 - k3) * va;
    }
    if (u_scratch.y > u_seed && u_scratch.x != 0.0) {
        let phase = u_seed * 256.0;
        let s = pixi_modulo(floor(phase), 2.0);
        let dist = 1.0 / u_scratch.y;
        let sc_x = u_seed * dist;
        let dy_s = uv_y - abs(s - sc_x);
        let dy_s2 = dy_s * dy_s;
        let max_d = u_seed * 0.6 + 0.4;
        let max_d2 = max_d * max_d;
        if (dy_s2 < max_d2) {
            let period = u_scratch.y * 10.0;
            let dh = (u_scratch.z / u_dims.x * (0.75 + u_seed)) * (2.0 * period);
            let base_t = 2.0 - dh;
            let _sign = sign(u_scratch.x);
            let t_min = 0.5 + _sign * 0.5;
            let t_max = 1.5 + _sign * 0.5;
            let s_inv_p = s / period;
            let dx0 = uv0_x - sc_x; if (dx0 * dx0 + dy_s2 < max_d2) { let xx = uv0_x * period + phase; let aa = abs(pixi_modulo(xx, 0.5) * 4.0); let bb = pixi_modulo(floor(xx * 2.0), 2.0); let tr = ((1.0 - bb) * aa + bb * (2.0 - aa)) - base_t; if (tr > 0.0) { r0 *= clamp(s_inv_p * tr + u_scratch.x + 1.1, t_min, t_max); } }
            let dx1 = uv1_x - sc_x; if (dx1 * dx1 + dy_s2 < max_d2) { let xx = uv1_x * period + phase; let aa = abs(pixi_modulo(xx, 0.5) * 4.0); let bb = pixi_modulo(floor(xx * 2.0), 2.0); let tr = ((1.0 - bb) * aa + bb * (2.0 - aa)) - base_t; if (tr > 0.0) { r1 *= clamp(s_inv_p * tr + u_scratch.x + 1.1, t_min, t_max); } }
            let dx2 = uv2_x - sc_x; if (dx2 * dx2 + dy_s2 < max_d2) { let xx = uv2_x * period + phase; let aa = abs(pixi_modulo(xx, 0.5) * 4.0); let bb = pixi_modulo(floor(xx * 2.0), 2.0); let tr = ((1.0 - bb) * aa + bb * (2.0 - aa)) - base_t; if (tr > 0.0) { r2 *= clamp(s_inv_p * tr + u_scratch.x + 1.1, t_min, t_max); } }
            let dx3 = uv3_x - sc_x; if (dx3 * dx3 + dy_s2 < max_d2) { let xx = uv3_x * period + phase; let aa = abs(pixi_modulo(xx, 0.5) * 4.0); let bb = pixi_modulo(floor(xx * 2.0), 2.0); let tr = ((1.0 - bb) * aa + bb * (2.0 - aa)) - base_t; if (tr > 0.0) { r3 *= clamp(s_inv_p * tr + u_scratch.x + 1.1, t_min, t_max); } }
        }
    }
    if (u_noise.x > 0.0 && u_noise.y > 0.0) {
        let inv_n = 1.0 / u_noise.y;
        let sx = u_dims.x * inv_n;
        let ny = floor(uv_y * (u_dims.y * inv_n));
        let k = u_noise.y * u_seed;
        let n_mul = u_noise.x;
        r0 += (pixi_rand(vec2<f32>(floor(uv0_x * sx), ny) * k) - 0.5) * n_mul;
        r1 += (pixi_rand(vec2<f32>(floor(uv1_x * sx), ny) * k) - 0.5) * n_mul;
        r2 += (pixi_rand(vec2<f32>(floor(uv2_x * sx), ny) * k) - 0.5) * n_mul;
        r3 += (pixi_rand(vec2<f32>(floor(uv3_x * sx), ny) * k) - 0.5) * n_mul;
    }
    return array<vec4<f32>, 4>(
        clamp(vec4<f32>(r0, in_c0.a), vec4<f32>(0.0), vec4<f32>(1.0)),
        clamp(vec4<f32>(r1, in_c1.a), vec4<f32>(0.0), vec4<f32>(1.0)),
        clamp(vec4<f32>(r2, in_c2.a), vec4<f32>(0.0), vec4<f32>(1.0)),
        clamp(vec4<f32>(r3, in_c3.a), vec4<f32>(0.0), vec4<f32>(1.0)),
    );
}

@compute @workgroup_size(16, 16, 1)
fn filter_pointwise_light_cs(@builtin(global_invocation_id) gid: vec3<u32>) {
    if (gid.y >= chain_cs_u.dispatch_h) { return; }
    let base_gx = gid.x * 4u;
    if (base_gx >= chain_cs_u.dispatch_w) { return; }
    let py = i32(chain_cs_u.dst_offset_y + gid.y);
    let base_px = i32(chain_cs_u.dst_offset_x + base_gx);
    let op_count = chain_cs_u.op_count;
    let skip_t = chain_cs_u.skip_transparent != 0u;
    let max_k = min(4u, chain_cs_u.dispatch_w - base_gx);
    for (var k: u32 = 0u; k < max_k; k = k + 1u) {
        let px = vec2<i32>(base_px + i32(k), py);
        var col = textureLoad(flt_tex, px, 0);
        if (skip_t && col.a <= 0.0) {
            textureStore(cs_dst_tex, px, vec4<f32>(0.0));
            continue;
        }
        for (var i: u32 = 0u; i < op_count; i = i + 1u) {
            let op = chain_cs_u.ops[i];
            if (op.kind == 1u) {
                col = clamp(col * op.p0.x, vec4<f32>(0.0), vec4<f32>(1.0));
            } else if (op.kind == 2u) {
                col = clamp(apply_adjustment_col(col, op.p0, op.p1.x, op.p1.y, op.p1.z, op.p1.w), vec4<f32>(0.0), vec4<f32>(1.0));
            } else if (op.kind == 3u) {
                col = clamp(apply_color_overlay_col(col, op.p0.xyz, op.p0.w), vec4<f32>(0.0), vec4<f32>(1.0));
            }
        }
        textureStore(cs_dst_tex, px, col);
    }
}

@compute @workgroup_size(16, 16, 1)
fn filter_pointwise_chain_cs(@builtin(global_invocation_id) gid: vec3<u32>) {
    if (gid.y >= chain_cs_u.dispatch_h) { return; }
    let base_gx = gid.x * 4u;
    if (base_gx >= chain_cs_u.dispatch_w) { return; }
    let py = i32(chain_cs_u.dst_offset_y + gid.y);
    let base_px = i32(chain_cs_u.dst_offset_x + base_gx);
    let op_count = chain_cs_u.op_count;
    let skip_t = chain_cs_u.skip_transparent != 0u;
    let max_k = min(4u, chain_cs_u.dispatch_w - base_gx);
    let inv_d = chain_cs_u.stage_inv_dims;
    let uv_y = (f32(py) + chain_cs_u.uv_px_offset.y + 0.5) * inv_d.y;

    if (max_k == 4u) {
        var c0 = textureLoad(flt_tex, vec2<i32>(base_px + 0, py), 0);
        var c1 = textureLoad(flt_tex, vec2<i32>(base_px + 1, py), 0);
        var c2 = textureLoad(flt_tex, vec2<i32>(base_px + 2, py), 0);
        var c3 = textureLoad(flt_tex, vec2<i32>(base_px + 3, py), 0);
        if (skip_t && c0.a <= 0.0 && c1.a <= 0.0 && c2.a <= 0.0 && c3.a <= 0.0) {
            textureStore(cs_dst_tex, vec2<i32>(base_px + 0, py), vec4<f32>(0.0));
            textureStore(cs_dst_tex, vec2<i32>(base_px + 1, py), vec4<f32>(0.0));
            textureStore(cs_dst_tex, vec2<i32>(base_px + 2, py), vec4<f32>(0.0));
            textureStore(cs_dst_tex, vec2<i32>(base_px + 3, py), vec4<f32>(0.0));
            return;
        }
        let off_x = chain_cs_u.uv_px_offset.x + 0.5;
        let uv0_x = (f32(base_px + 0) + off_x) * inv_d.x;
        let uv1_x = (f32(base_px + 1) + off_x) * inv_d.x;
        let uv2_x = (f32(base_px + 2) + off_x) * inv_d.x;
        let uv3_x = (f32(base_px + 3) + off_x) * inv_d.x;
        for (var i: u32 = 0u; i < op_count; i = i + 1u) {
            let op = chain_cs_u.ops[i];
            if (op.kind == 1u) {
                let a = op.p0.x;
                c0 = clamp(c0 * a, vec4<f32>(0.0), vec4<f32>(1.0));
                c1 = clamp(c1 * a, vec4<f32>(0.0), vec4<f32>(1.0));
                c2 = clamp(c2 * a, vec4<f32>(0.0), vec4<f32>(1.0));
                c3 = clamp(c3 * a, vec4<f32>(0.0), vec4<f32>(1.0));
            } else if (op.kind == 2u) {
                c0 = clamp(apply_adjustment_col(c0, op.p0, op.p1.x, op.p1.y, op.p1.z, op.p1.w), vec4<f32>(0.0), vec4<f32>(1.0));
                c1 = clamp(apply_adjustment_col(c1, op.p0, op.p1.x, op.p1.y, op.p1.z, op.p1.w), vec4<f32>(0.0), vec4<f32>(1.0));
                c2 = clamp(apply_adjustment_col(c2, op.p0, op.p1.x, op.p1.y, op.p1.z, op.p1.w), vec4<f32>(0.0), vec4<f32>(1.0));
                c3 = clamp(apply_adjustment_col(c3, op.p0, op.p1.x, op.p1.y, op.p1.z, op.p1.w), vec4<f32>(0.0), vec4<f32>(1.0));
            } else if (op.kind == 3u) {
                c0 = clamp(apply_color_overlay_col(c0, op.p0.xyz, op.p0.w), vec4<f32>(0.0), vec4<f32>(1.0));
                c1 = clamp(apply_color_overlay_col(c1, op.p0.xyz, op.p0.w), vec4<f32>(0.0), vec4<f32>(1.0));
                c2 = clamp(apply_color_overlay_col(c2, op.p0.xyz, op.p0.w), vec4<f32>(0.0), vec4<f32>(1.0));
                c3 = clamp(apply_color_overlay_col(c3, op.p0.xyz, op.p0.w), vec4<f32>(0.0), vec4<f32>(1.0));
            } else if (op.kind == 4u) {
                let res = eval_crt_4x1(c0, c1, c2, c3, uv0_x, uv1_x, uv2_x, uv3_x, uv_y, op);
                c0 = res[0]; c1 = res[1]; c2 = res[2]; c3 = res[3];
            } else if (op.kind == 5u) {
                let res = eval_old_film_4x1(c0, c1, c2, c3, uv0_x, uv1_x, uv2_x, uv3_x, uv_y, op);
                c0 = res[0]; c1 = res[1]; c2 = res[2]; c3 = res[3];
            }
        }
        textureStore(cs_dst_tex, vec2<i32>(base_px + 0, py), select(c0, vec4<f32>(0.0), skip_t && c0.a <= 0.0));
        textureStore(cs_dst_tex, vec2<i32>(base_px + 1, py), select(c1, vec4<f32>(0.0), skip_t && c1.a <= 0.0));
        textureStore(cs_dst_tex, vec2<i32>(base_px + 2, py), select(c2, vec4<f32>(0.0), skip_t && c2.a <= 0.0));
        textureStore(cs_dst_tex, vec2<i32>(base_px + 3, py), select(c3, vec4<f32>(0.0), skip_t && c3.a <= 0.0));
        return;
    }

    for (var k: u32 = 0u; k < max_k; k = k + 1u) {
        let px = vec2<i32>(base_px + i32(k), py);
        var col = textureLoad(flt_tex, px, 0);
        if (skip_t && col.a <= 0.0) {
            textureStore(cs_dst_tex, px, vec4<f32>(0.0));
            continue;
        }
        let uv_x = (f32(px.x) + chain_cs_u.uv_px_offset.x + 0.5) * inv_d.x;
        let uv = vec2<f32>(uv_x, uv_y);
        for (var i: u32 = 0u; i < op_count; i = i + 1u) {
            col = apply_pointwise_op(col, uv, chain_cs_u.ops[i]);
        }
        textureStore(cs_dst_tex, px, col);
    }
}

// ============================================================================
// 5. GPU RGBA8 / Fused Post -> BT.709 Limited-Range Planar YUV420p Packing
// ============================================================================

struct YuvConvertUniforms {
    width: u32,
    height: u32,
    y_words: u32,
    uv_words: u32,
};

@group(1) @binding(1) var<storage, read_write> yuv_out: array<u32>;
@group(1) @binding(2) var<uniform> yuv_u: YuvConvertUniforms;

var<workgroup> sh_u: array<u32, 256>;
var<workgroup> sh_v: array<u32, 256>;

fn load_rgb_i32(px: i32, py: i32) -> vec3<i32> {
    let c = textureLoad(flt_tex, vec2<i32>(px, py), 0).rgb;
    return vec3<i32>(round(c * 255.0));
}

fn eval_fused_post_head(px: i32, py: i32) -> vec4<f32> {
    if (chain_yuv_u.has_bloom_glow == 2u) {
        let buv = clamp((vec2<f32>(f32(px) + 0.5, f32(py) + 0.5)) * chain_yuv_u.bloom_uv_scale, vec2<f32>(0.0), chain_yuv_u.bloom_uv_max);
        return clamp(textureSampleLevel(fused_bloom_tex, fused_bloom_samp, buv, 0.0), vec4<f32>(0.0), vec4<f32>(1.0));
    }
    var col = textureLoad(flt_tex, vec2<i32>(px, py), 0);
    if (chain_yuv_u.has_bloom_glow == 1u) {
        let buv = clamp((vec2<f32>(f32(px) + 0.5, f32(py) + 0.5)) * chain_yuv_u.bloom_uv_scale, vec2<f32>(0.0), chain_yuv_u.bloom_uv_max);
        let glow = clamp(textureSampleLevel(fused_bloom_tex, fused_bloom_samp, buv, 0.0), vec4<f32>(0.0), vec4<f32>(1.0));
        col = clamp(glow + col - glow * col, vec4<f32>(0.0), vec4<f32>(1.0));
    }
    return col;
}

fn eval_fused_post_tail(col_in: vec4<f32>) -> vec3<i32> {
    var col = col_in;
    if (chain_yuv_u.apply_backdrop != 0u) {
        col = clamp(col + chain_yuv_u.backdrop_clear * (1.0 - col.a), vec4<f32>(0.0), vec4<f32>(1.0));
    }
    if (chain_yuv_u.fade_alpha > 0.0) {
        col = clamp(chain_yuv_u.fade_color_premul + col * (1.0 - chain_yuv_u.fade_alpha), vec4<f32>(0.0), vec4<f32>(1.0));
    }
    return vec3<i32>(round(col.rgb * 255.0));
}

fn eval_fused_post_4x1(px: i32, py: i32, allow_ui: bool) -> array<vec3<i32>, 4> {
    var c0 = textureLoad(flt_tex, vec2<i32>(px + 0, py), 0);
    var c1 = textureLoad(flt_tex, vec2<i32>(px + 1, py), 0);
    var c2 = textureLoad(flt_tex, vec2<i32>(px + 2, py), 0);
    var c3 = textureLoad(flt_tex, vec2<i32>(px + 3, py), 0);

    if (chain_yuv_u.has_bloom_glow == 1u) {
        let by = clamp((f32(py) + 0.5) * chain_yuv_u.bloom_uv_scale.y, 0.0, chain_yuv_u.bloom_uv_max.y);
        let b0 = clamp(textureSampleLevel(fused_bloom_tex, fused_bloom_samp, vec2<f32>(clamp((f32(px + 0) + 0.5) * chain_yuv_u.bloom_uv_scale.x, 0.0, chain_yuv_u.bloom_uv_max.x), by), 0.0), vec4<f32>(0.0), vec4<f32>(1.0));
        let b1 = clamp(textureSampleLevel(fused_bloom_tex, fused_bloom_samp, vec2<f32>(clamp((f32(px + 1) + 0.5) * chain_yuv_u.bloom_uv_scale.x, 0.0, chain_yuv_u.bloom_uv_max.x), by), 0.0), vec4<f32>(0.0), vec4<f32>(1.0));
        let b2 = clamp(textureSampleLevel(fused_bloom_tex, fused_bloom_samp, vec2<f32>(clamp((f32(px + 2) + 0.5) * chain_yuv_u.bloom_uv_scale.x, 0.0, chain_yuv_u.bloom_uv_max.x), by), 0.0), vec4<f32>(0.0), vec4<f32>(1.0));
        let b3 = clamp(textureSampleLevel(fused_bloom_tex, fused_bloom_samp, vec2<f32>(clamp((f32(px + 3) + 0.5) * chain_yuv_u.bloom_uv_scale.x, 0.0, chain_yuv_u.bloom_uv_max.x), by), 0.0), vec4<f32>(0.0), vec4<f32>(1.0));
        c0 = clamp(b0 + c0 - b0 * c0, vec4<f32>(0.0), vec4<f32>(1.0));
        c1 = clamp(b1 + c1 - b1 * c1, vec4<f32>(0.0), vec4<f32>(1.0));
        c2 = clamp(b2 + c2 - b2 * c2, vec4<f32>(0.0), vec4<f32>(1.0));
        c3 = clamp(b3 + c3 - b3 * c3, vec4<f32>(0.0), vec4<f32>(1.0));
    }

    let op_cnt = chain_yuv_u.op_count;
    if (op_cnt != 0u) {
        let inv_d = chain_yuv_u.stage_inv_dims;
        let uv_y = (f32(py) + 0.5) * inv_d.y;
        let uv0 = vec2<f32>((f32(px + 0) + 0.5) * inv_d.x, uv_y);
        let uv1 = vec2<f32>((f32(px + 1) + 0.5) * inv_d.x, uv_y);
        let uv2 = vec2<f32>((f32(px + 2) + 0.5) * inv_d.x, uv_y);
        let uv3 = vec2<f32>((f32(px + 3) + 0.5) * inv_d.x, uv_y);
        for (var i: u32 = 0u; i < op_cnt; i = i + 1u) {
            let op = chain_yuv_u.ops[i];
            if (allow_ui && op.kind == 6u) {
                if (py >= i32(op.p0.x) && py < i32(op.p0.y)) {
                    let u0 = textureLoad(ui_overlay_tex, vec2<i32>(px + 0, py), 0);
                    let u1 = textureLoad(ui_overlay_tex, vec2<i32>(px + 1, py), 0);
                    let u2 = textureLoad(ui_overlay_tex, vec2<i32>(px + 2, py), 0);
                    let u3 = textureLoad(ui_overlay_tex, vec2<i32>(px + 3, py), 0);
                    if (u0.a > 0.0) { c0 = clamp(u0 + c0 * (1.0 - u0.a), vec4<f32>(0.0), vec4<f32>(1.0)); }
                    if (u1.a > 0.0) { c1 = clamp(u1 + c1 * (1.0 - u1.a), vec4<f32>(0.0), vec4<f32>(1.0)); }
                    if (u2.a > 0.0) { c2 = clamp(u2 + c2 * (1.0 - u2.a), vec4<f32>(0.0), vec4<f32>(1.0)); }
                    if (u3.a > 0.0) { c3 = clamp(u3 + c3 * (1.0 - u3.a), vec4<f32>(0.0), vec4<f32>(1.0)); }
                }
            } else if (op.kind == 4u) {
                let res = eval_crt_4x1(c0, c1, c2, c3, uv0.x, uv1.x, uv2.x, uv3.x, uv_y, op);
                c0 = res[0]; c1 = res[1]; c2 = res[2]; c3 = res[3];
            } else if (op.kind == 5u) {
                let res = eval_old_film_4x1(c0, c1, c2, c3, uv0.x, uv1.x, uv2.x, uv3.x, uv_y, op);
                c0 = res[0]; c1 = res[1]; c2 = res[2]; c3 = res[3];
            } else if (op.kind == 1u) {
                let a = op.p0.x;
                c0 = clamp(c0 * a, vec4<f32>(0.0), vec4<f32>(1.0));
                c1 = clamp(c1 * a, vec4<f32>(0.0), vec4<f32>(1.0));
                c2 = clamp(c2 * a, vec4<f32>(0.0), vec4<f32>(1.0));
                c3 = clamp(c3 * a, vec4<f32>(0.0), vec4<f32>(1.0));
            } else if (op.kind == 2u) {
                c0 = clamp(apply_adjustment_col(c0, op.p0, op.p1.x, op.p1.y, op.p1.z, op.p1.w), vec4<f32>(0.0), vec4<f32>(1.0));
                c1 = clamp(apply_adjustment_col(c1, op.p0, op.p1.x, op.p1.y, op.p1.z, op.p1.w), vec4<f32>(0.0), vec4<f32>(1.0));
                c2 = clamp(apply_adjustment_col(c2, op.p0, op.p1.x, op.p1.y, op.p1.z, op.p1.w), vec4<f32>(0.0), vec4<f32>(1.0));
                c3 = clamp(apply_adjustment_col(c3, op.p0, op.p1.x, op.p1.y, op.p1.z, op.p1.w), vec4<f32>(0.0), vec4<f32>(1.0));
            } else if (op.kind == 3u) {
                c0 = clamp(apply_color_overlay_col(c0, op.p0.xyz, op.p0.w), vec4<f32>(0.0), vec4<f32>(1.0));
                c1 = clamp(apply_color_overlay_col(c1, op.p0.xyz, op.p0.w), vec4<f32>(0.0), vec4<f32>(1.0));
                c2 = clamp(apply_color_overlay_col(c2, op.p0.xyz, op.p0.w), vec4<f32>(0.0), vec4<f32>(1.0));
                c3 = clamp(apply_color_overlay_col(c3, op.p0.xyz, op.p0.w), vec4<f32>(0.0), vec4<f32>(1.0));
            }
        }
    }

    if (chain_yuv_u.apply_backdrop != 0u) {
        let bd = chain_yuv_u.backdrop_clear;
        c0 = clamp(c0 + bd * (1.0 - c0.a), vec4<f32>(0.0), vec4<f32>(1.0));
        c1 = clamp(c1 + bd * (1.0 - c1.a), vec4<f32>(0.0), vec4<f32>(1.0));
        c2 = clamp(c2 + bd * (1.0 - c2.a), vec4<f32>(0.0), vec4<f32>(1.0));
        c3 = clamp(c3 + bd * (1.0 - c3.a), vec4<f32>(0.0), vec4<f32>(1.0));
    }
    if (chain_yuv_u.fade_alpha > 0.0) {
        let fc = chain_yuv_u.fade_color_premul;
        let fa = 1.0 - chain_yuv_u.fade_alpha;
        c0 = clamp(fc + c0 * fa, vec4<f32>(0.0), vec4<f32>(1.0));
        c1 = clamp(fc + c1 * fa, vec4<f32>(0.0), vec4<f32>(1.0));
        c2 = clamp(fc + c2 * fa, vec4<f32>(0.0), vec4<f32>(1.0));
        c3 = clamp(fc + c3 * fa, vec4<f32>(0.0), vec4<f32>(1.0));
    }
    return array<vec3<i32>, 4>(
        vec3<i32>(round(c0.rgb * 255.0)),
        vec3<i32>(round(c1.rgb * 255.0)),
        vec3<i32>(round(c2.rgb * 255.0)),
        vec3<i32>(round(c3.rgb * 255.0)),
    );
}

fn eval_light_post_pixel(px: i32, py: i32) -> vec3<i32> {
    var col = textureLoad(flt_tex, vec2<i32>(px, py), 0);
    let op_cnt = chain_yuv_u.op_count;
    for (var i: u32 = 0u; i < op_cnt; i = i + 1u) {
        let op = chain_yuv_u.ops[i];
        if (op.kind == 1u) {
            col = clamp(col * op.p0.x, vec4<f32>(0.0), vec4<f32>(1.0));
        } else if (op.kind == 3u) {
            col = clamp(vec4<f32>(mix(col.rgb, op.p0.xyz * col.a, op.p0.w), col.a), vec4<f32>(0.0), vec4<f32>(1.0));
        } else if (op.kind == 6u) {
            if (py >= i32(op.p0.x) && py < i32(op.p0.y)) {
                let ui = textureLoad(ui_overlay_tex, vec2<i32>(px, py), 0);
                if (ui.a > 0.0) {
                    col = clamp(ui + col * (1.0 - ui.a), vec4<f32>(0.0), vec4<f32>(1.0));
                }
            }
        }
    }
    return eval_fused_post_tail(col);
}

fn eval_fast_yuv_pixel(px: i32, py: i32) -> vec3<i32> {
    var col = textureLoad(flt_tex, vec2<i32>(px, py), 0);
    if (chain_yuv_u.apply_backdrop != 0u) {
        col = clamp(col + chain_yuv_u.backdrop_clear * (1.0 - col.a), vec4<f32>(0.0), vec4<f32>(1.0));
    }
    if (chain_yuv_u.fade_alpha > 0.0) {
        col = clamp(chain_yuv_u.fade_color_premul + col * (1.0 - chain_yuv_u.fade_alpha), vec4<f32>(0.0), vec4<f32>(1.0));
    }
    return vec3<i32>(round(col.rgb * 255.0));
}

fn bt709_y(rgb: vec3<i32>) -> u32 {
    return u32(clamp(((11966 * rgb.r + 40254 * rgb.g + 4064 * rgb.b + 32768) >> 16) + 16, 16, 235));
}

fn bt709_u(rgb_sum: vec3<i32>) -> u32 {
    return u32(clamp(((-6596 * rgb_sum.r - 22188 * rgb_sum.g + 28784 * rgb_sum.b + 131072) >> 18) + 128, 16, 240));
}

fn bt709_v(rgb_sum: vec3<i32>) -> u32 {
    return u32(clamp(((28784 * rgb_sum.r - 26145 * rgb_sum.g - 2639 * rgb_sum.b + 131072) >> 18) + 128, 16, 240));
}

fn pack_y4(p0: vec3<i32>, p1: vec3<i32>, p2: vec3<i32>, p3: vec3<i32>) -> u32 {
    return bt709_y(p0) | (bt709_y(p1) << 8u) | (bt709_y(p2) << 16u) | (bt709_y(p3) << 24u);
}

// Ultra-low-register 2D YUV420p kernel when no pointwise ops, UI overlay, or bloom glow are fused.
@compute @workgroup_size(16, 16, 1)
fn fused_post_yuv_fast_2d_cs(
    @builtin(workgroup_id) wg: vec3<u32>,
    @builtin(local_invocation_id) lid: vec3<u32>,
) {
    let px = i32(wg.x * 64u + lid.x * 4u);
    let py0 = i32(wg.y * 32u + lid.y * 2u);
    let w = i32(chain_yuv_u.width);
    let h = i32(chain_yuv_u.height);
    let in_bounds = px + 3 < w && py0 + 1 < h;

    var packed_u2: u32 = 0u;
    var packed_v2: u32 = 0u;

    if (in_bounds) {
        let p00 = eval_fast_yuv_pixel(px + 0, py0);
        let p10 = eval_fast_yuv_pixel(px + 1, py0);
        let p20 = eval_fast_yuv_pixel(px + 2, py0);
        let p30 = eval_fast_yuv_pixel(px + 3, py0);
        let y_word_stride = chain_yuv_u.width / 4u;
        let base_word_x = u32(px) / 4u;
        yuv_out[u32(py0) * y_word_stride + base_word_x] = pack_y4(p00, p10, p20, p30);
        var sum_l = p00 + p10;
        var sum_r = p20 + p30;

        let p01 = eval_fast_yuv_pixel(px + 0, py0 + 1);
        let p11 = eval_fast_yuv_pixel(px + 1, py0 + 1);
        let p21 = eval_fast_yuv_pixel(px + 2, py0 + 1);
        let p31 = eval_fast_yuv_pixel(px + 3, py0 + 1);
        yuv_out[u32(py0 + 1) * y_word_stride + base_word_x] = pack_y4(p01, p11, p21, p31);

        sum_l += p01 + p11;
        sum_r += p21 + p31;
        packed_u2 = bt709_u(sum_l) | (bt709_u(sum_r) << 8u);
        packed_v2 = bt709_v(sum_l) | (bt709_v(sum_r) << 8u);
    }

    let lidx = lid.y * 16u + lid.x;
    sh_u[lidx] = packed_u2;
    sh_v[lidx] = packed_v2;
    workgroupBarrier();

    if ((lid.x & 1u) == 0u) {
        let cx = u32(px) / 2u;
        let cy = u32(py0) / 2u;
        let cw = chain_yuv_u.width / 2u;
        let ch = chain_yuv_u.height / 2u;
        if (cx + 3u < cw && cy < ch) {
            let uv_word_idx = cy * (cw / 4u) + (cx / 4u);
            yuv_out[chain_yuv_u.y_words + uv_word_idx] = sh_u[lidx] | (sh_u[lidx + 1u] << 16u);
            yuv_out[chain_yuv_u.y_words + chain_yuv_u.uv_words + uv_word_idx] = sh_v[lidx] | (sh_v[lidx + 1u] << 16u);
        }
    }
}

fn pack_pair_sum_u32(s: vec3<i32>) -> u32 {
    return u32(s.r) | (u32(s.g) << 10u) | (u32(s.b) << 20u);
}

fn unpack_pair_sum_u32(v: u32) -> vec3<i32> {
    return vec3<i32>(i32(v & 0x3FFu), i32((v >> 10u) & 0x3FFu), i32((v >> 20u) & 0x3FFu));
}

fn finish_4x1_chroma(lid: vec3<u32>, px: i32, py: i32, sum_l: vec3<i32>, sum_r: vec3<i32>, in_bounds: bool) {
    let lidx = lid.y * 16u + lid.x;
    sh_u[lidx] = select(0u, pack_pair_sum_u32(sum_l), in_bounds);
    sh_v[lidx] = select(0u, pack_pair_sum_u32(sum_r), in_bounds);
    workgroupBarrier();

    if ((lid.x & 1u) == 0u && (lid.y & 1u) == 0u) {
        let cx = u32(px) / 2u;
        let cy = u32(py) / 2u;
        let cw = chain_yuv_u.width / 2u;
        let ch = chain_yuv_u.height / 2u;
        if (cx + 3u < cw && cy < ch) {
            let c0 = unpack_pair_sum_u32(sh_u[lidx]) + unpack_pair_sum_u32(sh_u[lidx + 16u]);
            let c1 = unpack_pair_sum_u32(sh_v[lidx]) + unpack_pair_sum_u32(sh_v[lidx + 16u]);
            let c2 = unpack_pair_sum_u32(sh_u[lidx + 1u]) + unpack_pair_sum_u32(sh_u[lidx + 17u]);
            let c3 = unpack_pair_sum_u32(sh_v[lidx + 1u]) + unpack_pair_sum_u32(sh_v[lidx + 17u]);
            let uv_word_idx = cy * (cw / 4u) + (cx / 4u);
            yuv_out[chain_yuv_u.y_words + uv_word_idx] =
                bt709_u(c0) | (bt709_u(c1) << 8u) | (bt709_u(c2) << 16u) | (bt709_u(c3) << 24u);
            yuv_out[chain_yuv_u.y_words + chain_yuv_u.uv_words + uv_word_idx] =
                bt709_v(c0) | (bt709_v(c1) << 8u) | (bt709_v(c2) << 16u) | (bt709_v(c3) << 24u);
        }
    }
}

// 4x1 low-register kernel (64x16 tile, 8100 WGs) for light pointwise ops (Alpha/ColorOverlay/UI) + YUV420p.
@compute @workgroup_size(16, 16, 1)
fn fused_post_yuv_light_2d_cs(
    @builtin(workgroup_id) wg: vec3<u32>,
    @builtin(local_invocation_id) lid: vec3<u32>,
) {
    let px = i32(wg.x * 64u + lid.x * 4u);
    let py = i32(wg.y * 16u + lid.y);
    let w = i32(chain_yuv_u.width);
    let h = i32(chain_yuv_u.height);
    let in_bounds = px + 3 < w && py < h;

    var sum_l = vec3<i32>(0);
    var sum_r = vec3<i32>(0);
    if (in_bounds) {
        let p0 = eval_light_post_pixel(px + 0, py);
        let p1 = eval_light_post_pixel(px + 1, py);
        let p2 = eval_light_post_pixel(px + 2, py);
        let p3 = eval_light_post_pixel(px + 3, py);
        let y_word_stride = chain_yuv_u.width / 4u;
        let base_word_x = u32(px) / 4u;
        yuv_out[u32(py) * y_word_stride + base_word_x] = pack_y4(p0, p1, p2, p3);
        sum_l = p0 + p1;
        sum_r = p2 + p3;
    }
    finish_4x1_chroma(lid, px, py, sum_l, sum_r, in_bounds);
}

// 4x1 macro-tiled kernel (64x16 tile, 8100 WGs, no UI lookup) for pointwise/bloom + YUV420p.
@compute @workgroup_size(16, 16, 1)
fn fused_post_yuv_noui_2d_cs(
    @builtin(workgroup_id) wg: vec3<u32>,
    @builtin(local_invocation_id) lid: vec3<u32>,
) {
    let px = i32(wg.x * 64u + lid.x * 4u);
    let py = i32(wg.y * 16u + lid.y);
    let in_bounds = px + 3 < i32(chain_yuv_u.width) && py < i32(chain_yuv_u.height);
    var sum_l = vec3<i32>(0);
    var sum_r = vec3<i32>(0);
    if (in_bounds) {
        let p = eval_fused_post_4x1(px, py, false);
        let y_word_stride = chain_yuv_u.width / 4u;
        let base_word_x = u32(px) / 4u;
        yuv_out[u32(py) * y_word_stride + base_word_x] = pack_y4(p[0], p[1], p[2], p[3]);
        sum_l = p[0] + p[1];
        sum_r = p[2] + p[3];
    }
    finish_4x1_chroma(lid, px, py, sum_l, sum_r, in_bounds);
}

// 4x1 macro-tiled kernel (64x16 tile, 8100 WGs) with fused UI overlay + pointwise ops + bloom + YUV420p.
@compute @workgroup_size(16, 16, 1)
fn fused_post_yuv_2d_cs(
    @builtin(workgroup_id) wg: vec3<u32>,
    @builtin(local_invocation_id) lid: vec3<u32>,
) {
    let px = i32(wg.x * 64u + lid.x * 4u);
    let py = i32(wg.y * 16u + lid.y);
    let in_bounds = px + 3 < i32(chain_yuv_u.width) && py < i32(chain_yuv_u.height);
    var sum_l = vec3<i32>(0);
    var sum_r = vec3<i32>(0);
    if (in_bounds) {
        let p = eval_fused_post_4x1(px, py, true);
        let y_word_stride = chain_yuv_u.width / 4u;
        let base_word_x = u32(px) / 4u;
        yuv_out[u32(py) * y_word_stride + base_word_x] = pack_y4(p[0], p[1], p[2], p[3]);
        sum_l = p[0] + p[1];
        sum_r = p[2] + p[3];
    }
    finish_4x1_chroma(lid, px, py, sum_l, sum_r, in_bounds);
}

// Generic 1D fallback for arbitrary even dimensions not aligned to 8px horizontally.
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
            packed = packed | (bt709_y(rgb) << (i * 8u));
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
            packed_u = packed_u | (bt709_u(rgb_sum) << (i * 8u));
            packed_v = packed_v | (bt709_v(rgb_sum) << (i * 8u));
        }
    }
    yuv_out[yuv_u.y_words + u_word] = packed_u;
    yuv_out[yuv_u.y_words + yuv_u.uv_words + u_word] = packed_v;
}
