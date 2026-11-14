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

  let hasCurrentVao: boolean = false

  const clearShadow = (): void => {
    shadow.params.clear()
    shadow.caps.clear()
    shadow.tex2dBindings.clear()
    shadow.currentVao = null
    hasCurrentVao = false
    currentProgram = null
    hasCurrentProgram = false
    shadow.vaoElementBuffer.clear()
    shadow.vaoAttribEnabled.clear()
  }

  let currentProgram: WebGLProgram | null = null
  let hasCurrentProgram: boolean = false
  let lastU1iMap: Map<WebGLUniformLocation, number> | null = null
  let lastU4fMap: Map<WebGLUniformLocation, [number, number, number, number]> | null = null
  let lastMat4Map: Map<WebGLUniformLocation, Float32Array> | null = null
  const programUniform1i: WeakMap<WebGLProgram, Map<WebGLUniformLocation, number>> = new WeakMap()
  const programUniform4f: WeakMap<
    WebGLProgram,
    Map<WebGLUniformLocation, [number, number, number, number]>
  > = new WeakMap()
  const programUniformMat4: WeakMap<
    WebGLProgram,
    Map<WebGLUniformLocation, Float32Array>
  > = new WeakMap()

  const syncProgramUniformMaps = (program: WebGLProgram | null): void => {
    if (program === null) {
      lastU1iMap = null
      lastU4fMap = null
      lastMat4Map = null
      return
    }
    let u1 = programUniform1i.get(program)
    if (!u1) {
      u1 = new Map<WebGLUniformLocation, number>()
      programUniform1i.set(program, u1)
    }
    let u4 = programUniform4f.get(program)
    if (!u4) {
      u4 = new Map<WebGLUniformLocation, [number, number, number, number]>()
      programUniform4f.set(program, u4)
    }
    let m4 = programUniformMat4.get(program)
    if (!m4) {
      m4 = new Map<WebGLUniformLocation, Float32Array>()
      programUniformMat4.set(program, m4)
    }
    lastU1iMap = u1
    lastU4fMap = u4
    lastMat4Map = m4
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

  const drawFramebufferTarget: number =
    'DRAW_FRAMEBUFFER' in gl && typeof gl.DRAW_FRAMEBUFFER === 'number'
      ? gl.DRAW_FRAMEBUFFER
      : gl.FRAMEBUFFER
  const readFramebufferTarget: number =
    'READ_FRAMEBUFFER' in gl && typeof gl.READ_FRAMEBUFFER === 'number'
      ? gl.READ_FRAMEBUFFER
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
  const origClearColor: (r: number, g: number, b: number, a: number) => void =
    gl.clearColor.bind(gl)
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
  const origLinkProgram: (program: WebGLProgram) => void = gl.linkProgram.bind(gl)
  const origUniform1i: (location: WebGLUniformLocation | null, x: number) => void =
    gl.uniform1i.bind(gl)
  const origUniform4f: (
    location: WebGLUniformLocation | null,
    x: number,
    y: number,
    z: number,
    w: number
  ) => void = gl.uniform4f.bind(gl)
  const origUniformMatrix4fv: AnyWebGLContext['uniformMatrix4fv'] = gl.uniformMatrix4fv.bind(gl)

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
    if (hasCurrentProgram && currentProgram === program) {
      return
    }
    currentProgram = program
    hasCurrentProgram = true
    syncProgramUniformMaps(program)
    shadow.params.set(gl.CURRENT_PROGRAM, program)
    origUseProgram(program)
  }

  gl.linkProgram = (program: WebGLProgram): void => {
    programUniform1i.delete(program)
    programUniform4f.delete(program)
    programUniformMat4.delete(program)
    if (currentProgram === program) {
      syncProgramUniformMaps(program)
    }
    origLinkProgram(program)
  }

  gl.uniform1i = (location: WebGLUniformLocation | null, x: number): void => {
    if (location !== null && lastU1iMap !== null) {
      if (lastU1iMap.get(location) === x) {
        return
      }
      lastU1iMap.set(location, x)
    }
    origUniform1i(location, x)
  }

  gl.uniform4f = (
    location: WebGLUniformLocation | null,
    x: number,
    y: number,
    z: number,
    w: number
  ): void => {
    if (location !== null && lastU4fMap !== null) {
      const cached: [number, number, number, number] | undefined = lastU4fMap.get(location)
      if (cached) {
        if (cached[0] === x && cached[1] === y && cached[2] === z && cached[3] === w) {
          return
        }
        cached[0] = x
        cached[1] = y
        cached[2] = z
        cached[3] = w
      } else {
        lastU4fMap.set(location, [x, y, z, w])
      }
    }
    origUniform4f(location, x, y, z, w)
  }

  gl.uniformMatrix4fv = ((
    location: WebGLUniformLocation | null,
    transpose: boolean,
    value: Float32List,
    srcOffset?: number,
    srcLength?: number
  ): void => {
    if (
      location !== null &&
      lastMat4Map !== null &&
      !transpose &&
      srcOffset === undefined &&
      srcLength === undefined &&
      value instanceof Float32Array &&
      value.length === 16
    ) {
      const cached: Float32Array | undefined = lastMat4Map.get(location)
      if (cached) {
        if (
          cached[0] === value[0] &&
          cached[1] === value[1] &&
          cached[2] === value[2] &&
          cached[3] === value[3] &&
          cached[4] === value[4] &&
          cached[5] === value[5] &&
          cached[6] === value[6] &&
          cached[7] === value[7] &&
          cached[8] === value[8] &&
          cached[9] === value[9] &&
          cached[10] === value[10] &&
          cached[11] === value[11] &&
          cached[12] === value[12] &&
          cached[13] === value[13] &&
          cached[14] === value[14] &&
          cached[15] === value[15]
        ) {
          return
        }
        cached.set(value)
      } else {
        const copy: Float32Array = new Float32Array(16)
        copy.set(value)
        lastMat4Map.set(location, copy)
      }
      origUniformMatrix4fv(location, transpose, value)
      return
    }
    if (srcOffset === undefined) {
      origUniformMatrix4fv(location, transpose, value)
    } else {
      ;(origUniformMatrix4fv as (...args: unknown[]) => void)(
        location,
        transpose,
        value,
        srcOffset,
        srcLength
      )
    }
  }) as AnyWebGLContext['uniformMatrix4fv']

  let curActiveTexEnum: number = -1
  let curActiveTexUnit: number = -1
  const tex2dByUnit: (WebGLTexture | null | undefined)[] = new Array<
    WebGLTexture | null | undefined
  >(32)
  let hasCurArrayBuf: boolean = false
  let curArrayBuf: WebGLBuffer | null = null
  let hasDrawFbo: boolean = false
  let curDrawFbo: WebGLFramebuffer | null = null
  let hasReadFbo: boolean = false
  let curReadFbo: WebGLFramebuffer | null = null
  let curClearR: number = NaN
  let curClearG: number = NaN
  let curClearB: number = NaN
  let curClearA: number = NaN
  let curCullFace: number = -1
  let curFrontFace: number = -1
  let hasCurVp: boolean = false
  let curVpX: number = 0
  let curVpY: number = 0
  let curVpW: number = 0
  let curVpH: number = 0
  let curVpArr: Int32Array | null = null
  let curBlendSrcRgb: number = -1
  let curBlendDstRgb: number = -1
  let curBlendSrcAlpha: number = -1
  let curBlendDstAlpha: number = -1

  gl.activeTexture = (texture: number): void => {
    if (curActiveTexEnum === texture) {
      return
    }
    curActiveTexEnum = texture
    curActiveTexUnit = texture - gl.TEXTURE0
    shadow.params.set(gl.ACTIVE_TEXTURE, texture)
    origActiveTexture(texture)
  }

  gl.bindTexture = (target: number, texture: WebGLTexture | null): void => {
    if (target === gl.TEXTURE_2D) {
      const unit: number = curActiveTexUnit >= 0 ? curActiveTexUnit : getActiveTextureUnit()
      if (unit >= 0 && unit < 32) {
        if (tex2dByUnit[unit] === texture) {
          return
        }
        tex2dByUnit[unit] = texture
        shadow.tex2dBindings.set(unit, texture)
      } else {
        if (shadow.tex2dBindings.has(unit) && shadow.tex2dBindings.get(unit) === texture) {
          return
        }
        shadow.tex2dBindings.set(unit, texture)
      }
    }
    origBindTexture(target, texture)
  }

  gl.bindBuffer = (target: number, buffer: WebGLBuffer | null): void => {
    if (target === gl.ARRAY_BUFFER) {
      if (hasCurArrayBuf && curArrayBuf === buffer) {
        return
      }
      hasCurArrayBuf = true
      curArrayBuf = buffer
      shadow.params.set(gl.ARRAY_BUFFER_BINDING, buffer)
    } else if (target === gl.ELEMENT_ARRAY_BUFFER) {
      if (
        shadow.vaoElementBuffer.has(shadow.currentVao) &&
        shadow.vaoElementBuffer.get(shadow.currentVao) === buffer
      ) {
        return
      }
      shadow.vaoElementBuffer.set(shadow.currentVao, buffer)
    }
    origBindBuffer(target, buffer)
  }

  gl.bindFramebuffer = (target: number, framebuffer: WebGLFramebuffer | null): void => {
    if (target === gl.FRAMEBUFFER) {
      if (hasDrawFbo && hasReadFbo && curDrawFbo === framebuffer && curReadFbo === framebuffer) {
        return
      }
      hasDrawFbo = true
      hasReadFbo = true
      curDrawFbo = framebuffer
      curReadFbo = framebuffer
      shadow.params.set(gl.FRAMEBUFFER_BINDING, framebuffer)
    } else if (target === drawFramebufferTarget) {
      if (hasDrawFbo && curDrawFbo === framebuffer) {
        return
      }
      hasDrawFbo = true
      curDrawFbo = framebuffer
      shadow.params.set(gl.FRAMEBUFFER_BINDING, framebuffer)
    } else if (target === readFramebufferTarget) {
      if (hasReadFbo && curReadFbo === framebuffer) {
        return
      }
      hasReadFbo = true
      curReadFbo = framebuffer
    }
    origBindFramebuffer(target, framebuffer)
  }

  gl.clearColor = (r: number, g: number, b: number, a: number): void => {
    if (curClearR === r && curClearG === g && curClearB === b && curClearA === a) {
      return
    }
    curClearR = r
    curClearG = g
    curClearB = b
    curClearA = a
    origClearColor(r, g, b, a)
  }

  if ('bindVertexArray' in gl && typeof gl.bindVertexArray === 'function') {
    const origBindVertexArray: (vao: WebGLVertexArrayObject | null) => void =
      gl.bindVertexArray.bind(gl)
    gl.bindVertexArray = (vao: WebGLVertexArrayObject | null): void => {
      if (hasCurrentVao && shadow.currentVao === vao) {
        return
      }
      hasCurrentVao = true
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
        hasCurrentVao = false
      }
      origDeleteVertexArray(vao)
    }
  }

  gl.cullFace = (mode: number): void => {
    if (curCullFace === mode) {
      return
    }
    curCullFace = mode
    shadow.params.set(gl.CULL_FACE_MODE, mode)
    origCullFace(mode)
  }

  gl.frontFace = (mode: number): void => {
    if (curFrontFace === mode) {
      return
    }
    curFrontFace = mode
    shadow.params.set(gl.FRONT_FACE, mode)
    origFrontFace(mode)
  }

  gl.colorMask = (r: boolean, g: boolean, b: boolean, a: boolean): void => {
    const br: boolean = Boolean(r)
    const bg: boolean = Boolean(g)
    const bb: boolean = Boolean(b)
    const ba: boolean = Boolean(a)
    const cached: unknown = shadow.params.get(gl.COLOR_WRITEMASK)
    if (
      Array.isArray(cached) &&
      cached[0] === br &&
      cached[1] === bg &&
      cached[2] === bb &&
      cached[3] === ba
    ) {
      return
    }
    shadow.params.set(gl.COLOR_WRITEMASK, [br, bg, bb, ba])
    origColorMask(br, bg, bb, ba)
  }

  gl.viewport = (x: number, y: number, w: number, h: number): void => {
    if (hasCurVp && curVpX === x && curVpY === y && curVpW === w && curVpH === h) {
      return
    }
    hasCurVp = true
    curVpX = x
    curVpY = y
    curVpW = w
    curVpH = h
    if (!curVpArr) {
      curVpArr = new Int32Array([x, y, w, h])
      shadow.params.set(gl.VIEWPORT, curVpArr)
    } else {
      curVpArr[0] = x
      curVpArr[1] = y
      curVpArr[2] = w
      curVpArr[3] = h
    }
    origViewport(x, y, w, h)
  }

  gl.scissor = (x: number, y: number, w: number, h: number): void => {
    const cached: unknown = shadow.params.get(gl.SCISSOR_BOX)
    if (
      cached instanceof Int32Array &&
      cached[0] === x &&
      cached[1] === y &&
      cached[2] === w &&
      cached[3] === h
    ) {
      return
    }
    if (cached instanceof Int32Array) {
      cached[0] = x
      cached[1] = y
      cached[2] = w
      cached[3] = h
    } else {
      shadow.params.set(gl.SCISSOR_BOX, new Int32Array([x, y, w, h]))
    }
    origScissor(x, y, w, h)
  }

  gl.blendFunc = (sfactor: number, dfactor: number): void => {
    if (
      curBlendSrcRgb === sfactor &&
      curBlendDstRgb === dfactor &&
      curBlendSrcAlpha === sfactor &&
      curBlendDstAlpha === dfactor
    ) {
      return
    }
    curBlendSrcRgb = sfactor
    curBlendDstRgb = dfactor
    curBlendSrcAlpha = sfactor
    curBlendDstAlpha = dfactor
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
    if (
      curBlendSrcRgb === srcRGB &&
      curBlendDstRgb === dstRGB &&
      curBlendSrcAlpha === srcAlpha &&
      curBlendDstAlpha === dstAlpha
    ) {
      return
    }
    curBlendSrcRgb = srcRGB
    curBlendDstRgb = dstRGB
    curBlendSrcAlpha = srcAlpha
    curBlendDstAlpha = dstAlpha
    shadow.params.set(gl.BLEND_SRC_RGB, srcRGB)
    shadow.params.set(gl.BLEND_DST_RGB, dstRGB)
    shadow.params.set(gl.BLEND_SRC_ALPHA, srcAlpha)
    shadow.params.set(gl.BLEND_DST_ALPHA, dstAlpha)
    origBlendFuncSeparate(srcRGB, dstRGB, srcAlpha, dstAlpha)
  }

  gl.blendEquation = (mode: number): void => {
    if (
      shadow.params.get(gl.BLEND_EQUATION_RGB) === mode &&
      shadow.params.get(gl.BLEND_EQUATION_ALPHA) === mode
    ) {
      return
    }
    shadow.params.set(gl.BLEND_EQUATION_RGB, mode)
    shadow.params.set(gl.BLEND_EQUATION_ALPHA, mode)
    origBlendEquation(mode)
  }

  gl.blendEquationSeparate = (modeRGB: number, modeAlpha: number): void => {
    if (
      shadow.params.get(gl.BLEND_EQUATION_RGB) === modeRGB &&
      shadow.params.get(gl.BLEND_EQUATION_ALPHA) === modeAlpha
    ) {
      return
    }
    shadow.params.set(gl.BLEND_EQUATION_RGB, modeRGB)
    shadow.params.set(gl.BLEND_EQUATION_ALPHA, modeAlpha)
    origBlendEquationSeparate(modeRGB, modeAlpha)
  }

  gl.depthMask = (flag: boolean): void => {
    const b: boolean = Boolean(flag)
    if (shadow.params.has(gl.DEPTH_WRITEMASK) && shadow.params.get(gl.DEPTH_WRITEMASK) === b) {
      return
    }
    shadow.params.set(gl.DEPTH_WRITEMASK, b)
    origDepthMask(b)
  }

  gl.depthFunc = (func: number): void => {
    if (shadow.params.has(gl.DEPTH_FUNC) && shadow.params.get(gl.DEPTH_FUNC) === func) {
      return
    }
    shadow.params.set(gl.DEPTH_FUNC, func)
    origDepthFunc(func)
  }

  const CAP_BLEND: number = gl.BLEND
  const CAP_CULL_FACE: number = gl.CULL_FACE
  const CAP_SCISSOR_TEST: number = gl.SCISSOR_TEST
  const CAP_STENCIL_TEST: number = gl.STENCIL_TEST
  const CAP_DEPTH_TEST: number = gl.DEPTH_TEST
  let capBlend: number = -1
  let capCullFace: number = -1
  let capScissorTest: number = -1
  let capStencilTest: number = -1
  let capDepthTest: number = -1

  gl.enable = (cap: number): void => {
    if (cap === CAP_BLEND) {
      if (capBlend === 1) return
      capBlend = 1
    } else if (cap === CAP_CULL_FACE) {
      if (capCullFace === 1) return
      capCullFace = 1
    } else if (cap === CAP_SCISSOR_TEST) {
      if (capScissorTest === 1) return
      capScissorTest = 1
    } else if (cap === CAP_STENCIL_TEST) {
      if (capStencilTest === 1) return
      capStencilTest = 1
    } else if (cap === CAP_DEPTH_TEST) {
      if (capDepthTest === 1) return
      capDepthTest = 1
    }
    origEnable(cap)
  }

  gl.disable = (cap: number): void => {
    if (cap === CAP_BLEND) {
      if (capBlend === 0) return
      capBlend = 0
    } else if (cap === CAP_CULL_FACE) {
      if (capCullFace === 0) return
      capCullFace = 0
    } else if (cap === CAP_SCISSOR_TEST) {
      if (capScissorTest === 0) return
      capScissorTest = 0
    } else if (cap === CAP_STENCIL_TEST) {
      if (capStencilTest === 0) return
      capStencilTest = 0
    } else if (cap === CAP_DEPTH_TEST) {
      if (capDepthTest === 0) return
      capDepthTest = 0
    }
    origDisable(cap)
  }

  gl.enableVertexAttribArray = (index: number): void => {
    const map: Map<number, boolean> = getAttribEnabledMap(shadow.currentVao)
    if (map.get(index) === true) {
      return
    }
    map.set(index, true)
    origEnableVertexAttribArray(index)
  }

  gl.disableVertexAttribArray = (index: number): void => {
    const map: Map<number, boolean> = getAttribEnabledMap(shadow.currentVao)
    if (map.get(index) === false) {
      return
    }
    map.set(index, false)
    origDisableVertexAttribArray(index)
  }

  gl.isEnabled = (cap: number): boolean => {
    if (cap === CAP_BLEND) {
      if (capBlend !== -1) return capBlend === 1
      const enabled: boolean = origIsEnabled(cap)
      capBlend = enabled ? 1 : 0
      return enabled
    }
    if (cap === CAP_CULL_FACE) {
      if (capCullFace !== -1) return capCullFace === 1
      const enabled: boolean = origIsEnabled(cap)
      capCullFace = enabled ? 1 : 0
      return enabled
    }
    if (cap === CAP_SCISSOR_TEST) {
      if (capScissorTest !== -1) return capScissorTest === 1
      const enabled: boolean = origIsEnabled(cap)
      capScissorTest = enabled ? 1 : 0
      return enabled
    }
    if (cap === CAP_STENCIL_TEST) {
      if (capStencilTest !== -1) return capStencilTest === 1
      const enabled: boolean = origIsEnabled(cap)
      capStencilTest = enabled ? 1 : 0
      return enabled
    }
    if (cap === CAP_DEPTH_TEST) {
      if (capDepthTest !== -1) return capDepthTest === 1
      const enabled: boolean = origIsEnabled(cap)
      capDepthTest = enabled ? 1 : 0
      return enabled
    }
    return origIsEnabled(cap)
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
    if (
      'VERTEX_ARRAY_BINDING' in gl &&
      pname === (gl as WebGL2RenderingContext).VERTEX_ARRAY_BINDING
    ) {
      if (hasCurrentVao) {
        return shadow.currentVao
      }
      const vao: unknown = origGetParameter(pname)
      shadow.currentVao = vao as WebGLVertexArrayObject | null
      hasCurrentVao = true
      return vao
    }

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
