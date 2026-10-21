import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useNotify } from '../useNotify'

const n = useNotify()

describe('useNotify', () => {
  beforeEach(() => {
    // Singleton module state — reset queue + any open dialog between tests.
    n.toasts.value.slice().forEach((t) => n.dismissToast(t.id))
    if (n.dialog.value) n.resolveDialog(false)
  })

  // ── Toast ─────────────────────────────────────────────────────────────────
  it('toast pushes onto the queue with default info type', () => {
    n.toast('hello')
    expect(n.toasts.value).toHaveLength(1)
    expect(n.toasts.value[0].message).toBe('hello')
    expect(n.toasts.value[0].type).toBe('info')
  })

  it('keeps a plain toast to exactly id, message and type (no variant fields)', () => {
    n.toast('plain', { type: 'error', duration: 1000 })
    expect(Object.keys(n.toasts.value[0]).sort()).toEqual(['id', 'message', 'type'])
  })

  it('carries an opt-in variant, title and icon without changing type or duration', () => {
    vi.useFakeTimers()
    try {
      n.toast('from afar', { type: 'info', variant: 'external', title: 'Remote device · mac', icon: '⇄', duration: 8000 })
      const t = n.toasts.value[0]
      expect(t).toMatchObject({ message: 'from afar', type: 'info', variant: 'external', title: 'Remote device · mac', icon: '⇄' })
      vi.advanceTimersByTime(7999)
      expect(n.toasts.value).toHaveLength(1)
      vi.advanceTimersByTime(1)
      expect(n.toasts.value).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('carries an opt-in action button and leaves it off a plain toast', () => {
    const run = vi.fn()
    n.toast('closed', { action: { label: 'Undo', run } })
    const t = n.toasts.value[0]
    expect(t.action?.label).toBe('Undo')
    t.action?.run()
    expect(run).toHaveBeenCalledTimes(1)
    n.toast('plain')
    expect('action' in n.toasts.value[1]).toBe(false)
  })

  it('toast honors an explicit type', () => {
    n.toast('done', { type: 'success' })
    expect(n.toasts.value[0].type).toBe('success')
  })

  it('toasts stack with unique ids', () => {
    n.toast('a')
    n.toast('b')
    const ids = n.toasts.value.map((t) => t.id)
    expect(n.toasts.value).toHaveLength(2)
    expect(new Set(ids).size).toBe(2)
  })

  it('toast auto-dismisses after its duration', () => {
    vi.useFakeTimers()
    try {
      n.toast('bye', { duration: 1000 })
      expect(n.toasts.value).toHaveLength(1)
      vi.advanceTimersByTime(999)
      expect(n.toasts.value).toHaveLength(1)
      vi.advanceTimersByTime(1)
      expect(n.toasts.value).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('toast with duration 0 never auto-dismisses', () => {
    vi.useFakeTimers()
    try {
      n.toast('sticky', { duration: 0 })
      vi.advanceTimersByTime(100000)
      expect(n.toasts.value).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('dismissToast removes the matching toast only', () => {
    n.toast('a')
    n.toast('b')
    const firstId = n.toasts.value[0].id
    n.dismissToast(firstId)
    expect(n.toasts.value).toHaveLength(1)
    expect(n.toasts.value[0].message).toBe('b')
  })

  // ── Alert ───────────────────────────────────────────────────────────────────
  it('alert opens a blocking dialog and resolves when acknowledged', async () => {
    const p = n.alert('something failed', { title: 'Error' })
    expect(n.dialog.value?.kind).toBe('alert')
    expect(n.dialog.value?.title).toBe('Error')
    expect(n.dialog.value?.message).toBe('something failed')
    n.resolveDialog(true)
    await expect(p).resolves.toBeUndefined()
    expect(n.dialog.value).toBeNull()
  })

  // ── Confirm ─────────────────────────────────────────────────────────────────
  it('confirm resolves true when confirmed', async () => {
    const p = n.confirm('delete it?')
    expect(n.dialog.value?.kind).toBe('confirm')
    n.resolveDialog(true)
    await expect(p).resolves.toBe(true)
    expect(n.dialog.value).toBeNull()
  })

  it('confirm resolves false when cancelled', async () => {
    const p = n.confirm('delete it?', { confirmText: '刪除', cancelText: '取消' })
    expect(n.dialog.value?.confirmText).toBe('刪除')
    expect(n.dialog.value?.cancelText).toBe('取消')
    n.resolveDialog(false)
    await expect(p).resolves.toBe(false)
  })

  it('caps toasts at MAX_TOASTS (6) by evicting the oldest', () => {
    for (let i = 0; i < 7; i++) {
      n.toast(`toast-${i}`)
    }
    expect(n.toasts.value).toHaveLength(6)
    const messages = n.toasts.value.map((t) => t.message)
    expect(messages).toEqual(['toast-1', 'toast-2', 'toast-3', 'toast-4', 'toast-5', 'toast-6'])
  })

  it('clears timer when dismissing a toast so auto-dismiss does not re-fire', () => {
    vi.useFakeTimers()
    try {
      n.toast('timed', { duration: 5000 })
      const toastId = n.toasts.value[0].id
      expect(n.toasts.value).toHaveLength(1)
      n.dismissToast(toastId)
      expect(n.toasts.value).toHaveLength(0)
      vi.advanceTimersByTime(5000)
      expect(n.toasts.value).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })

  // ── Prompt ────────────────────────────────────────────────────────────────
  it('prompt resolves with the entered text on confirm', async () => {
    const p = n.prompt('Name?', { defaultValue: 'seed' })
    expect(n.dialog.value?.kind).toBe('prompt')
    expect(n.promptValue.value).toBe('seed')
    n.promptValue.value = 'edited'
    n.resolveDialog(true)
    await expect(p).resolves.toBe('edited')
    expect(n.dialog.value).toBeNull()
  })

  it('prompt resolves null on cancel', async () => {
    const p = n.prompt('Name?', { defaultValue: 'seed' })
    n.resolveDialog(false)
    await expect(p).resolves.toBeNull()
  })

  it('superseding a prompt resolves the old one with null', async () => {
    const first = n.prompt('First?')
    const second = n.prompt('Second?')
    await expect(first).resolves.toBeNull()
    n.resolveDialog(true)
    await expect(second).resolves.toBe('')
  })

  // ── Confirm opt-out checkbox ──────────────────────────────────────────────
  it('confirm carries a checkbox label only when asked for one', async () => {
    const plain = n.confirm('Sure?')
    expect(n.dialog.value?.checkboxLabel).toBeUndefined()
    n.resolveDialog(true)
    await plain

    const opt = n.confirm('Sure?', { checkboxLabel: "Don't ask again" })
    expect(n.dialog.value?.checkboxLabel).toBe("Don't ask again")
    n.resolveDialog(true)
    await opt
  })

  it('exposes the ticked state after the promise settles', async () => {
    const p = n.confirm('Sure?', { checkboxLabel: 'Skip next time' })
    n.dialogCheckbox.value = true
    n.resolveDialog(true)
    await expect(p).resolves.toBe(true)
    // Read after the await — that is how the caller sees it.
    expect(n.dialogCheckbox.value).toBe(true)
  })

  it('resets the checkbox for each confirm so a stale tick never carries over', async () => {
    const first = n.confirm('First?', { checkboxLabel: 'Skip next time' })
    n.dialogCheckbox.value = true
    n.resolveDialog(true)
    await first

    const second = n.confirm('Second?', { checkboxLabel: 'Skip next time' })
    expect(n.dialogCheckbox.value).toBe(false)
    n.resolveDialog(true)
    await second
  })

  it('marks a confirm as danger only when asked, leaving the default dialog unchanged', async () => {
    const plain = n.confirm('Sure?', { title: 'T', confirmText: 'OK' })
    // No `danger` key at all: existing confirms render exactly as before.
    expect(n.dialog.value).not.toHaveProperty('danger')
    n.resolveDialog(true)
    await plain

    const destructive = n.confirm('Remove it?', { danger: true })
    expect(n.dialog.value?.danger).toBe(true)
    n.resolveDialog(false)
    expect(await destructive).toBe(false)
  })
})
