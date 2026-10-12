<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { DEFAULT_SLOT_ID, type FollowSwitchRow, type QuotaTarget } from '../lib/accountFollowSwitch'

/** One pane row as shown: the pure row plus its account's display label. */
export interface FollowDialogRow extends FollowSwitchRow {
  accountLabel: string
}

const props = defineProps<{
  open: boolean
  /** 'switch': after a global switch, which pinned panes come along.
   *  'quota': an out-of-quota pane picks an account to resume on. */
  mode: 'switch' | 'quota'
  /** Label of the account switched to ('switch' mode) or of the pane that
   *  ran out ('quota' mode) — used in the heading. */
  subject: string
  rows: FollowDialogRow[]
  /** 'quota' mode only: the accounts the pane can move to. */
  targets?: QuotaTarget[]
}>()
const emit = defineEmits<{
  confirm: [paneIds: string[], targetId: string | null]
  cancel: []
}>()

const checked = ref<Set<string>>(new Set())
const target = ref<string | null>(null)
const dialog = ref<HTMLDivElement | null>(null)

// Reset on every new question, not only on open: the host replaces the
// question in place, with the dialog still open.
watch(
  () => [props.open, props.rows, props.targets] as const,
  async ([open]) => {
    if (!open) return
    checked.value = new Set(props.rows.filter((r) => r.checked).map((r) => r.paneId))
    target.value = props.targets?.find((t) => t.eligible && !t.exhausted)?.id ?? null
    await nextTick()
    dialog.value?.focus()
  },
  { immediate: true }
)

function toggle(id: string): void {
  const next = new Set(checked.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  checked.value = next
}

const count = computed(() => checked.value.size)
const canConfirm = computed(() =>
  props.mode === 'switch' ? count.value > 0 : target.value !== null
)

function confirm(): void {
  if (!canConfirm.value) return
  emit('confirm', props.rows.filter((r) => checked.value.has(r.paneId)).map((r) => r.paneId), target.value)
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      ref="dialog"
      class="follow-switch-modal nv-modal-overlay"
      tabindex="-1"
      data-testid="account-follow-dialog"
      @keydown.esc="emit('cancel')"
    >
      <section
        class="follow-switch-card nv-modal-shell nv-modal-shell--compact"
        role="dialog"
        aria-modal="true"
        :aria-label="mode === 'switch'
          ? $t('account-follow.switch-title', { account: subject })
          : $t('account-follow.quota-title', { pane: subject })"
      >
        <h2>{{ mode === 'switch'
          ? $t('account-follow.switch-title', { account: subject })
          : $t('account-follow.quota-title', { pane: subject }) }}</h2>

        <template v-if="mode === 'quota'">
          <p>{{ $t('account-follow.quota-pick') }}</p>
          <div class="targets" role="radiogroup">
            <label
              v-for="t in targets ?? []"
              :key="t.id"
              :class="['target', { disabled: !t.eligible }]"
              :data-testid="`account-follow-target-${t.id}`"
            >
              <input v-model="target" type="radio" :value="t.id" :disabled="!t.eligible" />
              <span v-truncate class="name">{{ t.label }}</span>
              <span v-if="!t.eligible" class="hint">{{ t.id === DEFAULT_SLOT_ID
                ? $t('account-follow.default-needs-switch')
                : $t('account-follow.needs-dir-sign-in') }}</span>
              <span v-else-if="t.exhausted" class="hint">{{ $t('account-follow.exhausted') }}</span>
              <span v-else-if="t.remaining" class="hint">{{ t.remaining }}</span>
            </label>
          </div>
          <p v-if="rows.length" class="sub">{{ $t('account-follow.quota-peers') }}</p>
        </template>
        <p v-else>{{ $t('account-follow.switch-body') }}</p>

        <ul v-if="rows.length" class="rows">
          <li v-for="r in rows" :key="r.paneId" :data-testid="`account-follow-row-${r.paneId}`">
            <label>
              <input type="checkbox" :checked="checked.has(r.paneId)" @change="toggle(r.paneId)" />
              <span v-truncate class="name">{{ r.name }}</span>
              <span class="acct">{{ r.accountLabel }}</span>
              <span :class="['state', r.state]">{{ $t(`account-follow.state-${r.state}`) }}</span>
            </label>
          </li>
        </ul>
        <p class="note">{{ $t('account-follow.note-window') }}</p>

        <div class="actions">
          <button data-testid="account-follow-cancel" @click="emit('cancel')">
            {{ mode === 'switch' ? $t('account-follow.switch-skip') : $t('account-follow.cancel') }}
          </button>
          <button
            class="primary"
            data-testid="account-follow-confirm"
            :disabled="!canConfirm"
            @click="confirm"
          >
            {{ mode === 'switch'
              ? $t('account-follow.switch-confirm', { count })
              : $t('account-follow.quota-confirm', { count: count + 1 }) }}
          </button>
        </div>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.follow-switch-modal {
  position: fixed;
  inset: 0;
  z-index: calc(var(--z-modal) + 131);
  display: grid;
  place-items: center;
  padding: 24px;
  background: var(--modal-backdrop);
  backdrop-filter: blur(var(--modal-backdrop-blur));
  -webkit-backdrop-filter: blur(var(--modal-backdrop-blur));
}
.follow-switch-card {
  width: min(var(--modal-w-compact), 92vw);
  padding: 20px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-lg);
  background: var(--bg-base);
  box-shadow: var(--shadow-modal);
}
h2 { margin: 0 0 8px; font-size: 17px; }
p { margin: 0 0 12px; color: var(--text-secondary); }
p.sub { margin-top: 12px; }
.note { font-size: 12px; }
.rows, .targets { display: grid; grid-template-columns: minmax(0, 1fr); gap: 4px; margin: 0 0 12px; padding: 0; list-style: none; }
.rows label, .target {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 6px;
  border-radius: var(--radius-sm);
  cursor: pointer;
}
.rows label:hover, .target:hover { background: var(--bg-subtle); }
.target.disabled { cursor: default; opacity: 0.6; }
.name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.acct, .hint, .state { color: var(--text-secondary); font-size: 12px; white-space: nowrap; }
.state { max-width: 14em; white-space: normal; text-align: right; }
.state.quota { color: var(--danger-fg); }
.actions { display: flex; justify-content: flex-end; gap: 8px; }
button {
  min-height: 34px;
  padding: 0 14px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  background: var(--bg-subtle);
  color: var(--text-primary);
  cursor: pointer;
}
button:hover, button:focus-visible { border-color: var(--accent-focus); }
button:disabled { cursor: default; opacity: 0.5; }
</style>
