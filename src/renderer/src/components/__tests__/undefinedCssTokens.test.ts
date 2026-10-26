// Tokens invented at a call site, which resolve to nothing.
//
// `var(--bg-default)` is not in the design system — semantic.css defines
// --bg-base / --bg-inset / --bg-subtle / --bg-muted / --bg-elevated — so a
// declaration reading it falls back to `transparent`, silently, and only on
// the one surface that used it. That is how the "Paste Credential" field (a
// feature since removed) and the pane-title rename box in TerminalPane.vue
// both ended up with no background.
//
// AccountModal.vue and SettingsModal.vue each grew a local guard after the
// same token bit them there. A per-component guard only covers the component
// somebody remembered, and the failure mode here is "not covered", so this
// one is a scan of the whole renderer, in the style of stackingOrder.test.ts.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const RENDERER = resolve(here, '../..')

/** Named at their invention site, defined by no theme. */
const UNDEFINED = ['--bg-default', '--warn-fg', '--ok-fg']

function sources(): { file: string; text: string }[] {
  const found: { file: string; text: string }[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) {
        if (entry !== 'node_modules' && entry !== '__tests__') walk(full)
        continue
      }
      if (!/\.(vue|css)$/.test(entry)) continue
      found.push({ file: full.slice(RENDERER.length + 1), text: readFileSync(full, 'utf8') })
    }
  }
  walk(RENDERER)
  return found
}

describe('CSS custom properties', () => {
  it('finds the files it is supposed to be reading', () => {
    // The whole test is a search, and a search that matches nothing passes.
    const files = sources()
    expect(files.length).toBeGreaterThan(50)
    expect(files.some((f) => /var\(--bg-base\)/.test(f.text))).toBe(true)
  })

  for (const token of UNDEFINED) {
    it(`nothing reads var(${token})`, () => {
      // A written fallback — var(--x, --y) — is a deliberate opt-in, not a hole.
      const pattern = new RegExp(`var\\(\\s*${token}\\s*\\)`)
      const offenders = sources().filter((f) => pattern.test(f.text)).map((f) => f.file)
      expect(offenders, `${token} resolves to nothing`).toEqual([])
    })
  }
})
