// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { findTourAnchor, tourDoneKey, tourI18nNamespace } from '../tours'
import { WHATS_NEW } from '../whatsNew'

const LOCALES = ['en-US', 'zh-TW', 'ja-JP'].map((code) => ({
  code,
  messages: JSON.parse(
    readFileSync(
      resolve(process.cwd(), `src/renderer/src/i18n/locales/${code}.json`),
      'utf8',
    ),
  ) as Record<string, unknown>,
}))

function lookup(messages: Record<string, unknown>, key: string): unknown {
  return key.split('.').reduce<unknown>(
    (node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined),
    messages,
  )
}

// Tours live on release announcements (WhatsNewEntry.tour). Everything a
// release author can get wrong in one should fail here, not in front of users.
const TOURED = WHATS_NEW.filter((entry) => entry.tour)

// A syntax check stricter than happy-dom's matcher: the real browser parser
// runs in the renderer, so an unbalanced bracket or quote must fail here.
function assertSelector(selector: string): void {
  expect(() => document.querySelectorAll(selector), selector).not.toThrow()
  let depth = 0
  let quote = ''
  for (const ch of selector) {
    if (quote) {
      if (ch === quote) quote = ''
    } else if (ch === '"' || ch === "'") quote = ch
    else if (ch === '[' || ch === '(') depth++
    else if (ch === ']' || ch === ')') depth--
    expect(depth, selector).toBeGreaterThanOrEqual(0)
  }
  expect(quote, selector).toBe('')
  expect(depth, selector).toBe(0)
  expect(selector.trim(), selector).not.toBe('')
}

describe('every release tour (WhatsNewEntry.tour)', () => {
  it('exists on at least the 0.2.10 announcement', () => {
    expect(TOURED.map((e) => e.version)).toContain('0.2.10')
  })

  it('has steps, with ids unique within the tour', () => {
    for (const entry of TOURED) {
      const steps = entry.tour!
      expect(steps.length, entry.version).toBeGreaterThan(0)
      expect(new Set(steps.map((s) => s.id)).size, entry.version).toBe(steps.length)
    }
  })

  it('keeps its text under the version’s own namespace, in every locale', () => {
    for (const entry of TOURED) {
      const ns = tourI18nNamespace(entry.version) + '.'
      for (const step of entry.tour!) {
        const keys = [step.titleKey, step.bodyKey, ...(step.missingKey ? [step.missingKey] : [])]
        for (const key of keys) {
          expect(key.startsWith(ns), `${entry.version}/${step.id}: ${key} outside ${ns}`).toBe(true)
          for (const { code, messages } of LOCALES) {
            const value = lookup(messages, key)
            expect(typeof value, `${code} ${entry.version}/${step.id} ${key}`).toBe('string')
            expect((value as string).trim(), `${code} ${key}`).not.toBe('')
          }
        }
      }
    }
  })

  it('points with a valid selector, and says where to look when it cannot', () => {
    for (const entry of TOURED) {
      for (const step of entry.tour!) {
        if (!step.anchor) continue
        assertSelector(step.anchor)
        expect(step.missingKey, `${entry.version}/${step.id}`).toBeTruthy()
      }
    }
  })

  it('leaves no tour text behind for a version whose announcement has no tour', () => {
    // tour.<generic chrome> is shared; every tour.v<x_y_z> must belong to a tour.
    const owned = new Set(TOURED.map((e) => tourI18nNamespace(e.version).slice('tour.'.length)))
    for (const { code, messages } of LOCALES) {
      const tour = messages.tour as Record<string, unknown>
      const versioned = Object.keys(tour).filter((k) => /^v\d+_\d+_\d+$/.test(k))
      for (const ns of versioned) expect(owned.has(ns), `${code} tour.${ns} has no tour`).toBe(true)
    }
  })

  it('uses the generic tour chrome in every locale', () => {
    for (const { code, messages } of LOCALES) {
      for (const key of ['progress', 'next', 'back', 'skip', 'done']) {
        expect(typeof lookup(messages, `tour.${key}`), `${code} tour.${key}`).toBe('string')
      }
    }
  })

  it('walks 0.2.10 through Channels then Voice Input, pointing at the real UI', () => {
    const steps = WHATS_NEW.find((e) => e.version === '0.2.10')!.tour!
    expect(steps.map((s) => s.id)).toEqual([
      'welcome',
      'channels-settings',
      'channels-pane',
      'voice-settings',
      'voice-dictate',
      'done',
    ])
    expect(steps[1].prepare).toEqual({ kind: 'settings', tab: 'channels' })
    expect(steps[1].anchor).toBe('[data-settings-section="channels"]')
    expect(steps[2].anchor).toContain('[data-testid="channel-connect"]')
    expect(steps[3].prepare).toEqual({ kind: 'settings', tab: 'voice' })
    expect(steps[3].anchor).toBe('[data-settings-section="voice"]')
    // Every step after a Settings step closes it again before pointing at the window.
    expect(steps[2].prepare).toEqual({ kind: 'close-settings' })
    expect(steps[4].prepare).toEqual({ kind: 'close-settings' })
  })
})

describe('tour keys', () => {
  it('keeps the done flag where 0.2.10 first wrote it', () => {
    expect(tourDoneKey('0.2.10')).toBe('agentTeam.tour.v0.2.10.done')
  })

  it('derives the i18n namespace from the version', () => {
    expect(tourI18nNamespace('0.2.10')).toBe('tour.v0_2_10')
  })

  it('rejects an unbalanced selector', () => {
    expect(() => assertSelector('[data-x="a"')).toThrow()
  })
})

describe('findTourAnchor', () => {
  afterEach(() => {
    document.body.replaceChildren()
    vi.restoreAllMocks()
  })

  function sized(el: HTMLElement, w: number, h: number): HTMLElement {
    vi.spyOn(el, 'getBoundingClientRect').mockReturnValue(
      { x: 0, y: 0, top: 0, left: 0, right: w, bottom: h, width: w, height: h, toJSON: () => ({}) } as DOMRect,
    )
    return el
  }

  it('returns null when nothing matches', () => {
    expect(findTourAnchor('[data-testid="channel-connect"]')).toBeNull()
  })

  it('returns null for a selector the browser rejects, instead of throwing', () => {
    expect(findTourAnchor('[[[')).toBeNull()
  })

  it('skips a match with no box (a v-show-hidden Settings page) for a laid-out one', () => {
    const hidden = sized(document.createElement('div'), 0, 0)
    const shown = sized(document.createElement('div'), 200, 100)
    hidden.dataset.settingsSection = 'voice'
    shown.dataset.settingsSection = 'voice'
    document.body.append(hidden, shown)
    expect(findTourAnchor('[data-settings-section="voice"]')).toBe(shown)
  })

  it('treats a match that is only hidden as missing', () => {
    const hidden = sized(document.createElement('div'), 0, 0)
    hidden.dataset.settingsSection = 'voice'
    document.body.append(hidden)
    expect(findTourAnchor('[data-settings-section="voice"]')).toBeNull()
  })
})
