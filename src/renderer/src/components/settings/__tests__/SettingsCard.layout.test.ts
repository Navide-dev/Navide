// @vitest-environment node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// The Updates page puts its version card straight in a scrolling flex column.
// A card clips its rows (overflow: hidden), so when it was allowed to shrink it
// collapsed to a sliver whenever the page was taller than the window (860px,
// long locales). Scoped <style> is stripped before mounting, so the rule is
// checked as source.

function cardRule(): string {
  const source = readFileSync(resolve(process.cwd(), 'src/renderer/src/components/settings/SettingsCard.vue'), 'utf8')
  const style = (source.match(/<style[^>]*>([\s\S]*?)<\/style>/)?.[1] ?? '').replace(/\/\*[\s\S]*?\*\//g, '')
  return style.match(/(?:^|\n)\.settings-card\s*\{([^}]*)\}/)?.[1] ?? ''
}

describe('SettingsCard layout', () => {
  it('never shrinks inside a flex column, since it clips its own rows', () => {
    const rule = cardRule()
    expect(rule).toMatch(/overflow:\s*hidden/)
    expect(rule).toMatch(/flex-shrink:\s*0/)
  })
})
