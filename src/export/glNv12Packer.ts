import { computeStageFitLayout, type StageFitLayout } from './presets'

export function rgbToBt709LimitedY(r: number, g: number, b: number): number {
  const luma: number = 0.2126 * r + 0.7152 * g + 0.0722 * b
  const y: number = (16 + 219 * luma) / 255
  return Math.min(235 / 255, Math.max(16 / 255, y))
}

export function rgbToBt709LimitedUv(r: number, g: number, b: number): [number, number] {
  const luma: number = 0.2126 * r + 0.7152 * g + 0.0722 * b
  const cb: number = (b - luma) / (2 * (1 - 0.0722))
  const cr: number = (r - luma) / (2 * (1 - 0.2126))
  const u: number = Math.min(240 / 255, Math.max(16 / 255, (128 + 224 * cb) / 255))
  const v: number = Math.min(240 / 255, Math.max(16 / 255, (128 + 224 * cr) / 255))
  return [u, v]
}

const VERTEX_SHADER_SOURCE: string = `#version 300 es
in vec2 aPosition;
void main() {
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
`

const FULL_STAGE_VERTEX_SHADER_SOURCE: string = `#version 300 es
precision highp float;
in vec2 aPosition;
uniform int uFlipY;
out highp vec2 vUv;
void main() {
  float v = aPosition.y * 0.5 + 0.5;
  vUv = vec2(aPosition.x * 0.5 + 0.5, uFlipY == 1 ? (1.0 - v) : v);
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
`

const NV12_Y_FRAGMENT_SHADER_SOURCE: string = `#version 300 es
precision mediump float;

uniform sampler2D uSource;
uniform highp float uStepX;
in highp vec2 vUv;
out vec4 fragColor;

const vec3 Y_WEIGHTS = vec3(0.2126, 0.7152, 0.0722) * (219.0 / 255.0);
const float Y_BIAS = 16.0 / 255.0;
const float Y_MIN = 16.0 / 255.0;
const float Y_MAX = 235.0 / 255.0;

void main() {
  highp float baseU = vUv.x - 1.5 * uStepX;
  vec3 c0 = texture(uSource, vec2(baseU, vUv.y)).rgb;
  vec3 c1 = texture(uSource, vec2(baseU + uStepX, vUv.y)).rgb;
  vec3 c2 = texture(uSource, vec2(baseU + 2.0 * uStepX, vUv.y)).rgb;
  vec3 c3 = texture(uSource, vec2(baseU + 3.0 * uStepX, vUv.y)).rgb;
  fragColor = clamp(
    vec4(
      dot(c0, Y_WEIGHTS) + Y_BIAS,
      dot(c1, Y_WEIGHTS) + Y_BIAS,
      dot(c2, Y_WEIGHTS) + Y_BIAS,
      dot(c3, Y_WEIGHTS) + Y_BIAS
    ),
    Y_MIN,
    Y_MAX
  );
}
`

const NV12_UV_FRAGMENT_SHADER_SOURCE: string = `#version 300 es
precision mediump float;

uniform sampler2D uSource;
uniform highp float uStepX;
in highp vec2 vUv;
out vec4 fragColor;

const vec3 Y_WEIGHTS = vec3(0.2126, 0.7152, 0.0722);
const float CB_SCALE = 224.0 / (255.0 * 2.0 * (1.0 - 0.0722));
const float CR_SCALE = 224.0 / (255.0 * 2.0 * (1.0 - 0.2126));
const float UV_BIAS = 128.0 / 255.0;
const float UV_MIN = 16.0 / 255.0;
const float UV_MAX = 240.0 / 255.0;

vec2 calcUv(vec3 rgb) {
  float y = dot(rgb, Y_WEIGHTS);
  return clamp(
    vec2((rgb.b - y) * CB_SCALE + UV_BIAS, (rgb.r - y) * CR_SCALE + UV_BIAS),
    UV_MIN,
    UV_MAX
  );
}

void main() {
  vec3 a = texture(uSource, vec2(vUv.x - uStepX, vUv.y)).rgb;
  vec3 b = texture(uSource, vec2(vUv.x + uStepX, vUv.y)).rgb;
  fragColor = vec4(calcUv(a), calcUv(b));
}
`

