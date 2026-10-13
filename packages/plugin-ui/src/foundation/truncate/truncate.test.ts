// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, ref, withDirectives } from 'vue'
import { mount } from '@vue/test-utils'
import { TRUNCATE_SHOW_DELAY_MS, isTruncated, tooltipText, vTruncate } from './truncate'

function box(el: HTMLElement, size: { sw: number; cw: number; sh?: number; ch?: number }): void {
  Object.defineProperty(el, 'scrollWidth', { configurable: true, get: () => size.sw })
  Object.defineProperty(el, 'clientWidth', { configurable: true, get: () => size.cw })
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => size.sh ?? 16 })
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => size.ch ?? 16 })
}

function tip(): HTMLElement | null {
  const el = document.querySelector<HTMLElement>('.navide-truncate-tip')
  return el && !el.hidden ? el : null
}

function hover(el: Element): void {
  el.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }))
}

const Row = defineComponent({
  props: { text: { type: String, default: 'Claude Code (Account B) · Commander' }, full: { type: String, default: undefined }, title: { type: String, default: undefined } },
  setup(props) {
    return () => withDirectives(h('span', { class: 'cell', title: props.title, tabindex: 0 }, props.text), [[vTruncate, props.full]])
  },
})

describe('isTruncated', () => {
  it('is true only when the text overflows its box', () => {
    const el = document.createElement('span')
    box(el, { sw: 200, cw: 120 })
    expect(isTruncated(el)).toBe(true)
    box(el, { sw: 120, cw: 120 })
    expect(isTruncated(el)).toBe(false)
  })

  it('measures height for line-clamped text', () => {
    const el = document.createElement('div')
    box(el, { sw: 100, cw: 100, sh: 64, ch: 32 })
    expect(isTruncated(el)).toBe(true)
  })

  it('treats code-shortened text as truncated whatever the box says', () => {
    const el = document.createElement('span')
    el.textContent = 'abcdef12…'
    el.dataset.truncateText = 'abcdef1234567890'
    box(el, { sw: 50, cw: 50 })
    expect(isTruncated(el)).toBe(true)
  })

  it('never reports an inline box', () => {
    const el = document.createElement('span')
    box(el, { sw: 0, cw: 0, sh: 0, ch: 0 })
    expect(isTruncated(el)).toBe(false)
  })
})

describe('tooltipText', () => {
  it('adds a title that says more than the text', () => {
    const el = document.createElement('span')
    el.textContent = 'pane name'
    expect(tooltipText(el, 'pane name\nRename')).toBe('pane name\nRename')
    expect(tooltipText(el, 'Double-click to rename')).toBe('pane name\nDouble-click to rename')
    expect(tooltipText(el, 'pane name')).toBe('pane name')
  })
})

describe('v-truncate tooltip', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.useRealTimers()
    document.body.innerHTML = ''
  })

  it('shows the full text after the delay only when the text is cut off', async () => {
    const w = mount(Row, { attachTo: document.body })
    const el = w.element as HTMLElement
    box(el, { sw: 300, cw: 120 })
    hover(el)
    vi.advanceTimersByTime(TRUNCATE_SHOW_DELAY_MS - 1)
    expect(tip()).toBeNull()
    vi.advanceTimersByTime(1)
    expect(tip()?.textContent).toBe('Claude Code (Account B) · Commander')
    expect(tip()?.getAttribute('role')).toBe('tooltip')
    expect(el.getAttribute('aria-describedby')).toBe(tip()?.id)
    w.unmount()
  })

  it('stays silent for text that fits', () => {
    const w = mount(Row, { attachTo: document.body })
    box(w.element as HTMLElement, { sw: 120, cw: 120 })
    hover(w.element)
    vi.advanceTimersByTime(TRUNCATE_SHOW_DELAY_MS * 2)
    expect(tip()).toBeNull()
    w.unmount()
  })

  it('takes over a native title while showing and puts it back after', () => {
    const w = mount(Row, { props: { title: 'Rename' }, attachTo: document.body })
    const el = w.element as HTMLElement
    box(el, { sw: 300, cw: 120 })
    hover(el)
    vi.advanceTimersByTime(TRUNCATE_SHOW_DELAY_MS)
    expect(el.hasAttribute('title')).toBe(false)
    expect(tip()?.textContent).toBe('Claude Code (Account B) · Commander\nRename')
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(tip()).toBeNull()
    expect(el.getAttribute('title')).toBe('Rename')
    expect(el.hasAttribute('aria-describedby')).toBe(false)
    w.unmount()
  })

  it('opens on keyboard focus too', () => {
    const w = mount(Row, { attachTo: document.body })
    const el = w.element as HTMLElement
    box(el, { sw: 300, cw: 120 })
    el.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    vi.advanceTimersByTime(TRUNCATE_SHOW_DELAY_MS)
    expect(tip()).not.toBeNull()
    el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    vi.advanceTimersByTime(200)
    expect(tip()).toBeNull()
    w.unmount()
  })

  it('uses the bound full text for text the code shortened', () => {
    const w = mount(Row, { props: { text: '1f7304e6…', full: '1f7304e6c0ffee' }, attachTo: document.body })
    box(w.element as HTMLElement, { sw: 60, cw: 60 })
    hover(w.element)
    vi.advanceTimersByTime(TRUNCATE_SHOW_DELAY_MS)
    expect(tip()?.textContent).toBe('1f7304e6c0ffee')
    w.unmount()
  })

  it('switches between cut-off rows without waiting again, and hides when the row goes away', async () => {
    const show = ref(true)
    const List = defineComponent({
      setup: () => () => h('div', [
        withDirectives(h('span', { class: 'a' }, 'first long name'), [[vTruncate]]),
        show.value ? withDirectives(h('span', { class: 'b' }, 'second long name'), [[vTruncate]]) : null,
      ]),
    })
    const w = mount(List, { attachTo: document.body })
    const a = w.find('.a').element as HTMLElement
    const b = w.find('.b').element as HTMLElement
    box(a, { sw: 300, cw: 100 })
    box(b, { sw: 300, cw: 100 })
    hover(a)
    vi.advanceTimersByTime(TRUNCATE_SHOW_DELAY_MS)
    hover(b)
    expect(tip()?.textContent).toBe('second long name')
    show.value = false
    await w.vm.$nextTick()
    expect(tip()).toBeNull()
    w.unmount()
  })
})
