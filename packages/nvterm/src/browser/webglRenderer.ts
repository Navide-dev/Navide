// WebGL2 renderer. Glyphs and decoration patterns are rasterized once with
// Canvas2D into a texture atlas; each frame is drawn as instanced quads:
// rectangles (backgrounds, selection, simple decorations, cursor) and glyphs
// sampled from the atlas, tinted by colour unless the glyph has its own
// colours (emoji).
import { WIDTH_TRAILING, WIDTH_WIDE } from '../buffer'
import { CellFlag } from '../snapshot'
import type { Style } from '../style'
import { cellColors, fontString, measureCell, strokeUnderline, type CellMetrics, type Frame, type Renderer, type RendererOptions } from './renderer'
import { cellColor } from './theme'

const RECT_VS = `#version 300 es
layout(location = 0) in vec2 a_unit;
layout(location = 1) in vec4 a_rect;
layout(location = 2) in vec4 a_color;
uniform vec2 u_resolution;
out vec4 v_color;
void main() {
  vec2 p = (a_rect.xy + a_unit * a_rect.zw) / u_resolution * 2.0 - 1.0;
  gl_Position = vec4(p.x, -p.y, 0.0, 1.0);
  v_color = a_color;
}`

const RECT_FS = `#version 300 es
precision mediump float;
in vec4 v_color;
out vec4 outColor;
void main() { outColor = v_color; }`

const GLYPH_VS = `#version 300 es
layout(location = 0) in vec2 a_unit;
layout(location = 1) in vec4 a_rect;
layout(location = 2) in vec4 a_color;
layout(location = 3) in vec4 a_uv;
layout(location = 4) in float a_colored;
uniform vec2 u_resolution;
out vec4 v_color;
out vec2 v_uv;
out float v_colored;
void main() {
  vec2 p = (a_rect.xy + a_unit * a_rect.zw) / u_resolution * 2.0 - 1.0;
  gl_Position = vec4(p.x, -p.y, 0.0, 1.0);
  v_color = a_color;
  v_uv = a_uv.xy + a_unit * a_uv.zw;
  v_colored = a_colored;
}`

const GLYPH_FS = `#version 300 es
precision mediump float;
uniform sampler2D u_atlas;
in vec4 v_color;
in vec2 v_uv;
in float v_colored;
out vec4 outColor;
void main() {
  vec4 t = texture(u_atlas, v_uv);
  outColor = v_colored > 0.5 ? vec4(t.rgb, t.a * v_color.a) : vec4(v_color.rgb, v_color.a * t.a);
}`

const ATLAS_SIZE = 2048
const RECT_FLOATS = 8 // x y w h r g b a
const GLYPH_FLOATS = 13 // x y w h r g b a u v uw vh colored
const CURSOR_THICKNESS = 2

interface AtlasEntry {
  /** Normalized texture rectangle. */
  u: number
  v: number
  uw: number
  vh: number
  /** Size in CSS pixels. */
  width: number
  height: number
  colored: boolean
}

/** Packs rasterized glyphs into rows of a fixed-size canvas mirrored to a texture. */
class GlyphAtlas {
  readonly canvas: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D
  private readonly entries = new Map<string, AtlasEntry>()
  private x = 0
  private y = 0
  private rowHeight = 0
  /** Set when the canvas changed and the texture must be re-uploaded. */
  dirty = true

