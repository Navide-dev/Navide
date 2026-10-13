import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// 08:21: on Welcome the First-Run Tour did nothing. The What's New note had
// opened at launch (z-index 2100) under the Welcome overlay (z-modal + 110 =
// 2110): unseen, never closed, it kept every modal check true, so the tour
// waited behind it forever. The note belongs above Welcome and below Settings
// (z-modal + 120).
const Z_MODAL = 2000
function zOf(file: string, selector: string): number {
  const css = readFileSync(resolve(process.cwd(), file), 'utf8')
  const block = css.slice(css.indexOf(`${selector} {`))
  const body = block.slice(0, block.indexOf('}'))
  const calc = /z-index:\s*calc\(var\(--z-modal\)\s*([+-])\s*(\d+)\)/.exec(body)
  if (calc) return Z_MODAL + (calc[1] === '-' ? -1 : 1) * Number(calc[2])
  const plain = /z-index:\s*(\d+)/.exec(body)
  expect(plain, `${file} ${selector}`).not.toBeNull()
  return Number(plain![1])
}

describe("What's New over the Welcome screen", () => {
  it('draws above Welcome and below Settings', () => {
    const note = zOf('src/renderer/src/components/WhatsNewModal.vue', '.modal')
    expect(note).toBeGreaterThan(zOf('src/renderer/src/components/Welcome.vue', '.welcome-overlay'))
    expect(note).toBeLessThan(Z_MODAL + 120)
  })
})
