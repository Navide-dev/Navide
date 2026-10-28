// @vitest-environment node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// A setting row puts its text beside a control that never shrinks. Without
// wrapping, a control wider than the row (the Language page's eleven language
// buttons) squeezed the text to one word per line, ran its words under the
// buttons and pushed the buttons out of the card. The fix is layout only, which
// component tests cannot see (scoped <style> is stripped before mounting), so
// the rules are checked as source here.

function styleOf(file: string): string {
  const source = readFileSync(resolve(process.cwd(), file), 'utf8')
  return [...source.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)]
    .map((m) => m[1])
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
}

/** Declarations every rule naming `selector` in its selector list sets, in source order. */
function resolveDecls(style: string, selector: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of style.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = m[1].split(',').map((s) => s.trim())
    if (!selectors.includes(selector)) continue
    for (const decl of m[2].split(';')) {
      const i = decl.indexOf(':')
      if (i < 0) continue
      out[decl.slice(0, i).trim()] = decl.slice(i + 1).trim()
    }
  }
  return out
}

describe('SettingRow layout with a wide control', () => {
  const row = styleOf('src/renderer/src/components/settings/SettingRow.vue')

  it('wraps a control that does not fit beside the text onto its own line', () => {
    expect(resolveDecls(row, '.setting-row')['flex-wrap']).toBe('wrap')
  })

  it('keeps a readable basis for the text instead of letting it collapse', () => {
    const basis = resolveDecls(row, '.setting-row-text').flex?.split(/\s+/)[2] ?? ''
    expect(parseInt(basis, 10)).toBeGreaterThanOrEqual(160)
  })

  it('never lets the control grow past the row', () => {
    expect(resolveDecls(row, '.setting-row-control')['max-width']).toBe('100%')
  })
})

describe('Language buttons', () => {
  const modal = styleOf('src/renderer/src/components/SettingsModal.vue')

  it('keep the check mark in the button flow rather than over the label', () => {
    expect(resolveDecls(modal, '.ap-lang-btn .ap-check').position).toBe('static')
  })
})
