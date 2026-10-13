// @vitest-environment happy-dom
// The guided tour walks data-driven steps over the live window. Rendered via
// <Teleport to="body">, so every query goes to document.body.
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { i18n } from '@navide/plugin-ui/foundation'

import GuidedTour from '../GuidedTour.vue'
import type { TourPrepare, TourStep } from '../../lib/tours'
import { whatsNewFor } from '../../lib/whatsNew'

const STEPS: TourStep[] = [
  { id: 'one', titleKey: 'tour.v0_2_10.welcome.title', bodyKey: 'tour.v0_2_10.welcome.body' },
  {
    id: 'two',
    anchor: '#target',
    prepare: { kind: 'settings', tab: 'channels' },
    titleKey: 'tour.v0_2_10.channelsSettings.title',
    bodyKey: 'tour.v0_2_10.channelsSettings.body',
    missingKey: 'tour.v0_2_10.channelsSettings.missing',
  },
  { id: 'three', titleKey: 'tour.v0_2_10.done.title', bodyKey: 'tour.v0_2_10.done.body' },
]

let wrapper: ReturnType<typeof mount> | null = null

function start(steps: TourStep[], runPrepare?: (p: TourPrepare) => void | Promise<void>) {
  wrapper = mount(GuidedTour, {
    props: { steps, runPrepare, anchorTimeoutMs: 300 },
    global: { plugins: [i18n] },
  })
  return wrapper
}

const card = (): HTMLElement | null => document.body.querySelector<HTMLElement>('.tour-card')
const stepId = (): string | undefined => card()?.dataset.step
const click = (testid: string): void =>
  document.body.querySelector<HTMLElement>(`[data-testid="${testid}"]`)!.click()
function key(k: string, target: EventTarget = document.body): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })
  target.dispatchEvent(e)
  return e
}
/** Let a step finish its prepare and its anchor lookup. */
async function settle(): Promise<void> {
  await flushPromises()
  await vi.advanceTimersByTimeAsync(400)
  await flushPromises()
}

function addTarget(): HTMLElement {
  const el = document.createElement('div')
  el.id = 'target'
  vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
    x: 100, y: 100, top: 100, left: 100, right: 300, bottom: 150, width: 200, height: 50,
    toJSON: () => ({}),
  } as DOMRect)
  document.body.append(el)
  return el
}