// Uses hardware GL_LINEAR filtering on the source texture so a single midpoint tap at
// (baseX + 1.0, py0 + 1.0) computes an exact 2x2 block average for 4:2:0 chroma subsampling
// while integer+0.5 centers yield exact 1:1 texels for full-resolution luma.
const NV12_FRAGMENT_SHADER_SOURCE: string = `#version 300 es
precision highp float;

uniform sampler2D uSource;
uniform ivec2 uOutputSize;
uniform ivec4 uStageRect;
uniform int uFlipY;

out vec4 fragColor;

vec2 toStageUv(float relX, float relY) {
  float u = relX / float(uStageRect.z);
  float v = relY / float(uStageRect.w);
  if (uFlipY == 1) {
    v = 1.0 - v;
  }
  return vec2(u, v);
}

vec3 sampleStagePixel(int px, int py) {
  int relX = px - uStageRect.x;
  int relY = py - uStageRect.y;
  if (relX < 0 || relY < 0 || relX >= uStageRect.z || relY >= uStageRect.w) {
    return vec3(0.0);
  }
  return texture(uSource, toStageUv(float(relX) + 0.5, float(relY) + 0.5)).rgb;
}

vec3 sampleStage2x2Average(int px0, int py0) {
  int relX = px0 - uStageRect.x;
  int relY = py0 - uStageRect.y;
  if (relX >= 0 && relY >= 0 && relX + 1 < uStageRect.z && relY + 1 < uStageRect.w) {
    return texture(uSource, toStageUv(float(relX) + 1.0, float(relY) + 1.0)).rgb;
  }
  return 0.25 * (
    sampleStagePixel(px0, py0) +
    sampleStagePixel(px0 + 1, py0) +
    sampleStagePixel(px0, py0 + 1) +
    sampleStagePixel(px0 + 1, py0 + 1)
  );
}

float calcLuma(vec3 rgb) {
  float y = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
  return clamp((16.0 + 219.0 * y) / 255.0, 16.0 / 255.0, 235.0 / 255.0);
}

vec2 calcUv(vec3 rgb) {
  float y = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
  float cb = (rgb.b - y) / (2.0 * (1.0 - 0.0722));
  float cr = (rgb.r - y) / (2.0 * (1.0 - 0.2126));
  float u = clamp((128.0 + 224.0 * cb) / 255.0, 16.0 / 255.0, 240.0 / 255.0);
  float v = clamp((128.0 + 224.0 * cr) / 255.0, 16.0 / 255.0, 240.0 / 255.0);
  return vec2(u, v);
}

void main() {
  int fboX = int(gl_FragCoord.x);
  int fboY = int(gl_FragCoord.y);
  int height = uOutputSize.y;

  if (fboY < height) {
    int baseX = fboX * 4;
    float y0 = calcLuma(sampleStagePixel(baseX, fboY));
    float y1 = calcLuma(sampleStagePixel(baseX + 1, fboY));
    float y2 = calcLuma(sampleStagePixel(baseX + 2, fboY));
    float y3 = calcLuma(sampleStagePixel(baseX + 3, fboY));
    fragColor = vec4(y0, y1, y2, y3);
    return;
  }

  int uvRow = fboY - height;
  int py0 = uvRow * 2;
  int baseX = fboX * 4;

  vec2 uv0 = calcUv(sampleStage2x2Average(baseX, py0));
  vec2 uv1 = calcUv(sampleStage2x2Average(baseX + 2, py0));
  fragColor = vec4(uv0.x, uv0.y, uv1.x, uv1.y);
}
`

