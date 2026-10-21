<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import { useNotify } from '@navide/plugin-ui/foundation'
import { useDialogFocus } from '../composables/useDialogFocus'

const { toasts, dialog, promptValue, dialogCheckbox, dismissToast, resolveDialog } = useNotify()

const toastIcon = { success: '✓', error: '✕', info: 'ℹ' } as const

const modalEl = ref<HTMLDivElement | null>(null)
const promptInput = ref<HTMLInputElement | null>(null)
// Tab stays inside the open dialog and focus returns to its opener after.
// Initial focus is the same as the watcher below gives it.
useDialogFocus(modalEl, () => (dialog.value?.kind === 'prompt' ? promptInput.value : modalEl.value))
watch(dialog, async (d) => {
  if (d) {
    await nextTick()
    // Focus the text field for a prompt so the user can type immediately;
    // otherwise focus the modal so Enter/Esc are handled.
    if (d.kind === 'prompt') promptInput.value?.select()
    else modalEl.value?.focus()
  }
})
</script>

<template>
  <Teleport to="body">
    <!-- Toast stack (non-blocking, auto-dismiss) -->
    <div class="toast-stack">
      <transition-group name="toast">
        <div
          v-for="t in toasts"
          :key="t.id"
          class="toast"
          :class="[t.type, t.variant, { titled: !!t.title }]"
          @click="dismissToast(t.id)"
        >
          <template v-if="t.title">
            <span class="toast-band">{{ t.icon ?? toastIcon[t.type] }} {{ t.title }}</span>
            <span class="toast-row">
              <span class="toast-icon">{{ t.icon ?? toastIcon[t.type] }}</span>
              <span class="toast-msg">{{ t.message }}</span>
            </span>
          </template>
          <template v-else>
            <span class="toast-icon">
              <svg v-if="t.variant === 'security'" class="toast-shield" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M8 1.5 13.5 3.5v4c0 3.3-2.3 5.9-5.5 7-3.2-1.1-5.5-3.7-5.5-7v-4Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M5.5 8h5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
              <template v-else>{{ t.icon ?? toastIcon[t.type] }}</template>
            </span>
            <span class="toast-msg">{{ t.message }}</span>
          </template>
          <button
            v-if="t.action"
            type="button"
            class="toast-action"
            @click.stop="t.action.run(); dismissToast(t.id)"
          >{{ t.action.label }}</button>
        </div>
      </transition-group>
    </div>

    <!-- Alert / Confirm dialog (blocking) -->
    <div v-if="dialog" ref="modalEl" class="modal" tabindex="-1" @click.self="resolveDialog(false)" @keydown.esc="resolveDialog(false)" @keydown.enter="resolveDialog(true)">
      <div
        class="card"
        :class="[dialog.kind, { danger: dialog.danger }]"
        :role="dialog.kind === 'prompt' ? 'dialog' : 'alertdialog'"
        aria-modal="true"
        aria-labelledby="notify-dialog-title"
        aria-describedby="notify-dialog-body"
      >
        <header>
          <span class="dot"></span>
          <strong id="notify-dialog-title">{{ dialog.title }}</strong>
        </header>
        <div id="notify-dialog-body" class="body">
          <pre :class="{ prose: dialog.detail !== undefined }">{{ dialog.message }}</pre>
          <pre v-if="dialog.detail !== undefined" class="detail">{{ dialog.detail }}</pre>
          <input
            v-if="dialog.kind === 'prompt'"
            ref="promptInput"
            v-model="promptValue"
            class="prompt-input"
            type="text"
            :placeholder="dialog.placeholder"
            @keydown.enter.stop.prevent="resolveDialog(true)"
            @keydown.esc.stop.prevent="resolveDialog(false)"
          />
          <label v-if="dialog.checkboxLabel" class="dialog-check">
            <input v-model="dialogCheckbox" type="checkbox" />
            <span>{{ dialog.checkboxLabel }}</span>
          </label>
        </div>
        <footer>
          <button
            v-if="dialog.kind === 'confirm' || dialog.kind === 'prompt'"
            class="ghost"
            @click="resolveDialog(false)"
          >
            {{ dialog.cancelText }}
          </button>
          <button class="primary" :class="{ danger: dialog.danger }" @click="resolveDialog(true)">
            {{ dialog.confirmText }}
          </button>
        </footer>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
