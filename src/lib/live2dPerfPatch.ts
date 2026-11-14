import type { Live2DModel } from 'untitled-pixi-live2d-engine'

type Live2DEngineModule = typeof import('untitled-pixi-live2d-engine')

type BoundsLike = {
  clear(): void
  addFrame(minX: number, minY: number, maxX: number, maxY: number, matrix: unknown): void
  set(minX: number, minY: number, maxX: number, maxY: number): void
}

type InternalCoreModelLike = {
  getDrawableCount?: () => number
  getDrawableVertices?: (index: number) => Float32Array
}

type CubismRendererBufferData = {
  vertex: WebGLBuffer | null
  uv: WebGLBuffer | null
  index: WebGLBuffer | null
}

type ModelColorRgba = {
  r: number
  g: number
  b: number
  a: number
}

type CubismRendererLike = {
  gl: WebGL2RenderingContext | WebGLRenderingContext | null
  _modelColor?: ModelColorRgba
  _bufferData?: CubismRendererBufferData
  __staticUvBuffers?: (WebGLBuffer | null)[]
  __staticIndexBuffers?: (WebGLBuffer | null)[]
  __dynamicVertexBuffers?: (WebGLBuffer | null)[]
  __vertexBufferVersions?: number[]
  __lastVertexData?: (Float32Array | undefined)[]
  __drawableVaosByProgram?: Map<WebGLProgram, (WebGLVertexArrayObject | null)[]>
  __skipState?: SkipUploadState
  __drawVersion?: number
  isPremultipliedAlpha?: () => boolean
  getModelColor?: () => ModelColorRgba
  getModelColorWithOpacity?: (opacity: number) => ModelColorRgba
  drawMeshWebGL?: (model: unknown, index: number) => void
  preDraw?: () => void
  doDrawModel?: () => void
  release?: () => void
}

type InternalModelLike = {
  coreModel?: InternalCoreModelLike
  renderer?: CubismRendererLike
  localTransform?: unknown
  originalWidth?: number
  width?: number
  originalHeight?: number
  height?: number
  pixelsPerUnit?: number
  update?: (dt: number, now: number) => void
  draw?: (gl: WebGL2RenderingContext | WebGLRenderingContext) => void
}

type Live2DModelPatchTarget = {
  internalModel?: InternalModelLike
  _bounds: BoundsLike
  _boundsDirty: boolean
  _boundsRetryAfterDraw: boolean
  _didViewChangeTick: number
  anchorMode: string
  deltaTime: number
  elapsedTime: number
  effects?: readonly { pipe?: string; filters?: readonly { enabled?: boolean }[] }[]
  onAnchorChange: () => void
  updateDrawableBounds: (applyAnchor?: boolean) => void
  prepareForRender: () => void
}

type SkipUploadState = {
  inDrawMesh: boolean
  activeIndex: number
  activeVaosByProgram: Map<WebGLProgram, (WebGLVertexArrayObject | null)[]> | null
  lastVaosMap: Map<WebGLProgram, (WebGLVertexArrayObject | null)[]> | null
  lastProgram: WebGLProgram | null
  lastVaos: (WebGLVertexArrayObject | null)[] | null
  gl2: WebGL2RenderingContext | null
  vaoActive: boolean
  vtxBuf: WebGLBuffer | null
  vtxNeedsSubData: boolean
  lastVtxData: (Float32Array | undefined)[] | null
  uvBuf: WebGLBuffer | null
  idxBuf: WebGLBuffer | null
  boundArrayBuf: WebGLBuffer | null
  boundElemBuf: WebGLBuffer | null
}

const SKIP_STATE_BY_GL: WeakMap<object, SkipUploadState> = new WeakMap<object, SkipUploadState>()
const PATCHED_RENDERER_PROTOS: WeakSet<object> = new WeakSet<object>()
const PATCHED_INTERNAL_PROTOS: WeakSet<object> = new WeakSet<object>()
let modelProtoPatched: boolean = false

