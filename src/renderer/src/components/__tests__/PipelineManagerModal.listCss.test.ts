// @vitest-environment node
// Scoped <style> is stripped before a component test mounts, so the rules that
// carry this redesign are checked as source — the same technique as
// statusBadgeCss.test.ts. These assertions pin WHICH TOKEN a rule reaches for,
// never a colour value, because the same markup has to hold in all five themes.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const FILE = 'src/renderer/src/components/PipelineManagerModal.vue'
const source = readFileSync(resolve(process.cwd(), FILE), 'utf8')
const style = source.slice(source.indexOf('<style scoped>'))

/** The declaration block of a single rule, by exact selector line. */
function block(selector: string): string {
  const at = style.indexOf(`\n${selector} {`)
  expect(at, `${selector} has no rule in ${FILE}`).toBeGreaterThan(-1)
  const end = style.indexOf('\n}', at)
  return style.slice(at, end)
}

describe('PipelineManagerModal list-view CSS', () => {
  it('paints the modal body on the chrome surface, not the deepest well', () => {
    // SettingsModal's ladder: chrome = --bg-base, content = --bg-subtle,
    // well = --bg-inset. This body used to be --bg-inset.
    expect(block('.app')).toContain('background: var(--bg-base)')
    expect(block('.app')).not.toContain('var(--bg-inset)')
  })

  it('lays the row out as a four-track grid with a fixed actions column', () => {
    const row = block('.pl-item')
    expect(row).toContain('display: grid')
    const columns = /grid-template-columns:([^;]+);/.exec(row)?.[1].trim()
    expect(columns, '.pl-item needs explicit column tracks').toBeTruthy()
    // Four tracks, and the last one is a fixed width so the actions cell stops
    // moving when a badge or the reset button is absent.
    const tracks = columns!.split(/\s+/)
    expect(tracks).toHaveLength(4)
    expect(tracks[3]).toMatch(/^\d+px$/)
    expect(row).not.toContain('display: flex')
  })

  it('hovers with a translucent mix so the row separator survives', () => {
    // --bg-subtle was both the hover fill AND the separator colour, so hovering
    // a row erased its own border.
    expect(block('.pl-item:hover')).toContain('background: var(--bg-hover)')
    expect(block('.pl-item:hover')).not.toContain('var(--bg-subtle)')
  })

  it('draws the row separator with a border token, not a background token', () => {
    const row = block('.pl-item')
    expect(row).toContain('border-bottom: 1px solid var(--border-muted)')
    expect(row).not.toMatch(/border-bottom:[^;]*--bg-/)
  })

  it('marks selection with a quiet fill plus a locator rail', () => {
    const active = block('.pl-item.pl-active')
    expect(active).toContain('background: var(--bg-selected)')
    expect(active).toContain('box-shadow: inset 3px 0 0 var(--accent-emphasis)')
  })

  it('animates the row the way the sidebar pipeline row does', () => {
    expect(block('.pl-item')).toContain(
      'transition: background var(--motion-fast) var(--ease-out)'
    )
  })

  it('frames the list like a SettingsCard', () => {
    const list = block('.pl-list')
    expect(list).toContain('border: 1px solid var(--border-default)')
    expect(list).toContain('border-radius: var(--radius-md)')
    expect(list).toContain('background: var(--bg-subtle)')
  })

  it('tints the default badge with accent, never success', () => {
    const badge = block('.pl-badge')
    expect(badge).toContain('var(--accent-bright)')
    expect(badge).toContain('var(--accent-subtle)')
    expect(badge).toContain('var(--accent-muted)')
    // Green is reserved for success / done / running, and it collided with the
    // header's connection dot.
    expect(badge).not.toMatch(/--success-/)
  })

  it('keeps the builtin badge neutral', () => {
    const badge = block('.pl-badge--builtin')
    expect(badge).toContain('var(--bg-muted)')
    expect(badge).toContain('var(--text-secondary)')
    expect(badge).toContain('var(--border-default)')
    expect(badge).not.toMatch(/--accent-|--success-/)
  })

  it('makes the primary button the family accent, not green', () => {
    const primary = block('button.primary')
    expect(primary).toContain('var(--accent-emphasis)')
    expect(primary).not.toMatch(/--success-/)
    expect(block('button.primary:not(:disabled):hover')).not.toMatch(/--success-/)
  })

  it('gives the icon button the house 24px target', () => {
    const btn = block('.icon-btn')
    expect(btn).toContain('width: var(--icon-btn-md)')
    expect(btn).toContain('height: var(--icon-btn-md)')
    expect(btn).toContain('border-radius: var(--radius-sm)')
    // `padding: 2px 4px` was the whole click area before.
    expect(btn).not.toMatch(/padding: 2px 4px/)
  })

  it('gives the focusable row the house focus ring', () => {
    // `.pl-item` is a bare <li role="button">, so it inherits neither
    // `.nv-btn:focus-visible` nor `.nv-icon-btn:focus-visible`. Inset shadow,
    // not outline: the list scrolls, and an outline on the first or last row
    // would be clipped by it.
    const ring = block('.pl-item:focus-visible')
    expect(ring).toContain('box-shadow: inset 0 0 0 2px var(--accent-focus)')
    expect(ring).toContain('outline: none')
    // The selected row keeps its locator rail while focused — both shadows.
    const activeRing = block('.pl-item.pl-active:focus-visible')
    expect(activeRing).toContain('inset 3px 0 0 var(--accent-emphasis)')
    expect(activeRing).toContain('inset 0 0 0 2px var(--accent-focus)')
  })

  it('gives the icon button a focus ring of its own', () => {
    const ring = block('.icon-btn:focus-visible')
    expect(ring).toContain('box-shadow: inset 0 0 0 2px var(--accent-focus)')
  })

  // Regression guard, not a proof of a fix: this already held before the
  // redesign (the inputs swap the outline for an accent border). It exists so
  // that no later edit strips the ring out of the two rules above.
  it('never kills a focus outline without replacing the affordance', () => {
    const suppressors = (style.match(/[^}]*outline:\s*none[^}]*}/g) ?? []).filter(
      (rule) => !/box-shadow:|border-color:/.test(rule)
    )
    expect(suppressors, 'outline removed with nothing visible to replace it').toEqual([])
  })

  it('dashes the empty/error container so it reads as a placeholder', () => {
    const empty = block('.pl-empty')
    expect(empty).toContain('border: 1px dashed var(--border-default)')
    expect(empty).toContain('border-radius: var(--radius-md)')
    expect(empty).toContain('background: var(--bg-subtle)')
    expect(empty).toContain('text-align: center')
  })

  it('keeps the pipeline name readable when the editor toolbar runs short of room', () => {
    // min-width: 0 let the toolbar squeeze the name to nothing at 1600px.
    const name = block('.pl-detail-name')
    expect(name).toMatch(/min-width: \d+(\.\d+)?em/)
    expect(name).toContain('text-overflow: ellipsis')
  })

  it('carries no hard-coded colour anywhere in the component styles', () => {
    // Five themes only work if every colour comes from a token.
    expect(style.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).toEqual([])
    expect(style.match(/\brgba?\(/g) ?? []).toEqual([])
  })

  it('takes every radius and font size from the scale', () => {
    // The one legitimate literal is the 50% that makes the status dot a circle.
    const radii = (style.match(/border-radius:\s*[^;]+;/g) ?? []).filter(
      (d) => !d.includes('var(--') && !d.includes('50%')
    )
    expect(radii, 'hard-coded border-radius values').toEqual([])
    const fonts = (style.match(/font-size:\s*[^;]+;/g) ?? []).filter((d) => !d.includes('var(--'))
    expect(fonts, 'hard-coded font-size values').toEqual([])
  })
})
