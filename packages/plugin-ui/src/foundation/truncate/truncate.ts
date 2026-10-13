import type { Directive } from 'vue'

/**
 * Full text on hover for text that is cut off with an ellipsis.
 *
 * `v-truncate` only marks the element (`data-truncate`, plus the full text when
 * the bound value is a string — for text the code shortened itself). Nothing is
 * measured at render time: one delegated listener per document measures the
 * element the pointer (or keyboard focus) rests on, and only text that really
 * overflows gets the shared tooltip. Long lists cost one attribute per row.
 *
 * Put the directive on the element that clips (`overflow: hidden` with
 * `text-overflow: ellipsis` or `-webkit-line-clamp`); that is the box measured.
 */

export const TRUNCATE_ATTR = 'data-truncate'
/** The tooltip waits this long before it appears (moving between rows while one
 *  is showing switches instantly). */
export const TRUNCATE_SHOW_DELAY_MS = 350
const HIDE_GRACE_MS = 120
const MAX_CHARS = 2000
const TIP_CLASS = 'navide-truncate-tip'

type Value = string | null | undefined | boolean

function mark(el: HTMLElement, value: Value): void {
  el.setAttribute(TRUNCATE_ATTR, '')
  if (typeof value === 'string') el.dataset.truncateText = value
  else delete el.dataset.truncateText
}

export const vTruncate: Directive<HTMLElement, Value> = {
  mounted(el, binding) {
    mark(el, binding.value)
    installTruncateTooltip(el.ownerDocument)
  },
  updated(el, binding) {
    mark(el, binding.value)
  },
  beforeUnmount(el) {
    stateOf(el.ownerDocument)?.release(el)
  },
}

function displayed(el: HTMLElement): string {
  return (el.textContent ?? '').replace(/\s+/g, ' ').trim()
}

/** True when the element's text does not fit: wider or taller than its box, or
 *  the code shortened it (the bound full text differs from what is shown). */
export function isTruncated(el: HTMLElement): boolean {
  const full = el.dataset.truncateText
  if (full !== undefined && full.replace(/\s+/g, ' ').trim() !== displayed(el)) return true
  // An inline box measures 0 x 0 and cannot be clipped.
  if (el.clientWidth === 0 && el.clientHeight === 0) return false
  return el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1
}

/** What the tooltip says: the full text, plus the element's own title when that
 *  carries more than the text (an action hint, a path). */