  constructor(doc: Document) {
    this.canvas = doc.createElement('canvas')
    this.canvas.width = ATLAS_SIZE
    this.canvas.height = ATLAS_SIZE
    const ctx = this.canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) throw new Error('nvterm: Canvas2D is not available for the glyph atlas')
    this.ctx = ctx
  }

  clear(): void {
    this.entries.clear()
    this.ctx.clearRect(0, 0, ATLAS_SIZE, ATLAS_SIZE)
    this.x = 0
    this.y = 0
    this.rowHeight = 0
    this.dirty = true
  }

  get size(): number {
    return this.entries.size
  }

  /**
   * Returns the entry for `key`, drawing it with `draw` (in device pixels,
   * inside a `wDev` x `hDev` box at the origin) the first time. Returns
   * undefined when the atlas is full; the caller clears it and redraws the frame.
   */
  get(key: string, wDev: number, hDev: number, dpr: number, detectColor: boolean, draw: (ctx: CanvasRenderingContext2D) => void): AtlasEntry | undefined {
    const hit = this.entries.get(key)
    if (hit) return hit
    const w = Math.ceil(wDev) + 2
    const h = Math.ceil(hDev) + 2
    if (this.x + w > ATLAS_SIZE) {
      this.x = 0
      this.y += this.rowHeight
      this.rowHeight = 0
    }
    if (this.y + h > ATLAS_SIZE || w > ATLAS_SIZE) return undefined
    const ctx = this.ctx
    ctx.save()
    ctx.beginPath()
    ctx.rect(this.x, this.y, w, h)
    ctx.clip()
    ctx.translate(this.x + 1, this.y + 1)
    ctx.scale(dpr, dpr)
    draw(ctx)
    ctx.restore()
    let colored = false
    if (detectColor) {
      const { data } = ctx.getImageData(this.x, this.y, w, h)
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3]! > 32 && (Math.abs(data[i]! - data[i + 1]!) > 24 || Math.abs(data[i + 1]! - data[i + 2]!) > 24)) {
          colored = true
          break
        }
      }
    }
    const entry: AtlasEntry = {
      u: (this.x + 1) / ATLAS_SIZE,
      v: (this.y + 1) / ATLAS_SIZE,
      uw: wDev / ATLAS_SIZE,
      vh: hDev / ATLAS_SIZE,
      width: wDev / dpr,
      height: hDev / dpr,
      colored,
    }
    this.entries.set(key, entry)
    this.x += w
    this.rowHeight = Math.max(this.rowHeight, h)
    this.dirty = true
    return entry
  }
}

/** Growable Float32Array of instance attributes. */
class InstanceBuffer {
  data: Float32Array
  count = 0
  private readonly stride: number
  constructor(stride: number) {
    this.stride = stride
    this.data = new Float32Array(stride * 1024)
  }
  reset(): void {
    this.count = 0
  }
  push(...values: number[]): void {
    const at = this.count * this.stride
    if (at + this.stride > this.data.length) {
      const next = new Float32Array(this.data.length * 2)
      next.set(this.data)
      this.data = next
    }
    this.data.set(values, at)
    this.count++
  }
}

function rgba(color: number, alpha = 1): [number, number, number, number] {
  return [(color >> 16) / 255, ((color >> 8) & 0xff) / 255, (color & 0xff) / 255, alpha]
}

export class WebglRenderer implements Renderer {
  readonly kind = 'webgl'
  readonly canvas: HTMLCanvasElement
  metrics: CellMetrics = { width: 0, height: 0, baseline: 0 }
  private readonly gl: WebGL2RenderingContext
  private options: RendererOptions
  private readonly atlas: GlyphAtlas
  private readonly measureCtx: CanvasRenderingContext2D
  private readonly rectProgram: WebGLProgram
  private readonly glyphProgram: WebGLProgram
  private readonly texture: WebGLTexture
  private readonly unitBuffer: WebGLBuffer
  private readonly instanceBuffer: WebGLBuffer
  private readonly rectVao: WebGLVertexArrayObject
  private readonly glyphVao: WebGLVertexArrayObject
  private readonly rects = new InstanceBuffer(RECT_FLOATS)
  private readonly overlays = new InstanceBuffer(RECT_FLOATS)
  private readonly glyphs = new InstanceBuffer(GLYPH_FLOATS)
  private cols = 0
  private rows = 0
  private disposed = false