function getSkipState(gl: WebGL2RenderingContext | WebGLRenderingContext): SkipUploadState {
  let state: SkipUploadState | undefined = SKIP_STATE_BY_GL.get(gl)
  if (state) {
    return state
  }
  const gl2: WebGL2RenderingContext | null =
    typeof (gl as WebGL2RenderingContext).createVertexArray === 'function'
      ? (gl as WebGL2RenderingContext)
      : null
  state = {
    inDrawMesh: false,
    activeIndex: 0,
    activeVaosByProgram: null,
    lastVaosMap: null,
    lastProgram: null,
    lastVaos: null,
    gl2,
    vaoActive: false,
    vtxBuf: null,
    vtxNeedsSubData: false,
    lastVtxData: null,
    uvBuf: null,
    idxBuf: null,
    boundArrayBuf: null,
    boundElemBuf: null
  }
  SKIP_STATE_BY_GL.set(gl, state)

  const origBindBuffer: typeof gl.bindBuffer = gl.bindBuffer.bind(gl)
  const origBufferData: typeof gl.bufferData = gl.bufferData.bind(gl)
  const origBufferSubData: typeof gl.bufferSubData = gl.bufferSubData.bind(gl)
  const origEnableVertexAttribArray: typeof gl.enableVertexAttribArray =
    gl.enableVertexAttribArray.bind(gl)
  const origVertexAttribPointer: typeof gl.vertexAttribPointer = gl.vertexAttribPointer.bind(gl)
  const origUseProgram: typeof gl.useProgram = gl.useProgram.bind(gl)

  gl.useProgram = (program: WebGLProgram | null): void => {
    if (state!.inDrawMesh) {
      if (program === null) {
        return
      }
      origUseProgram(program)
      const vaosByProgram: Map<WebGLProgram, (WebGLVertexArrayObject | null)[]> | null =
        state!.activeVaosByProgram
      const ctx2: WebGL2RenderingContext | null = state!.gl2
      if (ctx2 && vaosByProgram) {
        let vaos: (WebGLVertexArrayObject | null)[] | undefined
        if (
          state!.lastVaosMap === vaosByProgram &&
          state!.lastProgram === program &&
          state!.lastVaos
        ) {
          vaos = state!.lastVaos
        } else {
          vaos = vaosByProgram.get(program)
          if (!vaos) {
            vaos = []
            vaosByProgram.set(program, vaos)
          }
          state!.lastVaosMap = vaosByProgram
          state!.lastProgram = program
          state!.lastVaos = vaos
        }
        const idx: number = state!.activeIndex
        let vao: WebGLVertexArrayObject | null | undefined = vaos[idx]
        if (vao) {
          ctx2.bindVertexArray(vao)
          state!.vaoActive = true
        } else {
          vao = ctx2.createVertexArray()
          if (vao) {
            vaos[idx] = vao
            ctx2.bindVertexArray(vao)
            state!.vaoActive = false
          }
        }
      }
      return
    }
    origUseProgram(program)
  }

  gl.bindBuffer = (target: number, buffer: WebGLBuffer | null): void => {
    if (target === gl.ARRAY_BUFFER) {
      state!.boundArrayBuf = buffer
    } else if (target === gl.ELEMENT_ARRAY_BUFFER) {
      state!.boundElemBuf = buffer
    }
    if (state!.vaoActive) {
      if (
        target === gl.ELEMENT_ARRAY_BUFFER &&
        state!.idxBuf !== null &&
        buffer === state!.idxBuf
      ) {
        return
      }
      if (target === gl.ARRAY_BUFFER) {
        if (state!.uvBuf !== null && buffer === state!.uvBuf) {
          return
        }
        if (state!.vtxBuf !== null && buffer === state!.vtxBuf) {
          return
        }
      }
    }
    origBindBuffer(target, buffer)
  }

  gl.enableVertexAttribArray = (index: number): void => {
    if (state!.vaoActive) {
      return
    }
    origEnableVertexAttribArray(index)
  }

  gl.vertexAttribPointer = (
    index: number,
    size: number,
    type: number,
    normalized: boolean,
    stride: number,
    offset: number
  ): void => {
    if (state!.vaoActive) {
      return
    }
    origVertexAttribPointer(index, size, type, normalized, stride, offset)
  }

  gl.bufferData = ((
    target: number,
    srcData: BufferSource | number | null,
    usage: number,
    srcOffset?: number,
    length?: number
  ): void => {
    if (target === gl.ARRAY_BUFFER) {
      if (state!.vtxBuf !== null && state!.boundArrayBuf === state!.vtxBuf) {
        if (state!.vtxNeedsSubData && srcData !== null && typeof srcData !== 'number') {
          if (srcData instanceof Float32Array && state!.lastVtxData) {
            const idx: number = state!.activeIndex
            const prev: Float32Array | undefined = state!.lastVtxData[idx]
            if (prev && prev.length === srcData.length) {
              let same: boolean = true
              for (let i: number = 0; i < srcData.length; i += 1) {
                if (prev[i] !== srcData[i]) {
                  same = false
                  break
                }
              }
              if (same) {
                return
              }
              prev.set(srcData)
            } else {
              state!.lastVtxData[idx] = new Float32Array(srcData)
            }
          }
          if (state!.vaoActive) {
            origBindBuffer(gl.ARRAY_BUFFER, state!.vtxBuf)
          }
          origBufferSubData(target, 0, srcData)
        }
        return
      }
      if (state!.uvBuf !== null && state!.boundArrayBuf === state!.uvBuf) {
        return
      }
    }
    if (
      target === gl.ELEMENT_ARRAY_BUFFER &&
      state!.idxBuf !== null &&
      state!.boundElemBuf === state!.idxBuf
    ) {
      return
    }
    if (srcOffset === undefined) {
      ;(origBufferData as (t: number, d: BufferSource | number | null, u: number) => void)(
        target,
        srcData,
        usage
      )
    } else {
      ;(
        origBufferData as (
          t: number,
          d: ArrayBufferView | null,
          u: number,
          o: number,
          l?: number
        ) => void
      )(target, srcData as ArrayBufferView | null, usage, srcOffset, length)
    }
  }) as typeof gl.bufferData

  return state
}

