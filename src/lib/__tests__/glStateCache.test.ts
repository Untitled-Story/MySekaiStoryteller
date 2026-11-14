import assert from 'node:assert/strict'
import test from 'node:test'
import { installWebGLStateShadowCache } from '../glStateCache'

type MockGl = {
  TEXTURE0: number
  TEXTURE1: number
  TEXTURE_2D: number
  ARRAY_BUFFER: number
  ELEMENT_ARRAY_BUFFER: number
  FRAMEBUFFER: number
  DRAW_FRAMEBUFFER: number
  READ_FRAMEBUFFER: number
  MAX_TEXTURE_SIZE: number
  MAX_CUBE_MAP_TEXTURE_SIZE: number
  MAX_COMBINED_TEXTURE_IMAGE_UNITS: number
  MAX_TEXTURE_IMAGE_UNITS: number
  MAX_VERTEX_ATTRIBS: number
  MAX_VERTEX_UNIFORM_VECTORS: number
  MAX_FRAGMENT_UNIFORM_VECTORS: number
  MAX_VARYING_VECTORS: number
  CULL_FACE_MODE: number
  FRONT_FACE: number
  COLOR_WRITEMASK: number
  VIEWPORT: number
  SCISSOR_BOX: number
  BLEND_SRC_RGB: number
  BLEND_DST_RGB: number
  BLEND_SRC_ALPHA: number
  BLEND_DST_ALPHA: number
  BLEND_EQUATION_RGB: number
  BLEND_EQUATION_ALPHA: number
  DEPTH_WRITEMASK: number
  DEPTH_FUNC: number
  ACTIVE_TEXTURE: number
  CURRENT_PROGRAM: number
  ARRAY_BUFFER_BINDING: number
  ELEMENT_ARRAY_BUFFER_BINDING: number
  TEXTURE_BINDING_2D: number
  FRAMEBUFFER_BINDING: number
  BLEND: number
  CULL_FACE: number
  SCISSOR_TEST: number
  STENCIL_TEST: number
  DEPTH_TEST: number
  VERTEX_ATTRIB_ARRAY_ENABLED: number
  getParameter: (pname: number) => unknown
  isEnabled: (cap: number) => boolean
  getVertexAttrib: (index: number, pname: number) => unknown
  useProgram: (program: WebGLProgram | null) => void
  activeTexture: (texture: number) => void
  bindTexture: (target: number, texture: WebGLTexture | null) => void
  bindBuffer: (target: number, buffer: WebGLBuffer | null) => void
  bindFramebuffer: (target: number, fb: WebGLFramebuffer | null) => void
  bindVertexArray: (vao: WebGLVertexArrayObject | null) => void
  deleteVertexArray: (vao: WebGLVertexArrayObject | null) => void
  cullFace: (mode: number) => void
  frontFace: (mode: number) => void
  colorMask: (r: boolean, g: boolean, b: boolean, a: boolean) => void
  viewport: (x: number, y: number, w: number, h: number) => void
  scissor: (x: number, y: number, w: number, h: number) => void
  blendFunc: (s: number, d: number) => void
  blendFuncSeparate: (sr: number, dr: number, sa: number, da: number) => void
  blendEquation: (m: number) => void
  blendEquationSeparate: (mr: number, ma: number) => void
  depthMask: (f: boolean) => void
  depthFunc: (f: number) => void
  enable: (c: number) => void
  disable: (c: number) => void
  enableVertexAttribArray: (i: number) => void
  disableVertexAttribArray: (i: number) => void
}

