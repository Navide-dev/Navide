import { readonly, ref } from 'vue'

/**
 * Modular notification system — Toast / Alert / Confirm / Prompt.
 *
 * Singleton module-level state so any component can `useNotify()` and fire
 * notifications without prop drilling. Rendering lives in NotificationHost.vue
 * (mounted once at the App root).
 */

export type ToastType = 'success' | 'error' | 'info'

/** Opt-in emphasis on top of the type: `external` for content from another
 *  machine, `channel` for a chat channel, `security` for Guard, `workspace`
 *  for another local workspace. Absent means the ordinary toast. */
export type ToastVariant = 'external' | 'channel' | 'security' | 'workspace'

export interface Toast {
  id: number
  message: string
  type: ToastType
  variant?: ToastVariant
  /** Header line above the message (the source of the toast). */
  title?: string
  /** Replaces the type's icon glyph. */
  icon?: string
  /** One button on the toast (e.g. Undo). Clicking it runs `run` and
   *  dismisses the toast. Absent means no button. */
  action?: ToastAction
}

export interface ToastAction {
  label: string
  run: () => void
}

export interface DialogState {
  kind: 'alert' | 'confirm' | 'prompt'
  title: string
  message: string
  confirmText: string
  cancelText: string
  /** Prompt only: placeholder for the text field. */
  placeholder?: string
  /** Confirm only: label for an opt-out checkbox rendered under the message.
   *  Absent means no checkbox. Its state is read from `dialogCheckbox` after
   *  the promise settles. */
  checkboxLabel?: string
  /** Confirm only: the confirmed action is destructive (remove, uninstall), so
   *  the host renders the confirm button as a danger action. Absent means the
   *  default rendering. */
  danger?: boolean
  /** Confirm only: a literal (a URL, a path) shown on its own line in
   *  monospace, with the message then rendered as prose. Absent means the
   *  default rendering. */
  detail?: string
  /** alert/confirm resolve with a boolean; prompt with the entered string (or
   *  null when cancelled). */
  resolve: (value: boolean | string | null) => void
}

// ── Module-level singleton state ──────────────────────────────────────────
const toasts = ref<Toast[]>([])
const dialog = ref<DialogState | null>(null)
/** Live value of the prompt text field, bound by NotificationHost via v-model. */
const promptValue = ref('')
/** Live value of a confirm's opt-out checkbox, bound by NotificationHost via
 *  v-model. Reset on every confirm, so a caller reads it only for the dialog it
 *  just awaited. */
const dialogCheckbox = ref(false)
let seq = 0
const _toastTimers = new Map<number, ReturnType<typeof setTimeout>>()
const MAX_TOASTS = 6

// ── Toast ─────────────────────────────────────────────────────────────────
function toast(
  message: string,
  opts: { type?: ToastType; duration?: number; variant?: ToastVariant; title?: string; icon?: string; action?: ToastAction } = {}
): void {
  const id = ++seq
  // Evict oldest toasts when the list is full to prevent unbounded growth.
  if (toasts.value.length >= MAX_TOASTS) {
    const evicted = toasts.value.splice(0, toasts.value.length - MAX_TOASTS + 1)
    for (const t of evicted) {
      const h = _toastTimers.get(t.id)
      if (h != null) { clearTimeout(h); _toastTimers.delete(t.id) }
    }
  }
  toasts.value.push({
    id,
    message,
    type: opts.type ?? 'info',
    // Only set when asked for, so every existing toast stays identical.
    ...(opts.variant ? { variant: opts.variant } : {}),
    ...(opts.title ? { title: opts.title } : {}),
    ...(opts.icon ? { icon: opts.icon } : {}),
    ...(opts.action ? { action: opts.action } : {}),
  })
  const duration = opts.duration ?? 4000
  if (duration > 0) {
    const h = setTimeout(() => { dismissToast(id) }, duration)
    _toastTimers.set(id, h)
  }
}

function dismissToast(id: number): void {
  const h = _toastTimers.get(id)
  if (h != null) { clearTimeout(h); _toastTimers.delete(id) }
  toasts.value = toasts.value.filter((t) => t.id !== id)
}

/** Cancel-resolve any dialog currently on screen so its promise never hangs
 *  when a new one supersedes it (prompt → null, alert/confirm → false). */
function supersedeDialog(): void {
  const d = dialog.value
  if (!d) return
  dialog.value = null
  d.resolve(d.kind === 'prompt' ? null : false)
}

// ── Alert (blocking, single button) ────────────────────────────────────────
function alert(
  message: string,
  opts: { title?: string; confirmText?: string } = {}
): Promise<void> {
  return new Promise<void>((resolve) => {
    supersedeDialog()
    dialog.value = {
      kind: 'alert',
      title: opts.title ?? 'Alert',
      message,
      confirmText: opts.confirmText ?? 'OK',
      cancelText: '',
      resolve: () => resolve()
    }
  })
}

// ── Confirm (blocking, yes/no → Promise<boolean>) ──────────────────────────
function confirm(
  message: string,
  opts: {
    title?: string
    confirmText?: string
    cancelText?: string
    /** Renders an opt-out checkbox; read `dialogCheckbox.value` after awaiting. */
    checkboxLabel?: string
    /** Destructive action: rendered as a danger confirm. */
    danger?: boolean
    /** A literal shown in monospace under a prose message. */
    detail?: string
  } = {}
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    supersedeDialog()
    dialogCheckbox.value = false
    dialog.value = {
      kind: 'confirm',
      title: opts.title ?? 'Confirm',
      message,
      confirmText: opts.confirmText ?? 'OK',
      cancelText: opts.cancelText ?? 'Cancel',
      checkboxLabel: opts.checkboxLabel,
      // Only set when asked for, so every existing confirm stays identical.
      ...(opts.danger ? { danger: true } : {}),
      ...(opts.detail !== undefined ? { detail: opts.detail } : {}),
      resolve: resolve as (v: boolean | string | null) => void
    }
  })
}

// ── Prompt (blocking, text input → Promise<string|null>) ────────────────────
function prompt(
  message: string,
  opts: {
    title?: string
    defaultValue?: string
    placeholder?: string
    confirmText?: string
    cancelText?: string
  } = {}
): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    supersedeDialog()
    promptValue.value = opts.defaultValue ?? ''
    dialog.value = {
      kind: 'prompt',
      title: opts.title ?? '',
      message,
      confirmText: opts.confirmText ?? 'OK',
      cancelText: opts.cancelText ?? 'Cancel',
      placeholder: opts.placeholder ?? '',
      resolve: resolve as (v: boolean | string | null) => void
    }
  })
}

/** Called by the host when a dialog button is pressed (or dismissed). For a
 *  prompt, `ok` maps to the entered text; cancel/backdrop maps to null. */
function resolveDialog(ok: boolean): void {
  const d = dialog.value
  dialog.value = null
  if (!d) return
  d.resolve(d.kind === 'prompt' ? (ok ? promptValue.value : null) : ok)
}

export function useNotify() {
  return {
    toasts: readonly(toasts),
    dialog: readonly(dialog),
    promptValue,
    dialogCheckbox,
    toast,
    dismissToast,
    alert,
    confirm,
    prompt,
    resolveDialog
  }
}