  /** Throws when WebGL2 is unavailable; the caller falls back to Canvas2D. */
  constructor(canvas: HTMLCanvasElement, options: RendererOptions) {
    this.canvas = canvas
    // preserveDrawingBuffer keeps the last frame readable (screenshots, drawImage) between paints.
    const gl = canvas.getContext('webgl2', { alpha: true, antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: true })
    if (!gl) throw new Error('nvterm: WebGL2 is not available')
    this.gl = gl
    this.options = options
    this.atlas = new GlyphAtlas(canvas.ownerDocument)
    const measure = canvas.ownerDocument.createElement('canvas').getContext('2d')
    if (!measure) throw new Error('nvterm: Canvas2D is not available')
    this.measureCtx = measure
    this.rectProgram = program(gl, RECT_VS, RECT_FS)
    this.glyphProgram = program(gl, GLYPH_VS, GLYPH_FS)
    this.texture = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, this.texture)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    this.unitBuffer = gl.createBuffer()!
    gl.bindBuffer(gl.ARRAY_BUFFER, this.unitBuffer)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]), gl.STATIC_DRAW)
    this.instanceBuffer = gl.createBuffer()!
    this.rectVao = this.vao(RECT_FLOATS, [[1, 4, 0], [2, 4, 4]])
    this.glyphVao = this.vao(GLYPH_FLOATS, [[1, 4, 0], [2, 4, 4], [3, 4, 8], [4, 1, 12]])
    this.measure()
  }

  setOptions(options: RendererOptions): void {
    this.options = options
    this.atlas.clear()
    this.measure()
    this.resize(this.cols, this.rows)
  }

  measure(): CellMetrics {
    this.metrics = measureCell(this.measureCtx, this.options)
    return this.metrics
  }

  resize(cols: number, rows: number): void {
    this.cols = cols
    this.rows = rows
    const dpr = this.options.devicePixelRatio
    const w = cols * this.metrics.width
    const h = rows * this.metrics.height
    this.canvas.width = Math.round(w * dpr)
    this.canvas.height = Math.round(h * dpr)
    this.canvas.style.width = `${w}px`
    this.canvas.style.height = `${h}px`
  }

  /** Releases GPU objects and the atlas. The context itself is released by the caller (WEBGL_lose_context). */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    const { gl } = this
    if (gl.isContextLost()) return
    gl.deleteTexture(this.texture)
    gl.deleteBuffer(this.unitBuffer)
    gl.deleteBuffer(this.instanceBuffer)
    gl.deleteVertexArray(this.rectVao)
    gl.deleteVertexArray(this.glyphVao)
    gl.deleteProgram(this.rectProgram)
    gl.deleteProgram(this.glyphProgram)
    this.atlas.clear()
    this.atlas.canvas.width = 1
    this.atlas.canvas.height = 1
  }

  /** Glyphs currently cached (for diagnostics and tests). */
  get atlasEntries(): number {
    return this.atlas.size
  }

  render(frame: Frame): void {
    if (this.disposed || this.gl.isContextLost()) return
    if (!this.build(frame)) {
      // The atlas filled up mid-frame: start over with an empty atlas.
      this.atlas.clear()
      if (!this.build(frame)) return
    }
    this.draw()
  }

  // ---- Frame building ---------------------------------------------------------

  /** Fills the instance buffers; false if the atlas ran out of room. */
  private build(frame: Frame): boolean {
    const { colors } = this.options
    const { width: cw, height: ch } = this.metrics
    const defaultFg = frame.reverseVideo ? colors.background : colors.foreground
    const defaultBg = frame.reverseVideo ? colors.foreground : colors.background
    const buf = frame.buffer
    this.rects.reset()
    this.overlays.reset()
    this.glyphs.reset()
    this.cursorGlyphFrom = -1

    for (let row = 0; row < this.rows; row++) {
      const abs = frame.viewportTop + row
      const line = buf.absoluteLine(abs)
      if (!line) continue
      const stableY = buf.dropped + abs
      const y = row * ch
      const cols = Math.min(this.cols, line.cols)
      const links = frame.linkUnderlines?.get(stableY)
      for (let x = 0; x < cols; x++) {
        const s = frame.style(line.styles[x]!)
        const [fg, bg] = cellColors(s, defaultFg, defaultBg, this.options)
        if (bg !== defaultBg || s.flags & CellFlag.Inverse) this.rects.push(x * cw, y, cw, ch, ...rgba(bg))
        if (frame.isSelected?.(x, stableY)) this.rects.push(x * cw, y, cw, ch, ...rgba(colors.selection, colors.selectionAlpha))
        if (line.widths[x] === WIDTH_TRAILING) continue
        const span = line.widths[x] === WIDTH_WIDE ? 2 : 1
        const text = line.chars(x)
        if (text && !(s.flags & CellFlag.Invisible)) {
          if (!this.pushGlyph(text, s.flags, span, x * cw, y, rgba(fg, s.flags & CellFlag.Dim ? 0.5 : 1))) return false
        }
        if (!this.pushDecorations(s, fg, x * cw, y, span * cw)) return false
        if (links?.some(([a, b]) => x >= a && x < b)) this.overlays.push(x * cw, y + ch - 2, span * cw, 1, ...rgba(fg))
      }
    }

    if (frame.composition && frame.cursor) return this.pushComposition(frame, defaultFg, defaultBg)
    if (frame.cursor?.visible) return this.pushCursor(frame)
    return true
  }

  private pushGlyph(text: string, flags: number, span: number, x: number, y: number, color: [number, number, number, number]): boolean {
    const { width: cw, height: ch, baseline } = this.metrics
    const dpr = this.options.devicePixelRatio
    const font = fontString(flags, this.options)
    const slotW = span * cw + cw / 2 // room for italic overhang
    const key = `g|${flags & (CellFlag.Bold | CellFlag.Italic)}|${span}|${text}`
    const entry = this.atlas.get(key, slotW * dpr, ch * dpr, dpr, span === 2 || text.codePointAt(0)! > 0x2000, (ctx) => {
      ctx.font = font
      ctx.fillStyle = '#ffffff'
      ctx.textBaseline = 'alphabetic'
      const offset = span === 2 ? Math.max(0, (2 * cw - ctx.measureText(text).width) / 2) : 0
      ctx.fillText(text, offset, baseline)
    })
    if (!entry) return false
    this.glyphs.push(x, y, entry.width, entry.height, ...color, entry.u, entry.v, entry.uw, entry.vh, entry.colored ? 1 : 0)
    return true
  }

  private pushDecorations(s: Readonly<Style>, fg: number, x: number, y: number, w: number): boolean {
    const { height: ch } = this.metrics
    if (s.flags & CellFlag.Underline) {
      const color = s.underlineColor ? cellColor(s.underlineColor, this.options.colors, fg) : fg
      const style = s.underlineStyle || 1
      if (style === 1) {
        this.overlays.push(x, y + ch - 2, w, 1, ...rgba(color))
      } else {
        // Patterned underlines are atlas sprites one row tall, tinted like glyphs.
        const dpr = this.options.devicePixelRatio
        const entry = this.atlas.get(`u|${style}|${w}`, w * dpr, ch * dpr, dpr, false, (ctx) => strokeUnderline(ctx, '#ffffff', 0, ch - 2, w, style))
        if (!entry) return false
        this.glyphs.push(x, y, entry.width, entry.height, ...rgba(color), entry.u, entry.v, entry.uw, entry.vh, 0)
      }
    }
    if (s.flags & CellFlag.Strikethrough) this.overlays.push(x, y + Math.round(ch / 2), w, 1, ...rgba(fg))
    if (s.flags & CellFlag.Overline) this.overlays.push(x, y, w, 1, ...rgba(fg))
    return true
  }

  private pushCursor(frame: Frame): boolean {
    const cursor = frame.cursor!
    const { colors } = this.options
    const { width: cw, height: ch } = this.metrics
    const line = frame.buffer.absoluteLine(frame.viewportTop + cursor.row)
    const x = Math.min(cursor.x, this.cols - 1)
    const span = line?.widths[x] === WIDTH_WIDE ? 2 : 1
    const px = x * cw
    const py = cursor.row * ch
    const c = rgba(colors.cursor)
    if (!cursor.focused) {
      this.overlays.push(px, py, span * cw, 1, ...c)
      this.overlays.push(px, py + ch - 1, span * cw, 1, ...c)
      this.overlays.push(px, py, 1, ch, ...c)
      this.overlays.push(px + span * cw - 1, py, 1, ch, ...c)
      return true
    }
    if (cursor.shape === 'underline') {
      this.overlays.push(px, py + ch - CURSOR_THICKNESS, span * cw, CURSOR_THICKNESS, ...c)
      return true
    }
    if (cursor.shape === 'bar') {
      this.overlays.push(px, py, CURSOR_THICKNESS, ch, ...c)
      return true
    }
    this.overlays.push(px, py, span * cw, ch, ...c)
    const text = line?.chars(x)
    if (text) {
      // The glyph under a block cursor is drawn again on top, in the accent colour.
      const s = frame.style(line!.styles[x]!)
      const before = this.glyphs.count
      if (!this.pushGlyph(text, s.flags, span, px, py, rgba(colors.cursorAccent))) return false
      this.cursorGlyphFrom = before
    }
    return true
  }

  /** Index of the first glyph instance to draw after the overlays (the glyph under a block cursor). */
  private cursorGlyphFrom = -1

  private pushComposition(frame: Frame, defaultFg: number, defaultBg: number): boolean {
    const cursor = frame.cursor!
    const { width: cw, height: ch, baseline } = this.metrics
    const dpr = this.options.devicePixelRatio
    const px = Math.min(cursor.x, this.cols - 1) * cw
    const py = cursor.row * ch
    const font = fontString(0, this.options)
    this.measureCtx.font = font
    const w = Math.max(cw, this.measureCtx.measureText(frame.composition).width)
    this.overlays.push(px, py, w, ch, ...rgba(defaultBg))
    this.overlays.push(px, py + ch - 2, w, 1, ...rgba(defaultFg))
    const entry = this.atlas.get(`c|${frame.composition}`, w * dpr, ch * dpr, dpr, true, (ctx) => {
      ctx.font = font
      ctx.fillStyle = '#ffffff'
      ctx.fillText(frame.composition, 0, baseline)
    })
    if (!entry) return false
    this.cursorGlyphFrom = this.glyphs.count
    this.glyphs.push(px, py, entry.width, entry.height, ...rgba(defaultFg), entry.u, entry.v, entry.uw, entry.vh, entry.colored ? 1 : 0)
    return true
  }

  // ---- Drawing ----------------------------------------------------------------

  private draw(): void {
    const { gl } = this
    const { colors } = this.options
    gl.viewport(0, 0, this.canvas.width, this.canvas.height)
    const [r, g, b] = rgba(colors.background)
    gl.clearColor(r, g, b, colors.backgroundAlpha)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.enable(gl.BLEND)
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    const res = [this.cols * this.metrics.width, this.rows * this.metrics.height] as const

    if (this.atlas.dirty) {
      gl.bindTexture(gl.TEXTURE_2D, this.texture)
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.atlas.canvas)
      this.atlas.dirty = false
    }

    // Backgrounds and selection, then glyphs, then decorations and the cursor,
    // then any glyph that must sit on top of the cursor.
    const cursorFrom = this.cursorGlyphFrom
    this.cursorGlyphFrom = -1
    const mainGlyphs = cursorFrom >= 0 ? cursorFrom : this.glyphs.count
    this.drawRects(this.rects, res)
    this.drawGlyphs(0, mainGlyphs, res)
    this.drawRects(this.overlays, res)
    if (cursorFrom >= 0) this.drawGlyphs(cursorFrom, this.glyphs.count - cursorFrom, res)
  }

  private drawRects(buf: InstanceBuffer, res: readonly [number, number]): void {
    if (!buf.count) return
    const { gl } = this
    gl.useProgram(this.rectProgram)
    gl.uniform2f(gl.getUniformLocation(this.rectProgram, 'u_resolution'), res[0], res[1])
    gl.bindVertexArray(this.rectVao)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer)
    gl.bufferData(gl.ARRAY_BUFFER, buf.data.subarray(0, buf.count * RECT_FLOATS), gl.DYNAMIC_DRAW)
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, buf.count)
  }

  private drawGlyphs(first: number, count: number, res: readonly [number, number]): void {
    if (count <= 0) return
    const { gl } = this
    gl.useProgram(this.glyphProgram)
    gl.uniform2f(gl.getUniformLocation(this.glyphProgram, 'u_resolution'), res[0], res[1])
    gl.uniform1i(gl.getUniformLocation(this.glyphProgram, 'u_atlas'), 0)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.texture)
    gl.bindVertexArray(this.glyphVao)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer)
    gl.bufferData(gl.ARRAY_BUFFER, this.glyphs.data.subarray(first * GLYPH_FLOATS, (first + count) * GLYPH_FLOATS), gl.DYNAMIC_DRAW)
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, count)
  }

  /** A VAO with the unit quad at location 0 and instance attributes [location, size, offset in floats]. */
  private vao(stride: number, attrs: [number, number, number][]): WebGLVertexArrayObject {
    const { gl } = this
    const vao = gl.createVertexArray()!
    gl.bindVertexArray(vao)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.unitBuffer)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer)
    for (const [loc, size, offset] of attrs) {
      gl.enableVertexAttribArray(loc)
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride * 4, offset * 4)
      gl.vertexAttribDivisor(loc, 1)
    }
    gl.bindVertexArray(null)
    return vao
  }
}

function program(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const compile = (type: number, src: string): WebGLShader => {
    const shader = gl.createShader(type)!
    gl.shaderSource(shader, src)
    gl.compileShader(shader)
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(`nvterm: shader: ${gl.getShaderInfoLog(shader)}`)
    return shader
  }
  const p = gl.createProgram()!
  gl.attachShader(p, compile(gl.VERTEX_SHADER, vs))
  gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs))
  gl.linkProgram(p)
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`nvterm: program: ${gl.getProgramInfoLog(p)}`)
  return p
}
