<script setup lang="ts">
// A machine is asking to pair. This is what somebody actually sees.
//
// The same question exists on a card inside the account window, and that card
// stays — it is the record, and the way back in if this was dismissed. But it
// is five sections down a window nobody has open, and a request that expires in
// five minutes cannot wait for somebody to go looking. So it comes to them.
//
// Both ends get one. It served the responder alone, back when the initiator did
// not confirm at all — pressing "Pair with…" was its whole answer. Both confirm
// now, because the six digits are the only part of the exchange a relay cannot
// produce and somebody has to compare them at each end; and the reason the
// responder needed a popup applies unchanged to the initiator, whose account
// window may be closed or scrolled elsewhere while the one button that finishes
// the exchange waits in it.
//
// It also acknowledges the press. "Pair" used to produce nothing until the far
// machine answered, which is seconds of a button that has visibly done nothing.
//
// Every press has to change something on screen. The first version sent the
// answer and waited for the list to stop containing the request — so a person
// who pressed Allow saw a button dim and nothing else, and a backend that
// answered with an error was indistinguishable from one that answered at all.
// Pressing now moves through three visible states: in flight, settled, gone.
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import type { useBackend } from '../composables/useBackend'
import {
  usePairingState,
  requestKey,
  failureKey,
  POLL_MS,
  type PairingRow,
} from '../composables/usePairingState'
import NavideCloudMark from './NavideCloudMark.vue'

const props = defineProps<{ backend: ReturnType<typeof useBackend> }>()

const { t } = useI18n()
const state = usePairingState(props.backend)

/** Reads the shared snapshot, never its own copy: two readers a poll apart
 *  would let this ask a question the card had already answered.
 *
 *  Only exchanges with digits to compare. Before that there is no question to
 *  ask — what there is instead is the "sent" card below. */
const prompts = computed<PairingRow[]>(() =>
  state.prompts.value.filter((row) => Boolean(row.code)),
)

/** One at a time in flight, the same gate every other trust act uses. Keyed by
 *  the request so the label can say which card is the one waiting. */
const pendingKey = ref('')
const busy = computed(() => pendingKey.value !== '')

/** What a request became, kept after the request itself is gone. The answer
 *  removes it from the snapshot within the same round trip, so without this the
 *  card would vanish at the exact moment it had something to report. */
interface Settled {
  key: string
  deviceName: string
  accepted: boolean
}
const settled = ref<Settled[]>([])
/** Verbatim from the backend, per request. Not classified here: the message is
 *  the only part that says which of a dozen refusals this was. */
const errors = ref<Record<string, string>>({})

/** How long the outcome stays before the card leaves by itself. Long enough to
 *  read a sentence, short enough not to become another thing to dismiss. */
const SETTLED_MS = 2600

/**
 * How long "sent, waiting for them" stays before it goes by itself.
 *
 * It has to outlast the machinery. The request goes to the server, the far
 * machine sees it on its own poll, and this end learns of the answer on the
 * next one — three polls before anything can come back, in the ordinary case
 * where somebody is standing at the other screen. A notice that expires inside
 * that window disappears while its own answer is still on the way, which reads
 * as the request having failed.
 *
 * It must not outlast the person. Past that point what is left is somebody who
 * has not looked at their machine yet, and they may answer in ten minutes; a
 * notice that waits for them is still on screen when they do. Nothing is lost
 * by letting it go — the answer arrives as a card of its own, which is the
 * whole reason this one is allowed to leave and the card with the digits is
 * not.
 */
const ASKED_MS = 3 * POLL_MS + 1000

const timers: ReturnType<typeof setTimeout>[] = []

/** Settled outcomes first, then the questions still open. A request being
 *  answered is drawn from `settled`, not from the snapshot, which is why the
 *  card survives its own disappearance from the list. */
const cards = computed(() => [
  // A round that ended on a refusal, here or there. First, because it is the
  // answer to the card that was waiting — which is gone — and it stays until
  // somebody closes it: it says what to do next, and that has to be read.
  ...state.failures.value.map((f) => ({
    kind: 'failed' as const,
    key: `failed:${f.deviceId}:${f.at}`,
    failure: f,
  })),
  ...settled.value.map((s) => ({ kind: 'settled' as const, key: s.key, settled: s })),
  // The press, acknowledged before anything has been sent. Drops out the moment
  // the exchange is real — the snapshot owns it from there.
  ...state.asked.value.map((a) => ({ kind: 'asked' as const, key: `asked:${a.deviceId}`, asked: a })),
  ...prompts.value
    .filter((row) => !settled.value.some((s) => s.key === requestKey(row)))
    .map((row) => ({ kind: 'ask' as const, key: requestKey(row), row })),
])

