type AnyWebGLContext = WebGLRenderingContext | WebGL2RenderingContext

type GlStateShadow = {
  installed: boolean
  params: Map<number, unknown>
  caps: Map<number, boolean>
  tex2dBindings: Map<number, WebGLTexture | null>
  currentVao: WebGLVertexArrayObject | null
  vaoElementBuffer: Map<WebGLVertexArrayObject | null, WebGLBuffer | null>
  vaoAttribEnabled: Map<WebGLVertexArrayObject | null, Map<number, boolean>>
}

const SOFTWARE_RENDERER_PATTERN: RegExp =
  /swiftshader|llvmpipe|softpipe|microsoft basic render|software/i

let cachedIsSoftwareWebGL: boolean | null = null

/**
 * Probes once whether the current WebView/browser WebGL backend uses a software rasterizer
 * such as SwiftShader or llvmpipe.
 */
export function isSoftwareWebGLRenderer(): boolean {
  if (cachedIsSoftwareWebGL !== null) {
    return cachedIsSoftwareWebGL
  }
  if (typeof document === 'undefined') {
    cachedIsSoftwareWebGL = false
    return false
  }

  let detected: boolean = false
  try {
    const canvas: HTMLCanvasElement = document.createElement('canvas')
    canvas.width = 1
    canvas.height = 1
    const gl: AnyWebGLContext | null =
      (canvas.getContext('webgl2', {
        failIfMajorPerformanceCaveat: false
      }) as WebGL2RenderingContext | null) ??
      (canvas.getContext('webgl', {
        failIfMajorPerformanceCaveat: false
      }) as WebGLRenderingContext | null)

    if (gl) {
      const debugExt: { UNMASKED_RENDERER_WEBGL: number } | null = gl.getExtension(
        'WEBGL_debug_renderer_info'
      ) as { UNMASKED_RENDERER_WEBGL: number } | null
      const unmaskedRenderer: unknown = debugExt
        ? gl.getParameter(debugExt.UNMASKED_RENDERER_WEBGL)
        : null
      const renderer: unknown = unmaskedRenderer ?? gl.getParameter(gl.RENDERER)
      if (typeof renderer === 'string' && SOFTWARE_RENDERER_PATTERN.test(renderer)) {
        detected = true
      }
      const loseExt: { loseContext: () => void } | null = gl.getExtension('WEBGL_lose_context') as {
        loseContext: () => void
      } | null
      loseExt?.loseContext()
    }
    canvas.width = 0
    canvas.height = 0
  } catch {
    detected = false
  }

  cachedIsSoftwareWebGL = detected
  return detected
}

const SHADOWED_CONTEXTS: WeakSet<object> = new WeakSet<object>()

function cloneParamValue(value: unknown): unknown {
  if (value instanceof Int32Array) {
    return new Int32Array(value)
  }
  if (value instanceof Float32Array) {
    return new Float32Array(value)
  }
  if (Array.isArray(value)) {
    return value.slice()
  }
  return value
}

/**
 * Installs a synchronous JS shadow cache over frequently queried WebGL state on `gl`
 * so libraries such as Live2D Cubism `save()`/`restore()` do not stall the GPU command buffer.
 */