function patchCubismRendererProto(renderer: CubismRendererLike): void {
  const proto: object | null = Object.getPrototypeOf(renderer)
  if (!proto || PATCHED_RENDERER_PROTOS.has(proto)) {
    return
  }
  PATCHED_RENDERER_PROTOS.add(proto)

  const baseProto: object | null = Object.getPrototypeOf(proto)
  const colorProto: CubismRendererLike =
    baseProto && typeof (baseProto as CubismRendererLike).getModelColor === 'function'
      ? (baseProto as CubismRendererLike)
      : (proto as CubismRendererLike)

  if (typeof colorProto.getModelColor === 'function') {
    colorProto.getModelColor = function (this: CubismRendererLike): ModelColorRgba {
      const c: ModelColorRgba = this._modelColor ?? { r: 1, g: 1, b: 1, a: 1 }
      return { r: c.r, g: c.g, b: c.b, a: c.a }
    }
  }

  if (typeof colorProto.getModelColorWithOpacity === 'function') {
    const sharedColor: ModelColorRgba = { r: 1, g: 1, b: 1, a: 1 }
    colorProto.getModelColorWithOpacity = function (
      this: CubismRendererLike,
      opacity: number
    ): ModelColorRgba {
      const c: ModelColorRgba = this._modelColor ?? { r: 1, g: 1, b: 1, a: 1 }
      const a: number = c.a * opacity
      sharedColor.a = a
      if (this.isPremultipliedAlpha?.()) {
        sharedColor.r = c.r * a
        sharedColor.g = c.g * a
        sharedColor.b = c.b * a
      } else {
        sharedColor.r = c.r
        sharedColor.g = c.g
        sharedColor.b = c.b
      }
      return sharedColor
    }
  }

  const rendererProto: CubismRendererLike = proto as CubismRendererLike
  const origPreDraw: (() => void) | undefined = rendererProto.preDraw
  if (typeof origPreDraw === 'function') {
    rendererProto.preDraw = function (this: CubismRendererLike): void {
      const gl2: WebGL2RenderingContext | null =
        this.gl && typeof (this.gl as WebGL2RenderingContext).bindVertexArray === 'function'
          ? (this.gl as WebGL2RenderingContext)
          : null
      if (gl2) {
        gl2.bindVertexArray(null)
      }
      origPreDraw.call(this)
    }
  }

  const origDoDrawModel: (() => void) | undefined = rendererProto.doDrawModel
  if (typeof origDoDrawModel === 'function') {
    rendererProto.doDrawModel = function (this: CubismRendererLike): void {
      this.__drawVersion = (this.__drawVersion ?? 0) + 1
      const gl2: WebGL2RenderingContext | null =
        this.gl && typeof (this.gl as WebGL2RenderingContext).bindVertexArray === 'function'
          ? (this.gl as WebGL2RenderingContext)
          : null
      const prevVao: WebGLVertexArrayObject | null = gl2
        ? (gl2.getParameter(gl2.VERTEX_ARRAY_BINDING) as WebGLVertexArrayObject | null)
        : null
      if (gl2 && prevVao !== null) {
        gl2.bindVertexArray(null)
      }
      try {
        origDoDrawModel.call(this)
      } finally {
        if (gl2) {
          gl2.bindVertexArray(prevVao)
        }
      }
    }
  }

  const origDrawMesh: ((model: unknown, index: number) => void) | undefined =
    rendererProto.drawMeshWebGL
  if (typeof origDrawMesh === 'function') {
    rendererProto.drawMeshWebGL = function (
      this: CubismRendererLike,
      model: unknown,
      index: number
    ): void {
      const gl: WebGL2RenderingContext | WebGLRenderingContext | null = this.gl
      const bufferData: CubismRendererBufferData | undefined = this._bufferData
      if (!gl || !bufferData) {
        origDrawMesh.call(this, model, index)
        return
      }

      const skipState: SkipUploadState = (this.__skipState ??= getSkipState(gl))
      const vtxBuffers: (WebGLBuffer | null)[] = (this.__dynamicVertexBuffers ??= [])
      const vtxVersions: number[] = (this.__vertexBufferVersions ??= [])
      const uvBuffers: (WebGLBuffer | null)[] = (this.__staticUvBuffers ??= [])
      const idxBuffers: (WebGLBuffer | null)[] = (this.__staticIndexBuffers ??= [])

      const origVtx: WebGLBuffer | null = bufferData.vertex
      const origUv: WebGLBuffer | null = bufferData.uv
      const origIdx: WebGLBuffer | null = bufferData.index
      const cachedVtx: WebGLBuffer | null | undefined = vtxBuffers[index]
      const cachedUv: WebGLBuffer | null | undefined = uvBuffers[index]
      const cachedIdx: WebGLBuffer | null | undefined = idxBuffers[index]

      const drawVersion: number = this.__drawVersion ?? 0
      if (cachedVtx) {
        bufferData.vertex = cachedVtx
        skipState.vtxBuf = cachedVtx
        const alreadyUploadedThisFrame: boolean =
          vtxVersions[index] === drawVersion && drawVersion > 0
        if (alreadyUploadedThisFrame) {
          skipState.vtxNeedsSubData = false
        } else {
          const coreModel = model as {
            getDrawableDynamicFlagVertexPositionsDidChange?: (idx: number) => boolean
          }
          const didChange: boolean =
            typeof coreModel.getDrawableDynamicFlagVertexPositionsDidChange === 'function'
              ? coreModel.getDrawableDynamicFlagVertexPositionsDidChange(index)
              : true
          skipState.vtxNeedsSubData = didChange
          vtxVersions[index] = drawVersion
        }
      } else {
        const newVtx: WebGLBuffer | null = gl.createBuffer()
        vtxBuffers[index] = newVtx
        vtxVersions[index] = drawVersion
        bufferData.vertex = newVtx
        skipState.vtxBuf = null
        skipState.vtxNeedsSubData = false
      }

      if (cachedUv && cachedIdx) {
        bufferData.uv = cachedUv
        bufferData.index = cachedIdx
        skipState.uvBuf = cachedUv
        skipState.idxBuf = cachedIdx
      } else {
        const newUv: WebGLBuffer | null = cachedUv ?? gl.createBuffer()
        const newIdx: WebGLBuffer | null = cachedIdx ?? gl.createBuffer()
        uvBuffers[index] = newUv
        idxBuffers[index] = newIdx
        bufferData.uv = newUv
        bufferData.index = newIdx
        skipState.uvBuf = null
        skipState.idxBuf = null
      }

      const vaosByProgram: Map<WebGLProgram, (WebGLVertexArrayObject | null)[]> | null =
        skipState.gl2 ? (this.__drawableVaosByProgram ??= new Map()) : null
      const lastVtxData: (Float32Array | undefined)[] = (this.__lastVertexData ??= [])
      skipState.inDrawMesh = true
      skipState.activeIndex = index
      skipState.activeVaosByProgram = vaosByProgram
      skipState.lastVtxData = lastVtxData

      origDrawMesh.call(this, model, index)

      skipState.inDrawMesh = false
      skipState.activeVaosByProgram = null
      skipState.lastVtxData = null
      skipState.vaoActive = false
      skipState.vtxBuf = null
      skipState.vtxNeedsSubData = false
      skipState.uvBuf = null
      skipState.idxBuf = null
      bufferData.vertex = origVtx
      bufferData.uv = origUv
      bufferData.index = origIdx
    }
  }

  const origRelease: (() => void) | undefined = rendererProto.release
  if (typeof origRelease === 'function') {
    rendererProto.release = function (this: CubismRendererLike): void {
      const gl: WebGL2RenderingContext | WebGLRenderingContext | null = this.gl
      const gl2: WebGL2RenderingContext | null =
        gl && typeof (gl as WebGL2RenderingContext).deleteVertexArray === 'function'
          ? (gl as WebGL2RenderingContext)
          : null
      if (gl2 && this.__drawableVaosByProgram) {
        for (const vaos of this.__drawableVaosByProgram.values()) {
          for (const vao of vaos) {
            if (vao) gl2.deleteVertexArray(vao)
          }
        }
        this.__drawableVaosByProgram.clear()
        this.__drawableVaosByProgram = undefined
      }
      if (gl && this.__dynamicVertexBuffers) {
        for (const buf of this.__dynamicVertexBuffers) {
          if (buf) gl.deleteBuffer(buf)
        }
        this.__dynamicVertexBuffers = undefined
        this.__vertexBufferVersions = undefined
        this.__lastVertexData = undefined
        this.__skipState = undefined
      }
      if (gl && this.__staticUvBuffers) {
        for (const buf of this.__staticUvBuffers) {
          if (buf) gl.deleteBuffer(buf)
        }
        this.__staticUvBuffers = undefined
      }
      if (gl && this.__staticIndexBuffers) {
        for (const buf of this.__staticIndexBuffers) {
          if (buf) gl.deleteBuffer(buf)
        }
        this.__staticIndexBuffers = undefined
      }
      origRelease.call(this)
    }
  }
}