/* ── Toast stack ──────────────────────────────────────────────────────── */
.toast-stack {
  position: fixed;
  top: 16px;
  right: 16px;
  /* The toast band, which is above every overlay: a toast or confirm hidden
     behind one reads as a silent failure, and a hidden confirm still answers
     Enter. Named by the token rather than by a number chosen to beat the
     modals of the day — that is how the pairing prompt ended up underneath a
     window whose z-index nobody had thought about since. */
  z-index: var(--z-toast);
  display: flex;
  flex-direction: column;
  gap: 8px;
  pointer-events: none;
}
.toast {
  pointer-events: auto;
  display: flex;
  align-items: flex-start;
  gap: 8px;
  min-width: 240px;
  max-width: 420px;
  padding: 10px 14px;
  background: var(--bg-elevated);
  border: 1px solid var(--border-default);
  border-left: 4px solid var(--text-secondary);
  border-radius: var(--radius-md);
  color: var(--text-bright);
  font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', sans-serif;
  font-size: var(--font-sm);
  line-height: 1.45;
  box-shadow: var(--shadow-popover);
  cursor: pointer;
  transition: border-color 0.15s ease, background 0.15s ease;
}
.toast:hover {
  background: var(--bg-elevated);
  border-top-color: var(--border-strong);
  border-right-color: var(--border-strong);
  border-bottom-color: var(--border-strong);
}
.toast.success {
  border-left-color: var(--success-fg);
}
.toast.error {
  border-left-color: var(--danger-fg);
}
.toast.info {
  border-left-color: var(--accent-fg);
}
.toast-icon {
  flex-shrink: 0;
  font-weight: 700;
}
.toast.success .toast-icon {
  color: var(--success-fg);
}
.toast.error .toast-icon {
  color: var(--danger-fg);
}
.toast.info .toast-icon {
  color: var(--accent-fg);
}
.toast-action {
  flex: none;
  margin-left: 8px;
  padding: 2px 8px;
  border: 1px solid currentColor;
  border-radius: 4px;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
}

.toast-msg {
  flex: 1;
  word-break: break-word;
  white-space: pre-wrap;
}
/* Opt-in variants (useNotify `variant`). Each red carries its own shape so
   they stay apart without the color: solid fill = another machine, solid
   header band = a chat channel, full frame = Guard, left bar = an ordinary
   error. */
.toast.titled {
  flex-direction: column;
  gap: 2px;
}
.toast-band {
  font-size: 11.5px;
  font-weight: 600;
  letter-spacing: 0.02em;
}
.toast-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}
.toast.external,
.toast.external:hover {
  background: var(--toast-external-bg);
  border: 1px solid var(--toast-external-bg);
  color: var(--toast-external-fg);
}
.toast.external .toast-icon,
.toast.external .toast-band {
  color: var(--toast-external-fg);
}
.toast.external .toast-band {
  opacity: 0.92;
}
.toast.channel,
.toast.channel:hover {
  padding-top: 0;
  border: 1px solid var(--toast-channel-accent);
  overflow: hidden;
}
.toast.channel .toast-band {
  margin: 0 -14px;
  padding: 5px 14px;
  background: var(--toast-channel-accent);
  color: var(--toast-channel-fg);
  font-weight: 700;
}
.toast.channel .toast-row {
  padding-top: 6px;
}
.toast.channel .toast-icon {
  color: var(--toast-channel-accent);
}
.toast.security,
.toast.security:hover {
  background: var(--toast-security-bg);
  border: 2px solid var(--toast-security-border);
}
.toast.security .toast-icon {
  color: var(--toast-security-border);
}
.toast-shield {
  display: block;
  margin-top: 2px;
}
.toast.workspace,
.toast.workspace:hover {
  background: var(--toast-workspace-bg);
  border-left-color: var(--toast-workspace-accent);
}
.toast.workspace .toast-icon,
.toast.workspace .toast-band {
  color: var(--toast-workspace-accent);
}
.toast:focus-visible {
  outline: 2px solid var(--accent-focus, var(--accent-fg));
  outline-offset: 2px;
}
.toast-enter-active,
.toast-leave-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}
.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateX(16px);
}

/* ── Dialog (alert / confirm) ─────────────────────────────────────────── */
/* Same look as the nv-dialog card the other dialogs use (icon tile, blurred
   scrim, accent hairline); the markup and classes are unchanged. */
