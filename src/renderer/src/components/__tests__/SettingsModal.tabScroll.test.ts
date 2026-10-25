// @vitest-environment node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Every settings tab body is a `.s-body`, which is `overflow: hidden` on
// purpose, so each tab must name its own scroll owner or its content is clipped
// at the bottom of the modal with no way to reach it. That regressed silently
// on the Navide Plugins page: a later rule was inserted between
// `.extensions-scroll,` and `.marketplace-scroll {`, so `.extensions-scroll`
// picked up the marketplace tab strip's horizontal flex instead of the shared
// scroll rule — the policy, inventory and Disclosure overview were laid out as
// three squeezed columns and the page could not scroll. Component tests cannot
// see this (scoped <style> is stripped before mounting), so the rules are
// checked as source here.

const SOURCE = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/components/SettingsModal.vue'),
  'utf8',
)

const STYLE = [...SOURCE.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)]
  .map((m) => m[1])
  .join('\n')
  .replace(/\/\*[\s\S]*?\*\//g, '')

/** Declarations every rule naming `selector` in its selector list sets, in source order. */
function resolveDecls(selector: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of STYLE.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
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

const scrolls = (d: Record<string, string>): boolean =>
  /^(auto|scroll)$/.test(d['overflow-y'] ?? '') || /^(auto|scroll)$/.test(d.overflow ?? '')

/** Each tab body as `{ tab, classes }`, read from the template. */
const TAB_BODIES = [...SOURCE.matchAll(/v-show="activeTab === '([^']+)'" class="(s-body[^"]*)"/g)].map(
  (m) => ({ tab: m[1], classes: m[2].split(/\s+/).filter((c) => c && c !== 's-body') }),
)

/** Tabs whose scroll owner is not the body itself, and what owns it instead. */
const SCROLL_OWNER: Record<string, string> = {
  extensions: '.extensions-scroll',
  marketplace: '.marketplace-scroll',
  cliAgents: '.cli-agent-roster',
}

/** Full-bleed tabs that hand the whole body to a child pane which scrolls itself. */
const CHILD_SCROLLS = new Set(['skills', 'credentials', 'prompts', 'memory', 'cliExtensions'])

describe('SettingsModal tab scrolling', () => {
  it('finds the tab bodies', () => {
    expect(TAB_BODIES.map((b) => b.tab)).toContain('extensions')
    expect(TAB_BODIES.length).toBeGreaterThan(20)
  })

  it.each(TAB_BODIES.filter((b) => !CHILD_SCROLLS.has(b.tab)))('$tab tab has a scroll owner', ({ tab, classes }) => {
    const owner = SCROLL_OWNER[tab]
    if (owner) {
      expect(scrolls(resolveDecls(owner)), `${owner} must scroll`).toBe(true)
      return
    }
    expect(
      classes.some((c) => scrolls(resolveDecls(`.${c}`))),
      `one of ${classes.join(', ')} must set overflow-y: auto`,
    ).toBe(true)
  })

  it.each(['.extensions-scroll', '.marketplace-scroll'])(
    '%s fills the flex column and stacks its blocks vertically',
    (selector) => {
      const d = resolveDecls(selector)
      // flex: 1 + min-height: 0 lets it shrink below its content inside the
      // overflow-hidden .s-body column, which is what makes overflow-y apply.
      expect(d.flex).toBe('1')
      expect(d['min-height']).toBe('0')
      // A row flex here is the three-column layout that broke the page.
      expect(d.display === 'flex' && (d['flex-direction'] ?? 'row') === 'row').toBe(false)
    },
  )
})