const RGBA_FRAGMENT_SHADER_SOURCE: string = `#version 300 es
precision highp float;

uniform sampler2D uSource;
uniform ivec4 uStageRect;
uniform int uUnpremultiply;
uniform int uFlipY;

out vec4 fragColor;

void main() {
  int px = int(gl_FragCoord.x);
  int py = int(gl_FragCoord.y);
  int relX = px - uStageRect.x;
  int relY = py - uStageRect.y;
  if (relX < 0 || relY < 0 || relX >= uStageRect.z || relY >= uStageRect.w) {
    fragColor = uUnpremultiply == 1 ? vec4(0.0) : vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }
  float v = (float(relY) + 0.5) / float(uStageRect.w);
  if (uFlipY == 1) {
    v = 1.0 - v;
  }
  vec2 uv = vec2((float(relX) + 0.5) / float(uStageRect.z), v);
  vec4 texel = texture(uSource, uv);
  if (uUnpremultiply == 1 && texel.a > 0.0) {
    texel.rgb = clamp(texel.rgb / texel.a, 0.0, 1.0);
  }
  fragColor = texel;
}
`

const PBO_RING_BUDGET_BYTES: number = 420 * 1024 * 1024
const PBO_GROUP_BUDGET_BYTES: number = 50 * 1024 * 1024
const MIN_PBO_SLOT_COUNT: number = 6
const MAX_PBO_SLOT_COUNT: number = 32
const MAX_PBO_GROUP_FRAMES: number = 8

export function computeOptimalPboSlotCount(frameBytes: number): number {
  if (!Number.isFinite(frameBytes) || frameBytes <= 0) {
    return MIN_PBO_SLOT_COUNT
  }
  // Subtract 1 because the ring allocates slotCount + 1 buffers so one can receive
  // the current readPixels while older transfers finish asynchronously in GPUProcess.
  const maxBuffersInBudget: number = Math.floor(PBO_RING_BUDGET_BYTES / frameBytes) - 1
  return Math.max(MIN_PBO_SLOT_COUNT, Math.min(MAX_PBO_SLOT_COUNT, maxBuffersInBudget))
}

export function computeOptimalPboGroupFrames(
  frameBytes: number,
  maxGroupBytes: number = PBO_GROUP_BUDGET_BYTES
): number {
  if (
    !Number.isFinite(frameBytes) ||
    frameBytes <= 0 ||
    !Number.isFinite(maxGroupBytes) ||
    maxGroupBytes <= 0
  ) {
    return 1
  }
  const maxFramesInGroup: number = Math.floor(maxGroupBytes / frameBytes)
  return Math.max(1, Math.min(MAX_PBO_GROUP_FRAMES, maxFramesInGroup))
}

export type GlPackerDestinationSlice = {
  buffer: Uint8Array
  byteOffset: number
}

type PendingPboBatch = {
  pboIndex: number
  frameCount: number
}

export type GlFramePackerOptions = {
  sharedGl?: WebGL2RenderingContext
  resetExternalState?: () => void
  flipTextureY?: boolean
}

export class GlFramePacker {
  readonly pixelFormat: 'nv12' | 'rgba'
  readonly frameBytes: number
  readonly batchGroupFrames: number
  readonly sharedContext: boolean
  private readonly width: number
  private readonly height: number
  private readonly fboWidth: number
  private readonly fboHeight: number
  private readonly layout: StageFitLayout
  private readonly transparentAlpha: boolean
  private readonly flipTextureY: boolean
  private readonly pboSlotCount: number
  private readonly gl: WebGL2RenderingContext
  private readonly resetExternalState?: () => void
  private readonly program: WebGLProgram
  private readonly uvProgram: WebGLProgram | null
  private readonly ownedSourceTexture: WebGLTexture | null
  private readonly outputTexture: WebGLTexture
  private readonly framebuffer: WebGLFramebuffer
  private readonly quadVao: WebGLVertexArrayObject
  private readonly quadVbo: WebGLBuffer
  private readonly pboRing: WebGLBuffer[]
  private readonly pendingBatches: PendingPboBatch[] = []
  private readonly stagingBuffer: Uint8Array
  private configuredExternalTexture: WebGLTexture | null = null
  private activeWritePboIndex: number = 0
  private activeWriteFrameCount: number = 0
  private totalPendingFrames: number = 0
  private sourceTextureInitialized: boolean = false
  private sourceTexWidth: number = 0
  private sourceTexHeight: number = 0
  private disposed: boolean = false

