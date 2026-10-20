// AgentMessagesPanel badge colours. Every badge reads its colour from the theme
// tokens (so the light theme gets light-theme colours), and badges are split by
// shape the way the toast tiers are: state and source are solid pills, notes on
// how or what kind of message it was are outlined pills.
//
// Also locks the class collision that painted the from → to route as a badge:
// the route row and the delivery-path badge both used `.msg-route`, and the
// badge rule, coming later, restyled the whole route.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/components/AgentMessagesPanel.vue'),
  'utf8'
)
const template = source.slice(0, source.indexOf('<style'))
const style = source.slice(source.indexOf('<style'))

/** Declarations of the rule whose selector is exactly `selector`. */
function rule(selector: string): Record<string, string> {
  const rules = [...style.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(
    (m) => m[1].replace(/\/\*[\s\S]*?\*\//g, '').trim() === selector
  )
  expect(rules, `exactly one rule for ${selector}`).toHaveLength(1)
  const decls: Record<string, string> = {}
  for (const d of rules[0][2].replace(/\/\*[\s\S]*?\*\//g, '').split(';')) {
    const i = d.indexOf(':')
    if (i > 0) decls[d.slice(0, i).trim()] = d.slice(i + 1).trim()
  }
  return decls
}

const SOLID: [string, string, string][] = [
  [".msg-st[data-st='queued']", 'var(--text-secondary)', 'var(--bg-muted)'],
  [".msg-st[data-st='delivering']", 'var(--attention-fg)', 'var(--attention-subtle)'],
  [".msg-st[data-st='delivered']", 'var(--success-fg)', 'var(--success-subtle)'],
  [".msg-st[data-st='failed']", 'var(--danger-fg)', 'var(--danger-subtle)'],
  [".msg-st[data-st='cancelled']", 'var(--text-secondary)', 'var(--bg-muted)'],
  ['.msg-xws', 'var(--toast-workspace-accent)', 'var(--toast-workspace-bg)'],
  ['.msg-reply', 'var(--accent-fg)', 'var(--accent-subtle)'],
]

const OUTLINED = ['.msg-via', '.msg-notice']

describe('AgentMessagesPanel badge colours', () => {
  it('keeps the from → to route out of every badge rule', () => {
    // One `.msg-route` rule, and it is the route row's: no pill styling on it.
    const route = rule('.msg-route')
    expect(route.color).toBe('var(--text-primary)')
    expect(route).not.toHaveProperty('background')
    expect(route).not.toHaveProperty('border-radius')
    expect(route).not.toHaveProperty('white-space')
    // The via-hook / via-push badges carry their own class, not the route's.
    const routeTags = [...template.matchAll(/<(?:div|span)[^>]*class="msg-route"/g)]
    expect(routeTags).toHaveLength(1)
    expect(template).toMatch(/<div class="msg-route"/)
    expect(template).toMatch(/class="msg-via"[^>]*hook-badge-title/)
    expect(template).toMatch(/class="msg-via"\s*:title="\$t\(pushBadgeTitleKey/)
  })

  it.each(SOLID)('fills %s from theme tokens', (selector, fg, bg) => {
    const d = rule(selector)
    expect(d.color).toBe(fg)
    expect(d.background).toBe(bg)
    expect(d).not.toHaveProperty('box-shadow')
  })

  it.each(OUTLINED)('outlines %s with no fill', (selector) => {
    const d = rule(selector)
    expect(d.color).toBe('var(--text-secondary)')
    expect(d.background).toBe('transparent')
    expect(d['box-shadow']).toBe('inset 0 0 0 1px var(--border-default)')
  })

  it('uses no literal colour in any badge rule', () => {
    for (const selector of [...SOLID.map(([s]) => s), ...OUTLINED]) {
      for (const value of Object.values(rule(selector))) {
        expect(value, selector).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i)
      }
    }
  })
})