beforeEach(() => {
  vi.useFakeTimers()
  i18n.global.locale.value = 'en-US'
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.replaceChildren()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('GuidedTour', () => {
  it('starts at the first step with its progress, title and body', async () => {
    start(STEPS)
    await settle()
    expect(stepId()).toBe('one')
    expect(card()?.textContent).toContain('Step 1 of 3')
    expect(card()?.textContent).toContain(i18n.global.t('tour.v0_2_10.welcome.title'))
    expect(card()?.getAttribute('role')).toBe('dialog')
    // No Back on the first step.
    expect(document.body.querySelector('[data-testid="tour-back"]')).toBeNull()
  })

  it('moves forward and back with the buttons', async () => {
    addTarget()
    start(STEPS)
    await settle()
    click('tour-next')
    await settle()
    expect(stepId()).toBe('two')
    click('tour-back')
    await settle()
    expect(stepId()).toBe('one')
  })

  it('runs each step’s prepare before looking for its anchor', async () => {
    const calls: TourPrepare[] = []
    start(STEPS, (p) => {
      calls.push(p)
      addTarget() // the anchor only exists once Settings is open
    })
    await settle()
    expect(calls).toEqual([])
    click('tour-next')
    await settle()
    expect(calls).toEqual([{ kind: 'settings', tab: 'channels' }])
    expect(document.body.querySelector('[data-testid="tour-hole"]')).not.toBeNull()
    expect(document.body.querySelector('[data-testid="tour-missing"]')).toBeNull()
  })

  it('spotlights a found anchor and places the card beside it', async () => {
    addTarget()
    start(STEPS)
    await settle()
    click('tour-next')
    await settle()
    const hole = document.body.querySelector<HTMLElement>('[data-testid="tour-hole"]')!
    expect(hole.style.top).toBe('94px')
    expect(hole.style.width).toBe('212px')
    expect(card()?.classList.contains('centred')).toBe(false)
    expect(card()?.style.top).toBe('168px')
  })

  it('shows a missing anchor as a centred card with where-to-find-it text', async () => {
    start(STEPS)
    await settle()
    click('tour-next')
    await settle()
    expect(stepId()).toBe('two')
    expect(document.body.querySelector('[data-testid="tour-hole"]')).toBeNull()
    expect(card()?.classList.contains('centred')).toBe(true)
    expect(document.body.querySelector('[data-testid="tour-missing"]')?.textContent).toContain(
      i18n.global.t('tour.v0_2_10.channelsSettings.missing'),
    )
    // …and the tour carries on.
    click('tour-next')
    await settle()
    expect(stepId()).toBe('three')
  })

  it('does not wait for an anchor on a step with no prepare: a missing one shows at once', async () => {
    // No prepare means the window is already as the step expects it, so the
    // anchor is either there now or not at all — the 2s budget is for prepare.
    wrapper = mount(GuidedTour, {
      props: {
        steps: [
          { id: 'here', anchor: '#nowhere', titleKey: 'tour.next', bodyKey: 'tour.back', missingKey: 'tour.skip' },
        ],
        anchorTimeoutMs: 2000,
      },
      global: { plugins: [i18n] },
    })
    await flushPromises()
    await vi.advanceTimersByTimeAsync(100)
    await flushPromises()
    expect(stepId()).toBe('here')
    expect(card()?.classList.contains('centred')).toBe(true)
    expect(document.body.querySelector('[data-testid="tour-missing"]')).not.toBeNull()
  })

  it('still waits up to the budget for an anchor that a step’s prepare brings in', async () => {
    start(STEPS, () => {
      setTimeout(addTarget, 200) // Settings takes a moment to render its page
    })
    await settle()
    click('tour-next')
    await flushPromises()
    await vi.advanceTimersByTimeAsync(260)
    await flushPromises()
    expect(stepId()).toBe('two')
    expect(document.body.querySelector('[data-testid="tour-hole"]')).not.toBeNull()
    expect(document.body.querySelector('[data-testid="tour-missing"]')).toBeNull()
  })

  it('draws a prepare step’s card at once, centred, while its prepare runs', async () => {
    start(STEPS, () => new Promise<void>(() => {}))
    await settle()
    click('tour-next')
    await flushPromises()
    expect(stepId()).toBe('two')
    expect(card()?.classList.contains('centred')).toBe(true)
    // Not "missing" yet: the lookup has not finished.
    expect(document.body.querySelector('[data-testid="tour-missing"]')).toBeNull()
  })

  it('keeps the previous card on screen while the next step looks for its anchor', async () => {
    addTarget()
    start([
      { id: 'first', titleKey: 'tour.next', bodyKey: 'tour.back' },
      { id: 'second', anchor: '#target', titleKey: 'tour.back', bodyKey: 'tour.next', missingKey: 'tour.skip' },
    ])
    await settle()
    expect(stepId()).toBe('first')
    click('tour-next')
    await flushPromises()
    // Never an empty dimmed window between two cards.
    expect(card()).not.toBeNull()
    await vi.advanceTimersByTimeAsync(100)
    await flushPromises()
    expect(stepId()).toBe('second')
    expect(document.body.querySelector('[data-testid="tour-hole"]')).not.toBeNull()
  })

  it('keeps going when a step’s prepare throws', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    start(STEPS, () => {
      throw new Error('settings would not open')
    })
    await settle()
    click('tour-next')
    await settle()
    expect(stepId()).toBe('two')
    expect(document.body.querySelector('[data-testid="tour-missing"]')).not.toBeNull()
  })

  it('does not let a slow earlier lookup overwrite the current step', async () => {
    let release: () => void = () => {}
    const calls: TourPrepare[] = []
    start(STEPS, (p) => {
      calls.push(p)
      return new Promise<void>((r) => {
        release = r
      })
    })
    await settle()
    click('tour-next') // step two: prepare pending, card not drawn yet
    await flushPromises()
    key('ArrowLeft') // back to step one before it resolves
    await settle()
    addTarget()
    release()
    await settle()
    expect(stepId()).toBe('one')
    expect(document.body.querySelector('[data-testid="tour-hole"]')).toBeNull()
  })

  it('still shows the step when its prepare never settles', async () => {
    start(STEPS, () => new Promise<void>(() => {}))
    await settle()
    click('tour-next')
    await settle()
    await settle()
    expect(stepId()).toBe('two')
    expect(document.body.querySelector('[data-testid="tour-missing"]')).not.toBeNull()
  })

  it('emits close(true) from Done on the last step, and has no Skip there', async () => {
    const w = start(STEPS)
    await settle()
    click('tour-next')
    await settle()
    click('tour-next')
    await settle()
    expect(stepId()).toBe('three')
    expect(document.body.querySelector('[data-testid="tour-skip"]')).toBeNull()
    expect(document.body.querySelector('[data-testid="tour-next"]')?.textContent).toContain('Done')
    click('tour-next')
    expect(w.emitted('close')).toEqual([[true]])
  })

  it('emits close(false) from Skip', async () => {
    const w = start(STEPS)
    await settle()
    click('tour-skip')
    expect(w.emitted('close')).toEqual([[false]])
  })

  it('handles →, ← and Esc, and keeps them from reaching the window beneath', async () => {
    const beneath = vi.fn()
    window.addEventListener('keydown', beneath)
    const w = start(STEPS)
    await settle()
    key('ArrowRight')
    await settle()
    expect(stepId()).toBe('two')
    key('ArrowLeft')
    await settle()
    expect(stepId()).toBe('one')
    const esc = key('Escape')
    expect(esc.defaultPrevented).toBe(true)
    expect(w.emitted('close')).toEqual([[false]])
    expect(beneath).not.toHaveBeenCalled()
    window.removeEventListener('keydown', beneath)
  })

  it('swallows typing aimed at the dimmed window', async () => {
    start(STEPS)
    await settle()
    expect(key('a').defaultPrevented).toBe(true)
    // …but not app shortcuts such as ⌘Q.
    const quit = new KeyboardEvent('keydown', { key: 'q', metaKey: true, bubbles: true, cancelable: true })
    document.body.dispatchEvent(quit)
    expect(quit.defaultPrevented).toBe(false)
  })

  it('moves focus to the primary button and keeps Tab inside the card', async () => {
    start(STEPS)
    await settle()
    const next = document.body.querySelector<HTMLElement>('[data-testid="tour-next"]')!
    expect(document.activeElement).toBe(next)
    key('Tab', next)
    expect(document.activeElement).toBe(document.body.querySelector('[data-testid="tour-skip"]'))
    key('Tab', document.activeElement!)
    expect(document.activeElement).toBe(next)
  })

  it('gives focus back to where it was once the tour unmounts', async () => {
    const before = document.createElement('button')
    document.body.append(before)
    before.focus()
    const w = start(STEPS)
    await settle()
    expect(document.activeElement).toBe(document.body.querySelector('[data-testid="tour-next"]'))
    w.unmount()
    wrapper = null
    expect(document.activeElement).toBe(before)
  })

  it('leaves focus alone on unmount when the element focused before is gone', async () => {
    const before = document.createElement('button')
    document.body.append(before)
    before.focus()
    const w = start(STEPS)
    await settle()
    before.remove()
    const focus = vi.spyOn(before, 'focus')
    w.unmount()
    wrapper = null
    expect(focus).not.toHaveBeenCalled()
  })

  it('walks the real 0.2.10 tour to the end with no anchors present', async () => {
    const steps = whatsNewFor('0.2.10')!.tour!
    const prepares: TourPrepare[] = []
    const w = start(steps, (p) => {
      prepares.push(p)
    })
    const seen: string[] = []
    for (let i = 0; i < steps.length; i++) {
      await settle()
      seen.push(stepId()!)
      click('tour-next')
    }
    expect(seen).toEqual(steps.map((s) => s.id))
    expect(prepares.map((p) => (p.kind === 'settings' ? p.tab : p.kind))).toEqual([
      'close-settings',
      'channels',
      'close-settings',
      'voice',
      'close-settings',
    ])
    expect(w.emitted('close')).toEqual([[true]])
  })
})