function patchInternalModelProto(proto: InternalModelLike): void {
  if (!proto || PATCHED_INTERNAL_PROTOS.has(proto)) {
    return
  }
  PATCHED_INTERNAL_PROTOS.add(proto)

  const origDraw: ((gl: WebGL2RenderingContext | WebGLRenderingContext) => void) | undefined =
    proto.draw
  if (typeof origDraw === 'function') {
    proto.draw = function (
      this: InternalModelLike,
      gl: WebGL2RenderingContext | WebGLRenderingContext
    ): void {
      if (this.renderer) {
        patchCubismRendererProto(this.renderer)
      }
      origDraw.call(this, gl)
    }
  }
}

function hasActiveFilterEffect(model: Live2DModelPatchTarget): boolean {
  const effects:
    | readonly { pipe?: string; filters?: readonly { enabled?: boolean }[] }[]
    | undefined = model.effects
  if (!effects || effects.length === 0) {
    return false
  }
  for (let i = 0; i < effects.length; i += 1) {
    const filters: readonly { enabled?: boolean }[] | undefined = effects[i]?.filters
    if (!filters) continue
    for (let j = 0; j < filters.length; j += 1) {
      if (filters[j]?.enabled !== false) {
        return true
      }
    }
  }
  return false
}

/**
 * Applies runtime performance patches to `untitled-pixi-live2d-engine` without modifying
 * `node_modules`:
 * 1. Replaces O(N^2) allocating `updateDrawableBounds` with a zero-allocation O(N) scan.
 * 2. Skips `updateDrawableBounds` in `prepareForRender` when no filter effect is active.
 * 3. Removes `JSON.parse(JSON.stringify)` from `getModelColor` / `getModelColorWithOpacity`.
 * 4. Caches static UV & index WebGLBuffers per drawable and skips redundant `useProgram(null)`.
 */