/** Timers for the "sent" notices, one per device, so closing one by hand does
 *  not leave a timeout to fire against a card that is already gone. */
const askedTimers = new Map<string, ReturnType<typeof setTimeout>>()

/**
 * Put the "sent" notice away. **The request keeps running.**
 *
 * It forgets only this window's record of the press — it does not touch
 * `dismiss`, which is keyed by the request and is what would suppress the
 * card that comes back. Closing a notice must not be a silent way to cancel a
 * pairing, and when the far machine answers, the question with the digits
 * appears exactly as it would have.
 */
function dismissAsked(deviceId: string): void {
  const timer = askedTimers.get(deviceId)
  if (timer) {
    clearTimeout(timer)
    askedTimers.delete(deviceId)
  }
  state.forgetAsked(deviceId)
}

watch(
  () => state.asked.value.map((a) => `${a.deviceId}:${a.error ? 'err' : ''}`).join(','),
  () => {
    const live = new Map(state.asked.value.map((a) => [a.deviceId, a]))
    for (const [deviceId, timer] of [...askedTimers]) {
      // Gone, or turned into an error. An error is the only record that the
      // request never went out, and nothing is coming to replace it — so it
      // stays until somebody closes it.
      if (!live.has(deviceId) || live.get(deviceId)?.error) {
        clearTimeout(timer)
        askedTimers.delete(deviceId)
      }
    }
    for (const [deviceId, entry] of live) {
      if (entry.error || askedTimers.has(deviceId)) continue
      askedTimers.set(
        deviceId,
        setTimeout(() => {
          askedTimers.delete(deviceId)
          state.forgetAsked(deviceId)
        }, ASKED_MS),
      )
    }
  },
  { immediate: true },
)

async function answer(row: PairingRow, accept: boolean): Promise<void> {
  if (busy.value) return
  const key = requestKey(row)
  pendingKey.value = key
  errors.value = { ...errors.value, [key]: '' }
  try {
    const confirm = await window.agentTeam?.trustConfirm('p2p.pair.confirm', row.deviceId)
    const resp = await props.backend.send('p2p.pair.confirm', {
      deviceId: row.deviceId,
      accept,
      confirm,
    })
    // An error reply is not an exception, so nothing here would have caught it:
    // the old version treated "CONFIRMATION_REQUIRED" exactly like success and
    // then re-rendered the same unanswered question.
    if (!resp.ok) {
      errors.value = {
        ...errors.value,
        [key]: resp.error?.message || t('settings.p2p.pair.err-generic'),
      }
      return
    }
    settled.value = [
      ...settled.value,
      { key, deviceName: row.deviceName || row.deviceId, accepted: accept },
    ]
    timers.push(
      setTimeout(() => {
        settled.value = settled.value.filter((s) => s.key !== key)
        // Answered, so it must not come back if the snapshot still lists it for
        // a moment. `dismiss` is pruned once the request is really gone.
        state.dismiss(row)
      }, SETTLED_MS),
    )
    await state.refresh()
  } catch (err) {
    errors.value = {
      ...errors.value,
      [key]: err instanceof Error ? err.message : String(err),
    }
  } finally {
    pendingKey.value = ''
  }
}

/** Puts the prompt away without answering. The card in the account window keeps
 *  the request until it expires, so this hides a question rather than deciding
 *  it — which is why it is not sent anywhere. It puts away *this* request: the
 *  same device asking again is a new question and asks again. */
function later(row: PairingRow): void {
  state.dismiss(row)
}

onMounted(() => state.subscribe())
onUnmounted(() => {
  for (const timer of timers.splice(0)) clearTimeout(timer)
  for (const timer of askedTimers.values()) clearTimeout(timer)
  askedTimers.clear()
  state.release()
})

/** A fingerprint in groups of four: sixteen unbroken hex characters is the
 *  comparison people give up on. */
function grouped(value: string | undefined): string {
  const raw = (value ?? '').replace(/\s+/g, '')
  return raw ? (raw.match(/.{1,4}/g)?.join(' ') ?? raw) : ''
}
</script>