  constructor(
    width: number,
    height: number,
    transparentAlpha: boolean,
    options?: GlFramePackerOptions
  ) {
    this.width = width
    this.height = height
    this.transparentAlpha = transparentAlpha
    this.flipTextureY = options?.flipTextureY ?? false
    this.layout = computeStageFitLayout(width, height)

    // NV12 packs 4 bytes per RGBA texel so width must be divisible by 4;
    // alpha mode and non-multiple-of-4 widths stream straight RGBA instead.
    this.pixelFormat = !transparentAlpha && width % 4 === 0 ? 'nv12' : 'rgba'
    this.fboWidth = this.pixelFormat === 'nv12' ? width / 4 : width
    this.fboHeight = this.pixelFormat === 'nv12' ? height + height / 2 : height
    this.frameBytes = this.pixelFormat === 'nv12' ? (width * height * 3) / 2 : width * height * 4
    this.batchGroupFrames = computeOptimalPboGroupFrames(this.frameBytes)
    const baseSlotCount: number = computeOptimalPboSlotCount(this.frameBytes)
    const inFlightBatches: number = Math.max(2, Math.ceil(baseSlotCount / this.batchGroupFrames))
    this.pboSlotCount = inFlightBatches * this.batchGroupFrames
    this.stagingBuffer = new Uint8Array(this.batchGroupFrames * this.frameBytes)

    let gl: WebGL2RenderingContext | null = options?.sharedGl ?? null
    if (gl) {
      this.sharedContext = true
      this.resetExternalState = options?.resetExternalState
    } else {
      this.sharedContext = false
      const canvas: HTMLCanvasElement = document.createElement('canvas')
      canvas.width = 4
      canvas.height = 4
      gl = canvas.getContext('webgl2', {
        alpha: transparentAlpha,
        antialias: false,
        depth: false,
        stencil: false,
        preserveDrawingBuffer: false,
        powerPreference: 'high-performance'
      })
    }
    if (!gl) {
      throw new Error('当前环境不支持 WebGL2，无法启用 GPU 帧转换与异步 PBO 回读')
    }
    this.gl = gl

    const isFullStage: boolean =
      this.layout.offsetX === 0 &&
      this.layout.offsetY === 0 &&
      this.layout.renderedWidth === width &&
      this.layout.renderedHeight === height

    if (this.pixelFormat === 'nv12' && isFullStage) {
      // Branchless two-pass Y + UV pack eliminates per-pixel bounds/plane branches when stage
      // fills the output frame without letterboxing or pillarboxing.
      this.program = createShaderProgram(
        gl,
        FULL_STAGE_VERTEX_SHADER_SOURCE,
        NV12_Y_FRAGMENT_SHADER_SOURCE
      )
      this.uvProgram = createShaderProgram(
        gl,
        FULL_STAGE_VERTEX_SHADER_SOURCE,
        NV12_UV_FRAGMENT_SHADER_SOURCE
      )
      const stepX: number = 1 / this.width
      const flipFlag: number = this.flipTextureY ? 1 : 0
      for (const prog of [this.program, this.uvProgram]) {
        gl.useProgram(prog)
        gl.uniform1i(gl.getUniformLocation(prog, 'uSource'), 0)
        gl.uniform1f(gl.getUniformLocation(prog, 'uStepX'), stepX)
        gl.uniform1i(gl.getUniformLocation(prog, 'uFlipY'), flipFlag)
      }
    } else {
      const fragSource: string =
        this.pixelFormat === 'nv12' ? NV12_FRAGMENT_SHADER_SOURCE : RGBA_FRAGMENT_SHADER_SOURCE
      this.program = createShaderProgram(gl, VERTEX_SHADER_SOURCE, fragSource)
      this.uvProgram = null
      gl.useProgram(this.program)
      gl.uniform1i(gl.getUniformLocation(this.program, 'uSource'), 0)
      gl.uniform4i(
        gl.getUniformLocation(this.program, 'uStageRect'),
        this.layout.offsetX,
        this.layout.offsetY,
        this.layout.renderedWidth,
        this.layout.renderedHeight
      )
      gl.uniform1i(gl.getUniformLocation(this.program, 'uFlipY'), this.flipTextureY ? 1 : 0)
      if (this.pixelFormat === 'nv12') {
        gl.uniform2i(gl.getUniformLocation(this.program, 'uOutputSize'), this.width, this.height)
      } else {
        gl.uniform1i(
          gl.getUniformLocation(this.program, 'uUnpremultiply'),
          this.transparentAlpha ? 1 : 0
        )
      }
    }
    gl.useProgram(null)
    gl.pixelStorei(gl.PACK_ALIGNMENT, 1)

    const ownedSrcTex: WebGLTexture | null = this.sharedContext ? null : gl.createTexture()
    const outTex: WebGLTexture | null = gl.createTexture()
    const fbo: WebGLFramebuffer | null = gl.createFramebuffer()
    const vao: WebGLVertexArrayObject | null = gl.createVertexArray()
    const vbo: WebGLBuffer | null = gl.createBuffer()
    if ((!this.sharedContext && !ownedSrcTex) || !outTex || !fbo || !vao || !vbo) {
      throw new Error('创建 WebGL2 NV12 管线资源失败')
    }

    this.ownedSourceTexture = ownedSrcTex
    this.outputTexture = outTex
    this.framebuffer = fbo
    this.quadVao = vao
    this.quadVbo = vbo

    gl.bindVertexArray(this.quadVao)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadVbo)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
    const positionLoc: number = gl.getAttribLocation(this.program, 'aPosition')
    gl.enableVertexAttribArray(positionLoc)
    gl.vertexAttribPointer(positionLoc, 2, gl.FLOAT, false, 0, 0)
    gl.bindVertexArray(null)