export function tooltipText(el: HTMLElement, title: string): string {
  const full = (el.dataset.truncateText ?? el.textContent ?? '').trim()
  const extra = title.trim()
  let text = full
  if (extra && extra !== full) text = extra.includes(full) ? extra : `${full}\n${extra}`
  return text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS - 1)}…` : text
}

const STYLE = `
.${TIP_CLASS}{position:fixed;z-index:2147483000;max-width:min(420px,calc(100vw - 16px));
padding:6px 9px;border-radius:6px;border:1px solid var(--border-default,#30363d);
background:var(--bg-overlay,#161b22);color:var(--text-bright,#e6edf3);
font:12px/1.45 -apple-system,BlinkMacSystemFont,"PingFang TC","Segoe UI",sans-serif;
white-space:pre-wrap;overflow-wrap:anywhere;box-shadow:0 8px 24px rgba(1,4,9,.45);pointer-events:auto}
.${TIP_CLASS}[hidden]{display:none}`

interface DocState {
  release(el: HTMLElement): void
}

const states = new WeakMap<Document, DocState>()

function stateOf(doc: Document | null | undefined): DocState | undefined {
  return doc ? states.get(doc) : undefined
}

/** Installs the delegated listeners and the shared tooltip for one document.
 *  Safe to call repeatedly; `v-truncate` calls it on mount. */
export function installTruncateTooltip(doc: Document | null | undefined = globalThis.document): void {
  if (!doc || states.has(doc)) return
  const win = doc.defaultView
  if (!win) return

  let tip: HTMLDivElement | null = null
  let target: HTMLElement | null = null
  let pending: HTMLElement | null = null
  let showTimer: ReturnType<typeof setTimeout> | undefined
  let hideTimer: ReturnType<typeof setTimeout> | undefined
  let stashedTitle: string | null = null
  let prevDescribedBy: string | null = null
  let observer: ResizeObserver | null = null
  const tipId = `navide-truncate-tip-${Math.random().toString(36).slice(2, 8)}`

  function ensureTip(): HTMLDivElement {
    if (tip && tip.isConnected) return tip
    if (!doc!.getElementById(`${TIP_CLASS}-style`)) {
      const style = doc!.createElement('style')
      style.id = `${TIP_CLASS}-style`
      style.textContent = STYLE
      doc!.head.appendChild(style)
    }
    tip = doc!.createElement('div')
    tip.className = TIP_CLASS
    tip.id = tipId
    tip.setAttribute('role', 'tooltip')
    tip.hidden = true
    doc!.body.appendChild(tip)
    return tip
  }

  function restore(el: HTMLElement): void {
    if (stashedTitle !== null) el.setAttribute('title', stashedTitle)
    stashedTitle = null
    if (prevDescribedBy === null) el.removeAttribute('aria-describedby')
    else el.setAttribute('aria-describedby', prevDescribedBy)
    prevDescribedBy = null
  }

  function hide(): void {
    clearTimeout(showTimer)
    clearTimeout(hideTimer)
    pending = null
    observer?.disconnect()
    if (target) restore(target)
    target = null
    if (tip) tip.hidden = true
  }

  function place(el: HTMLElement, box: HTMLDivElement): void {
    const r = el.getBoundingClientRect()
    const vw = win!.innerWidth
    const vh = win!.innerHeight
    const w = box.offsetWidth
    const h = box.offsetHeight
    let top = r.bottom + 6
    if (top + h > vh - 8 && r.top - h - 6 >= 8) top = r.top - h - 6
    const left = Math.max(8, Math.min(r.left, vw - w - 8))
    box.style.top = `${Math.round(top)}px`
    box.style.left = `${Math.round(left)}px`
  }

  function show(el: HTMLElement): void {
    if (!el.isConnected || !isTruncated(el)) return
    if (target && target !== el) restore(target)
    const title = el.getAttribute('title') ?? stashedTitle ?? ''
    // A native title would pop up a second tooltip over ours.
    if (target !== el && el.hasAttribute('title')) {
      stashedTitle = el.getAttribute('title')
      el.removeAttribute('title')
    }
    const box = ensureTip()
    box.textContent = tooltipText(el, title)
    box.hidden = false
    if (target !== el) {
      prevDescribedBy = el.getAttribute('aria-describedby')
      el.setAttribute('aria-describedby', prevDescribedBy ? `${prevDescribedBy} ${tipId}` : tipId)
    }
    target = el
    place(el, box)
    observer?.disconnect()
    if (typeof win!.ResizeObserver === 'function') {
      let first = true
      observer = new win!.ResizeObserver(() => {
        // The first callback reports the current size; later ones mean it changed.
        if (first) { first = false; return }
        hide()
      })
      observer.observe(el)
    }
  }

  function enter(el: HTMLElement): void {
    clearTimeout(hideTimer)
    if (el === target || el === pending) return
    clearTimeout(showTimer)
    pending = el
    if (target) {
      show(el)
      if (target !== el) hide()
      pending = null
      return
    }
    showTimer = setTimeout(() => {
      pending = null
      show(el)
    }, TRUNCATE_SHOW_DELAY_MS)
  }

  function leaveSoon(): void {
    clearTimeout(showTimer)
    pending = null
    clearTimeout(hideTimer)
    hideTimer = setTimeout(hide, HIDE_GRACE_MS)
  }

  const marked = (node: EventTarget | null): HTMLElement | null =>
    node instanceof win!.Element ? (node.closest(`[${TRUNCATE_ATTR}]`) as HTMLElement | null) : null

  doc.addEventListener('pointerover', (e) => {
    if (tip && e.target instanceof win!.Node && tip.contains(e.target)) {
      clearTimeout(hideTimer) // the tooltip itself can be hovered (WCAG 1.4.13)
      return
    }
    const el = marked(e.target)
    if (el) enter(el)
    else if (target || pending) leaveSoon()
  }, true)
  doc.addEventListener('pointerout', (e) => {
    const to = (e as PointerEvent).relatedTarget
    if (to === null) leaveSoon()
  }, true)
  doc.addEventListener('focusin', (e) => {
    const el = marked(e.target)
    if (el) enter(el)
  }, true)
  doc.addEventListener('focusout', () => leaveSoon(), true)
  doc.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && target) hide()
  }, true)
  doc.addEventListener('pointerdown', (e) => {
    if (tip && e.target instanceof win!.Node && tip.contains(e.target)) return
    hide()
  }, true)
  doc.addEventListener('scroll', (e) => {
    if (tip && e.target instanceof win!.Node && tip.contains(e.target)) return
    if (target || pending) hide()
  }, true)
  win.addEventListener('blur', hide)

  states.set(doc, {
    release(el) {
      if (el === target || el === pending) hide()
    },
  })
}