<template>
  <!-- Over everything, top-right, and out of the way of the traffic lights.
       It is a notification, not a modal: it does not take the keyboard and it
       does not stop somebody finishing what they were typing. -->
  <div v-if="cards.length" class="pair-prompts" role="status" aria-live="polite">
    <!-- One eyebrow for the stack, not one per card: it says where these
         questions come from, and that is the same answer however many are
         open. -->
    <p class="pp-brand">
      <NavideCloudMark variant="solid" class="pp-brand-mark" />
      {{ t('settings.nav.crossDevice') }}
    </p>
    <div v-for="card in cards" :key="card.key" class="pair-prompt">
      <template v-if="card.kind === 'asked'">
        <!-- This one closes, and goes by itself. It reports that a request went
             out; it asks for nothing, so taking it away decides nothing. The
             card below, which asks whether six digits match, has neither —
             a question that removes itself has answered itself. -->
        <div class="pp-head">
          <p class="pp-title">
            {{ t('settings.p2p.pair.asking', { device: card.asked.deviceName || card.asked.deviceId }) }}
          </p>
          <button
            class="pp-close"
            :aria-label="t('settings.p2p.pair.dismiss')"
            :title="t('settings.p2p.pair.dismiss-title')"
            @click="dismissAsked(card.asked.deviceId)"
          >×</button>
        </div>
        <p v-if="card.asked.error" class="pp-err">{{ card.asked.error }}</p>
        <p v-else class="pp-body">{{ t('settings.p2p.pair.waiting-response') }}</p>
      </template>
      <template v-else-if="card.kind === 'failed'">
        <div class="pp-head">
          <p class="pp-title">
            {{ t('settings.p2p.pair.failed-title', { device: card.failure.deviceName || card.failure.deviceId }) }}
          </p>
          <button
            class="pp-close"
            :aria-label="t('settings.p2p.pair.dismiss')"
            @click="state.dismissFailure(card.failure)"
          >×</button>
        </div>
        <p class="pp-err">
          {{ t('settings.p2p.pair.' + failureKey(card.failure), {
            device: card.failure.deviceName || card.failure.deviceId,
            reason: card.failure.reason,
          }) }}
        </p>
      </template>
      <template v-else-if="card.kind === 'settled'">
        <p class="pp-title">
          {{
            card.settled.accepted
              ? t('settings.p2p.pair.paired', { device: card.settled.deviceName })
              : t('settings.p2p.pair.done-refused')
          }}
        </p>
      </template>
      <template v-else>
        <!-- Whose question it is. "X wants to pair with you" is true only at
             the end that was asked; the end that did the asking is comparing
             digits with a machine it chose. -->
        <p class="pp-title">
          {{ t(
            card.row.role === 'initiator'
              ? 'settings.p2p.pair.with-device'
              : 'settings.p2p.pair.asked-by',
            { device: card.row.deviceName || card.row.deviceId },
          ) }}
        </p>
        <p class="pp-label">{{ t('settings.p2p.pair.code-label') }}</p>
        <p class="pp-code">{{ card.row.code }}</p>
        <p class="pp-body">
          {{ t('settings.p2p.pair.compare', { device: card.row.deviceName || card.row.deviceId }) }}
        </p>
        <p class="pp-label">{{ t('settings.p2p.pair.fingerprint-label') }}</p>
        <p class="pp-fp"><code>{{ grouped(card.row.fingerprint) }}</code></p>
        <!-- Whatever the backend said, said here. A refusal a person cannot see
             is the same to them as a button that does nothing. -->
        <p v-if="errors[card.key]" class="pp-err">{{ errors[card.key] }}</p>
        <div class="pp-acts">
          <button
            class="pp-btn pp-primary"
            :disabled="busy"
            @click="answer(card.row, true)"
          >
            <!-- "Allow pairing" is what the end that was *asked* is doing. The
                 end that did the asking is not granting anything — it is saying
                 the two screens show the same digits, which is the only claim
                 either button ever makes. -->
            {{
              pendingKey === card.key
                ? t('settings.p2p.pair.sending')
                : t(card.row.role === 'initiator'
                    ? 'settings.p2p.pair.match'
                    : 'settings.p2p.pair.allow')
            }}
          </button>
          <button
            class="pp-btn pp-danger"
            :disabled="busy"
            @click="answer(card.row, false)"
          >
            {{ t('settings.p2p.pair.mismatch') }}
          </button>
          <button
            class="pp-btn pp-quiet"
            :disabled="busy"
            :title="t('settings.p2p.pair.later-title')"
            @click="later(card.row)"
          >
            {{ t('settings.p2p.pair.later') }}
          </button>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