.modal {
  position: fixed;
  inset: 0;
  background: var(--modal-backdrop);
  backdrop-filter: blur(var(--modal-backdrop-blur));
  -webkit-backdrop-filter: blur(var(--modal-backdrop-blur));
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: calc(var(--z-toast) + 1);
  animation: nv-modal-scrim-in var(--motion-fast) var(--ease-out);
}
.modal:focus {
  outline: none;
}
.card {
  background: var(--bg-elevated);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-lg);
  width: min(var(--modal-w-compact), 92vw);
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  color: var(--text-bright);
  font-family: var(--font-ui);
  font-size: var(--font-sm);
  box-shadow: var(--shadow-modal);
  overflow: hidden;
  animation: nv-dialog-in var(--motion-base) var(--ease-out);
}
.card::before {
  content: '';
  flex: none;
  height: 3px;
  background: var(--accent-fg);
}
header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 18px 20px 6px;
}
/* The tone dot becomes the icon tile the other dialogs use. */
.dot {
  flex: none;
  display: inline-grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: var(--accent-subtle);
  color: var(--accent-fg);
  font-size: 15px;
  font-weight: 800;
  line-height: 1;
}
.dot::after {
  content: 'i';
}
.card.confirm .dot {
  background: var(--attention-subtle);
  color: var(--attention-fg);
}
.card.confirm .dot::after {
  content: '?';
}
header strong {
  color: var(--text-bright);
  font-size: var(--font-md);
}
.body {
  flex: 1;
  overflow-y: auto;
  padding: 4px 20px 18px 64px;
}
.body pre {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: Menlo, Monaco, monospace;
  font-size: var(--font-xs);
  line-height: var(--lh-base);
  color: var(--text-bright);
}
.prompt-input {
  margin-top: 12px;
  width: 100%;
  padding: 8px 10px;
  background: var(--bg-subtle);
  border: 1px solid var(--border-default);
  border-radius: 5px;
  color: var(--text-bright);
  font-family: inherit;
  font-size: var(--font-sm);
}
.prompt-input:focus {
  outline: none;
  border-color: var(--accent-fg);
}
.prompt-input:focus-visible {
  outline: 2px solid var(--accent-focus, var(--accent-fg));
  outline-offset: 1px;
}
.dialog-check {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 14px;
  color: var(--text-secondary);
  font-size: var(--font-xs);
  cursor: pointer;
}
.dialog-check input {
  cursor: pointer;
}
footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 20px;
  border-top: 1px solid var(--border-muted);
  background: var(--bg-subtle);
}
button {
  border: 1px solid var(--border-default);
  background: var(--bg-muted);
  color: var(--text-bright);
  font-size: var(--font-xs);
  padding: 7px 14px;
  border-radius: var(--radius-control);
  cursor: pointer;
  font-family: inherit;
}
button:focus-visible {
  outline: 2px solid var(--accent-focus, var(--accent-fg));
  outline-offset: 2px;
}
button.primary {
  background: var(--success-emphasis);
  border-color: var(--success-strong);
  color: var(--text-on-emphasis);
  font-weight: 600;
}
button.primary:hover {
  background: var(--success-strong);
}
/* Destructive confirm (opt-in via `danger`): red action, and prose rather
   than the monospace the default body keeps for paths and command output. */
.card.danger .dot {
  background: var(--danger-subtle);
  color: var(--danger-bright);
}
.card.danger .dot::after {
  content: '!';
}
.card.danger .body pre {
  font-family: inherit;
  font-size: var(--font-sm);
}
/* Opt-in `detail`: the message is prose and only the literal stays monospace. */
.body pre.prose {
  font-family: inherit;
  font-size: var(--font-sm);
}
.body pre.detail {
  margin-top: 8px;
  padding: 6px 8px;
  border-radius: var(--radius-sm);
  background: var(--bg-inset);
}
button.primary.danger {
  background: var(--danger-emphasis);
  border-color: var(--danger-emphasis);
}
button.primary.danger:hover {
  background: var(--danger-fg);
}
button.ghost {
  background: transparent;
}
button.ghost:hover {
  background: var(--bg-muted);
}
@media (prefers-reduced-motion: reduce) {
  .toast,
  .toast-enter-active,
  .toast-leave-active {
    transition: none;
  }
}
</style>