    if (this.ownedSourceTexture) {
      configureSourceTextureSampling(gl, this.ownedSourceTexture)
    }

    gl.bindTexture(gl.TEXTURE_2D, this.outputTexture)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA8,
      this.fboWidth,
      this.fboHeight,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      null
    )

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer)
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      this.outputTexture,
      0
    )
    const status: number = gl.checkFramebufferStatus(gl.FRAMEBUFFER)
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error(`WebGL2 帧缓存状态异常: ${status}`)
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)

    this.pboRing = []
    // Allocate one extra grouped PBO beyond max in-flight batches so the GPU can write
    // into the active batch PBO while older completed batches drain asynchronously via IPC.
    const totalPboBuffers: number = Math.ceil(this.pboSlotCount / this.batchGroupFrames) + 1
    const pboByteLength: number = this.batchGroupFrames * this.frameBytes
    for (let i = 0; i < totalPboBuffers; i += 1) {
      const pbo: WebGLBuffer | null = gl.createBuffer()
      if (!pbo) throw new Error('创建 WebGL2 PBO 缓冲区失败')
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo)
      gl.bufferData(gl.PIXEL_PACK_BUFFER, pboByteLength, gl.STREAM_READ)
      this.pboRing.push(pbo)
    }
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null)
    this.resetExternalState?.()
  }

  async pushCanvas(
    sourceCanvas: HTMLCanvasElement,
    onFrameReady: (frameData: Uint8Array) => Promise<void> | void
  ): Promise<void> {
    await this.pushCanvasBatchDirect(
      sourceCanvas,
      (): Uint8Array => this.stagingBuffer,
      async (frameCount: number): Promise<void> => {
        for (let i = 0; i < frameCount; i += 1) {
          const offset: number = i * this.frameBytes
          await onFrameReady(this.stagingBuffer.subarray(offset, offset + this.frameBytes))
        }
      }
    )
  }

  async pushCanvasDirect(
    sourceCanvas: HTMLCanvasElement,
    getDestinationSlice: () => GlPackerDestinationSlice,
    onFrameWritten: () => Promise<void> | void
  ): Promise<void> {
    if (this.disposed) return

    this.enqueueCanvasSource(sourceCanvas)
    await this.drainCompletedBatchesToSlices(getDestinationSlice, onFrameWritten)
  }

  async pushTextureDirect(
    sourceTexture: WebGLTexture,
    getDestinationSlice: () => GlPackerDestinationSlice,
    onFrameWritten: () => Promise<void> | void
  ): Promise<void> {
    if (this.disposed) return

    this.enqueueTextureSource(sourceTexture)
    await this.drainCompletedBatchesToSlices(getDestinationSlice, onFrameWritten)
  }

  async pushCanvasBatchDirect(
    sourceCanvas: HTMLCanvasElement,
    getBatchDestination: () => Uint8Array,
    onBatchWritten: (frameCount: number) => Promise<void> | void
  ): Promise<void> {
    if (this.disposed) return

    this.enqueueCanvasSource(sourceCanvas)

    while (this.totalPendingFrames > this.pboSlotCount && this.pendingBatches.length > 0) {
      const drainedFrames: number = this.popOldestBatchInto(getBatchDestination())
      if (drainedFrames > 0) {
        await onBatchWritten(drainedFrames)
      }
    }
  }

  async pushTextureBatchDirect(
    sourceTexture: WebGLTexture,
    getBatchDestination: () => Uint8Array,
    onBatchWritten: (frameCount: number) => Promise<void> | void
  ): Promise<void> {
    if (this.disposed) return

    this.enqueueTextureSource(sourceTexture)

    while (this.totalPendingFrames > this.pboSlotCount && this.pendingBatches.length > 0) {
      const drainedFrames: number = this.popOldestBatchInto(getBatchDestination())
      if (drainedFrames > 0) {
        await onBatchWritten(drainedFrames)
      }
    }
  }

  async flush(onFrameReady: (frameData: Uint8Array) => Promise<void> | void): Promise<void> {
    await this.flushBatchDirect(
      (): Uint8Array => this.stagingBuffer,
      async (frameCount: number): Promise<void> => {
        for (let i = 0; i < frameCount; i += 1) {
          const offset: number = i * this.frameBytes
          await onFrameReady(this.stagingBuffer.subarray(offset, offset + this.frameBytes))
        }
      }
    )
  }

  async flushDirect(
    getDestinationSlice: () => GlPackerDestinationSlice,
    onFrameWritten: () => Promise<void> | void
  ): Promise<void> {
    this.finalizePartialWriteBatch()
    while (this.pendingBatches.length > 0 && !this.disposed) {
      const drainedFrames: number = this.popOldestBatchInto(this.stagingBuffer)
      for (let i = 0; i < drainedFrames; i += 1) {
        const destination: GlPackerDestinationSlice = getDestinationSlice()
        const srcOffset: number = i * this.frameBytes
        destination.buffer.set(
          this.stagingBuffer.subarray(srcOffset, srcOffset + this.frameBytes),
          destination.byteOffset
        )
        await onFrameWritten()
      }
    }
  }

  async flushBatchDirect(
    getBatchDestination: () => Uint8Array,
    onBatchWritten: (frameCount: number) => Promise<void> | void
  ): Promise<void> {
    this.finalizePartialWriteBatch()
    while (this.pendingBatches.length > 0 && !this.disposed) {
      const drainedFrames: number = this.popOldestBatchInto(getBatchDestination())
      if (drainedFrames > 0) {
        await onBatchWritten(drainedFrames)
      }
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true

    const gl: WebGL2RenderingContext = this.gl
    this.pendingBatches.length = 0
    this.activeWriteFrameCount = 0
    this.totalPendingFrames = 0

    for (const pbo of this.pboRing) {
      gl.deleteBuffer(pbo)
    }
    gl.deleteBuffer(this.quadVbo)
    gl.deleteVertexArray(this.quadVao)
    gl.deleteFramebuffer(this.framebuffer)
    if (this.ownedSourceTexture) {
      gl.deleteTexture(this.ownedSourceTexture)
    }
    gl.deleteTexture(this.outputTexture)
    gl.deleteProgram(this.program)
    if (this.uvProgram) {
      gl.deleteProgram(this.uvProgram)
    }

    if (!this.sharedContext) {
      const loseExt: WEBGL_lose_context | null = gl.getExtension('WEBGL_lose_context')
      loseExt?.loseContext()
    } else {
      this.resetExternalState?.()
    }
  }

  private enqueueCanvasSource(sourceCanvas: HTMLCanvasElement): void {
    const gl: WebGL2RenderingContext = this.gl
    const targetTexture: WebGLTexture | null = this.ownedSourceTexture
    if (!targetTexture) {
      throw new Error('共享 WebGL2 打包器未初始化上传纹理')
    }

    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, targetTexture)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0)
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0)
    if (
      !this.sourceTextureInitialized ||
      this.sourceTexWidth !== sourceCanvas.width ||
      this.sourceTexHeight !== sourceCanvas.height
    ) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, sourceCanvas)
      this.sourceTextureInitialized = true
      this.sourceTexWidth = sourceCanvas.width
      this.sourceTexHeight = sourceCanvas.height
    } else {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, sourceCanvas)
    }

    this.packBoundTexture()
  }

  private enqueueTextureSource(sourceTexture: WebGLTexture): void {
    const gl: WebGL2RenderingContext = this.gl
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, sourceTexture)
    if (this.configuredExternalTexture !== sourceTexture) {
      configureSourceTextureSampling(gl, sourceTexture)
      this.configuredExternalTexture = sourceTexture
    }

    this.packBoundTexture()
  }

  private packBoundTexture(): void {
    const gl: WebGL2RenderingContext = this.gl

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer)
    gl.disable(gl.BLEND)
    gl.disable(gl.SCISSOR_TEST)
    gl.disable(gl.DEPTH_TEST)
    gl.disable(gl.STENCIL_TEST)
    gl.disable(gl.CULL_FACE)
    gl.colorMask(true, true, true, true)
    // Invalidate previous FBO contents via clear before drawing so Apple Silicon Metal TBDR
    // starts the render pass with MTLLoadActionClear instead of reloading prior tile data.
    gl.viewport(0, 0, this.fboWidth, this.fboHeight)
    gl.clear(gl.COLOR_BUFFER_BIT)

    gl.bindVertexArray(this.quadVao)
    if (this.uvProgram) {
      gl.viewport(0, 0, this.fboWidth, this.height)
      gl.useProgram(this.program)
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)

      gl.viewport(0, this.height, this.fboWidth, this.height / 2)
      gl.useProgram(this.uvProgram)
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    } else {
      gl.useProgram(this.program)
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    }
    gl.bindVertexArray(null)

    const pboIndex: number = this.activeWritePboIndex
    const pboByteOffset: number = this.activeWriteFrameCount * this.frameBytes

    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pboRing[pboIndex])
    gl.readPixels(0, 0, this.fboWidth, this.fboHeight, gl.RGBA, gl.UNSIGNED_BYTE, pboByteOffset)
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    if (this.sharedContext) {
      // Pixi v8 GlRenderTargetAdaptor caches viewport across renderer.resetState();
      // restore the stage render target viewport so subsequent frames are not clipped to fboWidth.
      gl.viewport(0, 0, this.layout.renderedWidth, this.layout.renderedHeight)
    }

    // Group multiple frames into each PBO so getBufferSubData drains up to batchGroupFrames at
    // once, slashing synchronous WebKit GPUProcess IPC round-trips while keeping ring async.
    this.activeWriteFrameCount += 1
    this.totalPendingFrames += 1
    if (this.activeWriteFrameCount >= this.batchGroupFrames) {
      this.pendingBatches.push({ pboIndex, frameCount: this.activeWriteFrameCount })
      this.activeWritePboIndex = (pboIndex + 1) % this.pboRing.length
      this.activeWriteFrameCount = 0
    }
    this.resetExternalState?.()
  }

  private async drainCompletedBatchesToSlices(
    getDestinationSlice: () => GlPackerDestinationSlice,
    onFrameWritten: () => Promise<void> | void
  ): Promise<void> {
    while (this.totalPendingFrames > this.pboSlotCount && this.pendingBatches.length > 0) {
      const drainedFrames: number = this.popOldestBatchInto(this.stagingBuffer)
      for (let i = 0; i < drainedFrames; i += 1) {
        const destination: GlPackerDestinationSlice = getDestinationSlice()
        const srcOffset: number = i * this.frameBytes
        destination.buffer.set(
          this.stagingBuffer.subarray(srcOffset, srcOffset + this.frameBytes),
          destination.byteOffset
        )
        await onFrameWritten()
      }
    }
  }

  private finalizePartialWriteBatch(): void {
    if (this.activeWriteFrameCount <= 0) return
    const pboIndex: number = this.activeWritePboIndex
    this.pendingBatches.push({ pboIndex, frameCount: this.activeWriteFrameCount })
    this.activeWritePboIndex = (pboIndex + 1) % this.pboRing.length
    this.activeWriteFrameCount = 0
  }

  private popOldestBatchInto(destinationBuffer: Uint8Array): number {
    const batch: PendingPboBatch | undefined = this.pendingBatches.shift()
    if (!batch || this.disposed) return 0

    const byteLength: number = batch.frameCount * this.frameBytes
    const gl: WebGL2RenderingContext = this.gl
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pboRing[batch.pboIndex])
    gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, destinationBuffer, 0, byteLength)
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null)
    this.totalPendingFrames -= batch.frameCount
    return batch.frameCount
  }
}