function createMockGl(): {
  gl: MockGl
  counts: { getParameter: number; isEnabled: number; getVertexAttrib: number }
} {
  let activeTex: number = 0x84c0
  const counts: { getParameter: number; isEnabled: number; getVertexAttrib: number } = {
    getParameter: 0,
    isEnabled: 0,
    getVertexAttrib: 0
  }
  const noop = (): void => undefined

  const gl: MockGl = {
    TEXTURE0: 0x84c0,
    TEXTURE1: 0x84c1,
    TEXTURE_2D: 0x0de1,
    ARRAY_BUFFER: 0x8892,
    ELEMENT_ARRAY_BUFFER: 0x8893,
    FRAMEBUFFER: 0x8d40,
    DRAW_FRAMEBUFFER: 0x8ca9,
    READ_FRAMEBUFFER: 0x8ca8,
    MAX_TEXTURE_SIZE: 0x0d33,
    MAX_CUBE_MAP_TEXTURE_SIZE: 0x851c,
    MAX_COMBINED_TEXTURE_IMAGE_UNITS: 0x8b4d,
    MAX_TEXTURE_IMAGE_UNITS: 0x8872,
    MAX_VERTEX_ATTRIBS: 0x8869,
    MAX_VERTEX_UNIFORM_VECTORS: 0x8dfb,
    MAX_FRAGMENT_UNIFORM_VECTORS: 0x8dfd,
    MAX_VARYING_VECTORS: 0x8dfc,
    CULL_FACE_MODE: 0x0b45,
    FRONT_FACE: 0x0b46,
    COLOR_WRITEMASK: 0x0c23,
    VIEWPORT: 0x0ba2,
    SCISSOR_BOX: 0x0c10,
    BLEND_SRC_RGB: 0x80c9,
    BLEND_DST_RGB: 0x80c8,
    BLEND_SRC_ALPHA: 0x80cb,
    BLEND_DST_ALPHA: 0x80ca,
    BLEND_EQUATION_RGB: 0x8009,
    BLEND_EQUATION_ALPHA: 0x883d,
    DEPTH_WRITEMASK: 0x0b72,
    DEPTH_FUNC: 0x0b74,
    ACTIVE_TEXTURE: 0x84e0,
    CURRENT_PROGRAM: 0x8b8d,
    ARRAY_BUFFER_BINDING: 0x8894,
    ELEMENT_ARRAY_BUFFER_BINDING: 0x8895,
    TEXTURE_BINDING_2D: 0x8069,
    FRAMEBUFFER_BINDING: 0x8ca6,
    BLEND: 0x0be2,
    CULL_FACE: 0x0b44,
    SCISSOR_TEST: 0x0c11,
    STENCIL_TEST: 0x0b90,
    DEPTH_TEST: 0x0b71,
    VERTEX_ATTRIB_ARRAY_ENABLED: 0x8622,
    getParameter: (pname: number): unknown => {
      counts.getParameter += 1
      if (pname === 0x0b45) return 0x0405
      if (pname === 0x84e0) return activeTex
      if (pname === 0x8069) return null
      if (pname === 0x8895) return null
      return 0
    },
    isEnabled: (): boolean => {
      counts.isEnabled += 1
      return false
    },
    getVertexAttrib: (): boolean => {
      counts.getVertexAttrib += 1
      return false
    },
    useProgram: noop,
    activeTexture: (t: number): void => {
      activeTex = t
    },
    bindTexture: noop,
    bindBuffer: noop,
    bindFramebuffer: noop,
    bindVertexArray: noop,
    deleteVertexArray: noop,
    cullFace: noop,
    frontFace: noop,
    colorMask: noop,
    viewport: noop,
    scissor: noop,
    blendFunc: noop,
    blendFuncSeparate: noop,
    blendEquation: noop,
    blendEquationSeparate: noop,
    depthMask: noop,
    depthFunc: noop,
    enable: noop,
    disable: noop,
    enableVertexAttribArray: noop,
    disableVertexAttribArray: noop
  }

  return { gl, counts }
}

test('caches tracked WebGL parameters and updates on state mutations', (): void => {
  const { gl, counts } = createMockGl()
  installWebGLStateShadowCache(gl as unknown as WebGL2RenderingContext)

  assert.equal(gl.getParameter(gl.CULL_FACE_MODE), 0x0405)
  assert.equal(gl.getParameter(gl.CULL_FACE_MODE), 0x0405)
  assert.equal(counts.getParameter, 1)

  gl.cullFace(0x0404)
  assert.equal(gl.getParameter(gl.CULL_FACE_MODE), 0x0404)
  assert.equal(counts.getParameter, 1)

  gl.enable(gl.CULL_FACE)
  assert.equal(gl.isEnabled(gl.CULL_FACE), true)
  gl.disable(gl.CULL_FACE)
  assert.equal(gl.isEnabled(gl.CULL_FACE), false)
  assert.equal(counts.isEnabled, 0)
})

test('tracks TEXTURE_BINDING_2D per active texture unit and VAO-scoped element buffers', (): void => {
  const { gl, counts } = createMockGl()
  installWebGLStateShadowCache(gl as unknown as WebGL2RenderingContext)

  const tex0 = { id: 0 } as unknown as WebGLTexture
  const tex1 = { id: 1 } as unknown as WebGLTexture
  gl.activeTexture(gl.TEXTURE0)
  gl.bindTexture(gl.TEXTURE_2D, tex0)
  gl.activeTexture(gl.TEXTURE1)
  gl.bindTexture(gl.TEXTURE_2D, tex1)

  assert.equal(gl.getParameter(gl.TEXTURE_BINDING_2D), tex1)
  gl.activeTexture(gl.TEXTURE0)
  assert.equal(gl.getParameter(gl.TEXTURE_BINDING_2D), tex0)
  assert.equal(counts.getParameter, 0)

  const vaoA = { id: 'A' } as unknown as WebGLVertexArrayObject
  const vaoB = { id: 'B' } as unknown as WebGLVertexArrayObject
  const eboA = { id: 'eboA' } as unknown as WebGLBuffer
  const eboB = { id: 'eboB' } as unknown as WebGLBuffer

  gl.bindVertexArray(vaoA)
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, eboA)
  gl.enableVertexAttribArray(1)

  gl.bindVertexArray(vaoB)
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, eboB)
  gl.disableVertexAttribArray(1)

  gl.bindVertexArray(vaoA)
  assert.equal(gl.getParameter(gl.ELEMENT_ARRAY_BUFFER_BINDING), eboA)
  assert.equal(gl.getVertexAttrib(1, gl.VERTEX_ATTRIB_ARRAY_ENABLED), true)

  gl.bindVertexArray(vaoB)
  assert.equal(gl.getParameter(gl.ELEMENT_ARRAY_BUFFER_BINDING), eboB)
  assert.equal(gl.getVertexAttrib(1, gl.VERTEX_ATTRIB_ARRAY_ENABLED), false)
  assert.equal(counts.getVertexAttrib, 0)
})