export function installLive2DPerformancePatches(engine: Live2DEngineModule): void {
  const Live2DModelClass: typeof Live2DModel = engine.Live2DModel
  const modelProto: Live2DModelPatchTarget =
    Live2DModelClass.prototype as unknown as Live2DModelPatchTarget

  if (!modelProtoPatched) {
    modelProtoPatched = true
    const origUpdateDrawableBounds: (applyAnchor?: boolean) => void =
      modelProto.updateDrawableBounds

    modelProto.updateDrawableBounds = function (
      this: Live2DModelPatchTarget,
      applyAnchor: boolean = false
    ): void {
      const internal: InternalModelLike | undefined = this.internalModel
      if (!internal) {
        this._bounds.set(0, 0, 0, 0)
        this._boundsDirty = false
        return
      }

      const core: InternalCoreModelLike | undefined = internal.coreModel
      if (
        !core ||
        typeof core.getDrawableCount !== 'function' ||
        typeof core.getDrawableVertices !== 'function' ||
        typeof internal.pixelsPerUnit !== 'number'
      ) {
        origUpdateDrawableBounds.call(this, applyAnchor)
        return
      }

      const drawableCount: number = core.getDrawableCount()
      let rawMinX: number = Infinity
      let rawMinY: number = Infinity
      let rawMaxX: number = -Infinity
      let rawMaxY: number = -Infinity

      for (let i = 0; i < drawableCount; i += 1) {
        const verts: Float32Array = core.getDrawableVertices(i)
        const len: number = verts.length
        for (let j = 0; j < len; j += 2) {
          const x: number = verts[j]
          const y: number = verts[j + 1]
          if (x < rawMinX) rawMinX = x
          if (x > rawMaxX) rawMaxX = x
          if (y < rawMinY) rawMinY = y
          if (y > rawMaxY) rawMaxY = y
        }
      }

      this._bounds.clear()
      if (
        Number.isFinite(rawMinX) &&
        Number.isFinite(rawMinY) &&
        Number.isFinite(rawMaxX) &&
        Number.isFinite(rawMaxY) &&
        rawMaxX > rawMinX &&
        rawMaxY > rawMinY
      ) {
        const ppu: number = internal.pixelsPerUnit
        const halfW: number = (internal.originalWidth ?? 0) * 0.5
        const halfH: number = (internal.originalHeight ?? 0) * 0.5
        const minX: number = rawMinX * ppu + halfW
        const maxX: number = rawMaxX * ppu + halfW
        const minY: number = -rawMaxY * ppu + halfH
        const maxY: number = -rawMinY * ppu + halfH
        this._bounds.addFrame(minX, minY, maxX, maxY, internal.localTransform)
        this._boundsRetryAfterDraw = false
      } else {
        const width: number = internal.originalWidth || internal.width || 0
        const height: number = internal.originalHeight || internal.height || 0
        this._bounds.addFrame(0, 0, width, height, internal.localTransform)
        this._boundsRetryAfterDraw = true
      }

      this._boundsDirty = false
      this._didViewChangeTick += 1
      if (applyAnchor && this.anchorMode === 'drawable') {
        this.onAnchorChange()
      }
    }

    modelProto.prepareForRender = function (this: Live2DModelPatchTarget): void {
      const internal: InternalModelLike | undefined = this.internalModel
      if (!internal) {
        return
      }
      const frameDelta: number = this.deltaTime
      this.deltaTime = 0
      if (frameDelta && internal.update) {
        internal.update(frameDelta, this.elapsedTime)
      }
      if (hasActiveFilterEffect(this)) {
        this.updateDrawableBounds()
      } else {
        this._boundsDirty = true
      }
    }
  }

  if (engine.CubismInternalModel?.prototype) {
    patchInternalModelProto(engine.CubismInternalModel.prototype as unknown as InternalModelLike)
  }
  if (engine.CubismLegacyInternalModel?.prototype) {
    patchInternalModelProto(
      engine.CubismLegacyInternalModel.prototype as unknown as InternalModelLike
    )
  }
}