function configureSourceTextureSampling(gl: WebGL2RenderingContext, texture: WebGLTexture): void {
  gl.bindTexture(gl.TEXTURE_2D, texture)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
}

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader: WebGLShader | null = gl.createShader(type)
  if (!shader) {
    throw new Error('创建 WebGL2 着色器对象失败')
  }
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log: string = gl.getShaderInfoLog(shader) ?? 'unknown shader error'
    gl.deleteShader(shader)
    throw new Error(`编译 WebGL2 着色器失败: ${log}`)
  }
  return shader
}

function createShaderProgram(
  gl: WebGL2RenderingContext,
  vertexSource: string,
  fragmentSource: string
): WebGLProgram {
  const vert: WebGLShader = compileShader(gl, gl.VERTEX_SHADER, vertexSource)
  const frag: WebGLShader = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource)
  const program: WebGLProgram | null = gl.createProgram()
  if (!program) {
    gl.deleteShader(vert)
    gl.deleteShader(frag)
    throw new Error('创建 WebGL2 着色器程序失败')
  }
  gl.attachShader(program, vert)
  gl.attachShader(program, frag)
  gl.bindAttribLocation(program, 0, 'aPosition')
  gl.linkProgram(program)
  gl.deleteShader(vert)
  gl.deleteShader(frag)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log: string = gl.getProgramInfoLog(program) ?? 'unknown link error'
    gl.deleteProgram(program)
    throw new Error(`链接 WebGL2 着色器程序失败: ${log}`)
  }
  return program
}