/* The notification level, above modals and everything else. This is a security
   question that expires in five minutes and has to be answered where the person
   is standing; covered by the account or settings window it has not appeared at
   all. `--z-toast` is the existing band for exactly this ("notifications,
   always on top" — semantic.css), so no new level is invented. */
.pair-prompts {
  position: fixed; top: 44px; right: 16px; z-index: var(--z-toast);
  display: flex; flex-direction: column; gap: 8px; max-width: 320px;
}
.pair-prompt {
  background: var(--bg-elevated, var(--bg-base)); color: var(--text-primary);
  border: 1px solid var(--attention-fg); border-radius: var(--radius-card, 10px);
  box-shadow: var(--shadow-popover); padding: 12px 14px;
  animation: pp-in var(--motion-fast, 120ms) var(--ease-out, ease-out);
}
/* Somebody who has asked for less motion still needs to see this; it simply
   arrives instead of sliding. */
@media (prefers-reduced-motion: reduce) {
  .pair-prompt { animation: none; }
}
@keyframes pp-in {
  from { opacity: 0; transform: translateY(-4px); }
  to { opacity: 1; transform: none; }
}
/* Names the sender of these cards. Muted and small: it is context, and the
   question underneath is what has to be read first. */
.pp-brand {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  padding: 0 2px;
  font-size: var(--font-3xs);
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-secondary);
}
.pp-brand-mark { width: 15px; height: 11px; color: var(--accent-fg); }
.pp-title { margin: 0; font-size: 13px; font-weight: 600; color: var(--text-bright); }
.pp-head { display: flex; align-items: flex-start; gap: 8px; }
.pp-head .pp-title { flex: 1; min-width: 0; }
.pp-close {
  flex-shrink: 0; margin: -4px -4px 0 0; padding: 0 4px; border: 0; background: none;
  font: inherit; font-size: 15px; line-height: 1.2; color: var(--text-secondary);
  cursor: pointer;
}
.pp-close:hover { color: var(--text-primary); background: var(--bg-muted); border-radius: var(--radius-control, 6px); }
.pp-close:focus-visible { outline: 2px solid var(--accent-fg); outline-offset: 1px; }
.pp-label {
  margin: 8px 0 0; font-size: var(--font-3xs); text-transform: uppercase;
  letter-spacing: 0.06em; color: var(--text-secondary);
}
.pp-code {
  margin: 2px 0 0; font-family: var(--font-mono, monospace);
  font-size: 24px; letter-spacing: 0.18em; user-select: text;
  color: var(--text-bright); font-variant-numeric: tabular-nums;
}
.pp-body { margin: 6px 0 0; font-size: 12px; color: var(--text-secondary); line-height: 1.5; }
.pp-fp { margin: 2px 0 0; font-size: 12px; }
.pp-fp code { user-select: text; letter-spacing: 0.06em; }
.pp-err { margin: 8px 0 0; font-size: 12px; color: var(--danger-fg); line-height: 1.5; }
.pp-acts { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
.pp-btn {
  font: inherit; font-size: 12px; padding: 3px 10px; cursor: pointer;
  border-radius: var(--radius-control, 6px); border: 1px solid var(--border-default);
  background: none; color: var(--text-secondary);
}
.pp-btn:hover:not(:disabled) { background: var(--bg-muted); border-color: var(--border-strong, var(--border-default)); color: var(--text-primary); }
.pp-btn:focus-visible { outline: 2px solid var(--accent-fg); outline-offset: 2px; }
.pp-btn:disabled { opacity: 0.5; cursor: default; }
.pp-primary {
  background: var(--accent-emphasis); border-color: var(--accent-emphasis);
  color: var(--text-on-emphasis);
}
.pp-primary:hover:not(:disabled) { background: var(--accent-emphasis); border-color: var(--accent-emphasis); color: var(--text-on-emphasis); }
.pp-danger { color: var(--danger-fg); border-color: var(--danger-fg); }
.pp-danger:hover:not(:disabled) { background: var(--danger-subtle, color-mix(in srgb, var(--danger-fg) 10%, transparent)); border-color: var(--danger-fg); color: var(--danger-fg); }
.pp-quiet { border-color: transparent; }
.pp-quiet:hover { color: var(--text-primary); }
</style>