export function installWebGLStateShadowCache(gl: AnyWebGLContext | null | undefined): void {
  if (!gl || SHADOWED_CONTEXTS.has(gl)) {
    return
  }
  SHADOWED_CONTEXTS.add(gl)

  const shadow: GlStateShadow = {
    installed: true,
    params: new Map<number, unknown>(),
    caps: new Map<number, boolean>(),
    tex2dBindings: new Map<number, WebGLTexture | null>(),
    currentVao: null,
    vaoElementBuffer: new Map<WebGLVertexArrayObject | null, WebGLBuffer | null>(),
    vaoAttribEnabled: new Map<WebGLVertexArrayObject | null, Map<number, boolean>>()
  }

  const clearShadow = (): void => {
    shadow.params.clear()
    shadow.caps.clear()
    shadow.tex2dBindings.clear()
    shadow.currentVao = null
    shadow.vaoElementBuffer.clear()
    shadow.vaoAttribEnabled.clear()
  }

  const canvasElement: unknown = (gl as { canvas?: unknown }).canvas
  if (
    canvasElement &&
    typeof (canvasElement as HTMLCanvasElement).addEventListener === 'function'
  ) {
    ;(canvasElement as HTMLCanvasElement).addEventListener('webglcontextlost', clearShadow)
    ;(canvasElement as HTMLCanvasElement).addEventListener('webglcontextrestored', clearShadow)
  }

  const TRACKED_PARAMS: Set<number> = new Set<number>([
    gl.MAX_TEXTURE_SIZE,
    gl.MAX_CUBE_MAP_TEXTURE_SIZE,
    gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS,
    gl.MAX_TEXTURE_IMAGE_UNITS,
    gl.MAX_VERTEX_ATTRIBS,
    gl.MAX_VERTEX_UNIFORM_VECTORS,
    gl.MAX_FRAGMENT_UNIFORM_VECTORS,
    gl.MAX_VARYING_VECTORS,
    gl.CULL_FACE_MODE,
    gl.FRONT_FACE,
    gl.COLOR_WRITEMASK,
    gl.VIEWPORT,
    gl.SCISSOR_BOX,
    gl.BLEND_SRC_RGB,
    gl.BLEND_DST_RGB,
    gl.BLEND_SRC_ALPHA,
    gl.BLEND_DST_ALPHA,
    gl.BLEND_EQUATION_RGB,
    gl.BLEND_EQUATION_ALPHA,
    gl.DEPTH_WRITEMASK,
    gl.DEPTH_FUNC,
    gl.ACTIVE_TEXTURE,
    gl.CURRENT_PROGRAM,
    gl.ARRAY_BUFFER_BINDING,
    gl.FRAMEBUFFER_BINDING
  ])

  const TRACKED_CAPS: Set<number> = new Set<number>([
    gl.BLEND,
    gl.CULL_FACE,
    gl.SCISSOR_TEST,
    gl.STENCIL_TEST,
    gl.DEPTH_TEST
  ])

  const drawFramebufferTarget: number =
    'DRAW_FRAMEBUFFER' in gl && typeof gl.DRAW_FRAMEBUFFER === 'number'
      ? gl.DRAW_FRAMEBUFFER
      : gl.FRAMEBUFFER

  const origGetParameter: (pname: number) => unknown = gl.getParameter.bind(gl)
  const origIsEnabled: (cap: number) => boolean = gl.isEnabled.bind(gl)
  const origGetVertexAttrib: (index: number, pname: number) => unknown = gl.getVertexAttrib.bind(gl)
  const origUseProgram: (program: WebGLProgram | null) => void = gl.useProgram.bind(gl)
  const origActiveTexture: (texture: number) => void = gl.activeTexture.bind(gl)
  const origBindTexture: (target: number, texture: WebGLTexture | null) => void =
    gl.bindTexture.bind(gl)
  const origBindBuffer: (target: number, buffer: WebGLBuffer | null) => void =
    gl.bindBuffer.bind(gl)
  const origBindFramebuffer: (target: number, framebuffer: WebGLFramebuffer | null) => void =
    gl.bindFramebuffer.bind(gl)
  const origCullFace: (mode: number) => void = gl.cullFace.bind(gl)
  const origFrontFace: (mode: number) => void = gl.frontFace.bind(gl)
  const origColorMask: (r: boolean, g: boolean, b: boolean, a: boolean) => void =
    gl.colorMask.bind(gl)
  const origViewport: (x: number, y: number, w: number, h: number) => void = gl.viewport.bind(gl)
  const origScissor: (x: number, y: number, w: number, h: number) => void = gl.scissor.bind(gl)
  const origBlendFunc: (sfactor: number, dfactor: number) => void = gl.blendFunc.bind(gl)
  const origBlendFuncSeparate: (
    srcRGB: number,
    dstRGB: number,
    srcAlpha: number,
    dstAlpha: number
  ) => void = gl.blendFuncSeparate.bind(gl)
  const origBlendEquation: (mode: number) => void = gl.blendEquation.bind(gl)
  const origBlendEquationSeparate: (modeRGB: number, modeAlpha: number) => void =
    gl.blendEquationSeparate.bind(gl)
  const origDepthMask: (flag: boolean) => void = gl.depthMask.bind(gl)
  const origDepthFunc: (func: number) => void = gl.depthFunc.bind(gl)
  const origEnable: (cap: number) => void = gl.enable.bind(gl)
  const origDisable: (cap: number) => void = gl.disable.bind(gl)
  const origEnableVertexAttribArray: (index: number) => void = gl.enableVertexAttribArray.bind(gl)
  const origDisableVertexAttribArray: (index: number) => void = gl.disableVertexAttribArray.bind(gl)

  const getActiveTextureUnit = (): number => {
    const cached: unknown = shadow.params.get(gl.ACTIVE_TEXTURE)
    if (typeof cached === 'number') {
      return cached
    }
    const unit: unknown = origGetParameter(gl.ACTIVE_TEXTURE)
    if (typeof unit === 'number') {
      shadow.params.set(gl.ACTIVE_TEXTURE, unit)
      return unit
    }
    return gl.TEXTURE0
  }

  const getAttribEnabledMap = (vao: WebGLVertexArrayObject | null): Map<number, boolean> => {
    let map: Map<number, boolean> | undefined = shadow.vaoAttribEnabled.get(vao)
    if (!map) {
      map = new Map<number, boolean>()
      shadow.vaoAttribEnabled.set(vao, map)
    }
    return map
  }

  gl.useProgram = (program: WebGLProgram | null): void => {
    shadow.params.set(gl.CURRENT_PROGRAM, program)
    origUseProgram(program)
  }

  gl.activeTexture = (texture: number): void => {
    shadow.params.set(gl.ACTIVE_TEXTURE, texture)
    origActiveTexture(texture)
  }

  gl.bindTexture = (target: number, texture: WebGLTexture | null): void => {
    if (target === gl.TEXTURE_2D) {
      shadow.tex2dBindings.set(getActiveTextureUnit(), texture)
    }
    origBindTexture(target, texture)
  }

  gl.bindBuffer = (target: number, buffer: WebGLBuffer | null): void => {
    if (target === gl.ARRAY_BUFFER) {
      shadow.params.set(gl.ARRAY_BUFFER_BINDING, buffer)
    } else if (target === gl.ELEMENT_ARRAY_BUFFER) {
      shadow.vaoElementBuffer.set(shadow.currentVao, buffer)
    }
    origBindBuffer(target, buffer)
  }

  gl.bindFramebuffer = (target: number, framebuffer: WebGLFramebuffer | null): void => {
    if (target === gl.FRAMEBUFFER || target === drawFramebufferTarget) {
      shadow.params.set(gl.FRAMEBUFFER_BINDING, framebuffer)
    }
    origBindFramebuffer(target, framebuffer)
  }

  if ('bindVertexArray' in gl && typeof gl.bindVertexArray === 'function') {
    const origBindVertexArray: (vao: WebGLVertexArrayObject | null) => void =
      gl.bindVertexArray.bind(gl)
    gl.bindVertexArray = (vao: WebGLVertexArrayObject | null): void => {
      shadow.currentVao = vao
      origBindVertexArray(vao)
    }
  }

  if ('deleteVertexArray' in gl && typeof gl.deleteVertexArray === 'function') {
    const origDeleteVertexArray: (vao: WebGLVertexArrayObject | null) => void =
      gl.deleteVertexArray.bind(gl)
    gl.deleteVertexArray = (vao: WebGLVertexArrayObject | null): void => {
      shadow.vaoElementBuffer.delete(vao)
      shadow.vaoAttribEnabled.delete(vao)
      if (shadow.currentVao === vao) {
        shadow.currentVao = null
      }
      origDeleteVertexArray(vao)
    }
  }

  gl.cullFace = (mode: number): void => {
    shadow.params.set(gl.CULL_FACE_MODE, mode)
    origCullFace(mode)
  }

  gl.frontFace = (mode: number): void => {
    shadow.params.set(gl.FRONT_FACE, mode)
    origFrontFace(mode)
  }

  gl.colorMask = (r: boolean, g: boolean, b: boolean, a: boolean): void => {
    shadow.params.set(gl.COLOR_WRITEMASK, [Boolean(r), Boolean(g), Boolean(b), Boolean(a)])
    origColorMask(r, g, b, a)
  }

  gl.viewport = (x: number, y: number, w: number, h: number): void => {
    shadow.params.set(gl.VIEWPORT, new Int32Array([x, y, w, h]))
    origViewport(x, y, w, h)
  }

  gl.scissor = (x: number, y: number, w: number, h: number): void => {
    shadow.params.set(gl.SCISSOR_BOX, new Int32Array([x, y, w, h]))
    origScissor(x, y, w, h)
  }

  gl.blendFunc = (sfactor: number, dfactor: number): void => {
    shadow.params.set(gl.BLEND_SRC_RGB, sfactor)
    shadow.params.set(gl.BLEND_DST_RGB, dfactor)
    shadow.params.set(gl.BLEND_SRC_ALPHA, sfactor)
    shadow.params.set(gl.BLEND_DST_ALPHA, dfactor)
    origBlendFunc(sfactor, dfactor)
  }

  gl.blendFuncSeparate = (
    srcRGB: number,
    dstRGB: number,
    srcAlpha: number,
    dstAlpha: number
  ): void => {
    shadow.params.set(gl.BLEND_SRC_RGB, srcRGB)
    shadow.params.set(gl.BLEND_DST_RGB, dstRGB)
    shadow.params.set(gl.BLEND_SRC_ALPHA, srcAlpha)
    shadow.params.set(gl.BLEND_DST_ALPHA, dstAlpha)
    origBlendFuncSeparate(srcRGB, dstRGB, srcAlpha, dstAlpha)
  }

  gl.blendEquation = (mode: number): void => {
    shadow.params.set(gl.BLEND_EQUATION_RGB, mode)
    shadow.params.set(gl.BLEND_EQUATION_ALPHA, mode)
    origBlendEquation(mode)
  }

  gl.blendEquationSeparate = (modeRGB: number, modeAlpha: number): void => {
    shadow.params.set(gl.BLEND_EQUATION_RGB, modeRGB)
    shadow.params.set(gl.BLEND_EQUATION_ALPHA, modeAlpha)
    origBlendEquationSeparate(modeRGB, modeAlpha)
  }

  gl.depthMask = (flag: boolean): void => {
    shadow.params.set(gl.DEPTH_WRITEMASK, Boolean(flag))
    origDepthMask(flag)
  }

  gl.depthFunc = (func: number): void => {
    shadow.params.set(gl.DEPTH_FUNC, func)
    origDepthFunc(func)
  }

  gl.enable = (cap: number): void => {
    if (TRACKED_CAPS.has(cap)) {
      shadow.caps.set(cap, true)
    }
    origEnable(cap)
  }

  gl.disable = (cap: number): void => {
    if (TRACKED_CAPS.has(cap)) {
      shadow.caps.set(cap, false)
    }
    origDisable(cap)
  }

  gl.enableVertexAttribArray = (index: number): void => {
    getAttribEnabledMap(shadow.currentVao).set(index, true)
    origEnableVertexAttribArray(index)
  }

  gl.disableVertexAttribArray = (index: number): void => {
    getAttribEnabledMap(shadow.currentVao).set(index, false)
    origDisableVertexAttribArray(index)
  }

  gl.isEnabled = (cap: number): boolean => {
    if (!TRACKED_CAPS.has(cap)) {
      return origIsEnabled(cap)
    }
    if (shadow.caps.has(cap)) {
      return shadow.caps.get(cap) as boolean
    }
    const enabled: boolean = origIsEnabled(cap)
    shadow.caps.set(cap, enabled)
    return enabled
  }

  gl.getVertexAttrib = (index: number, pname: number): unknown => {
    if (pname !== gl.VERTEX_ATTRIB_ARRAY_ENABLED) {
      return origGetVertexAttrib(index, pname)
    }
    const map: Map<number, boolean> = getAttribEnabledMap(shadow.currentVao)
    if (map.has(index)) {
      return map.get(index)
    }
    const enabled: unknown = origGetVertexAttrib(index, pname)
    if (typeof enabled === 'boolean') {
      map.set(index, enabled)
    }
    return enabled
  }

  gl.getParameter = ((pname: number): unknown => {
    if (pname === gl.TEXTURE_BINDING_2D) {
      const unit: number = getActiveTextureUnit()
      if (shadow.tex2dBindings.has(unit)) {
        return shadow.tex2dBindings.get(unit)
      }
      const tex: unknown = origGetParameter(pname)
      shadow.tex2dBindings.set(unit, tex as WebGLTexture | null)
      return tex
    }

    if (pname === gl.ELEMENT_ARRAY_BUFFER_BINDING) {
      if (shadow.vaoElementBuffer.has(shadow.currentVao)) {
        return shadow.vaoElementBuffer.get(shadow.currentVao)
      }
      const buf: unknown = origGetParameter(pname)
      shadow.vaoElementBuffer.set(shadow.currentVao, buf as WebGLBuffer | null)
      return buf
    }

    if (TRACKED_PARAMS.has(pname)) {
      if (shadow.params.has(pname)) {
        return cloneParamValue(shadow.params.get(pname))
      }
      const val: unknown = origGetParameter(pname)
      shadow.params.set(pname, cloneParamValue(val))
      return val
    }

    return origGetParameter(pname)
  }) as AnyWebGLContext['getParameter']
}

/**
 * Installs the WebGL state shadow cache onto a PixiJS renderer if it exposes a GL context.
 */
export function installPixiWebGLStateCache(renderer: unknown): void {
  if (!renderer || typeof renderer !== 'object') {
    return
  }
  const gl: unknown = (renderer as { gl?: unknown }).gl
  if (gl && typeof (gl as AnyWebGLContext).getParameter === 'function') {
    installWebGLStateShadowCache(gl as AnyWebGLContext)
  }
}
