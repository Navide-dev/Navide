<script setup lang="ts">
// The "Mobile App" section of the account window: show a QR code, compare six
// digits with the phone that scanned it, and keep the list of trusted phones.
//
// Every decision here (trust, decline, remove) asks the main process for a
// confirmation first, the same as the device pairing card: the backend refuses
// those three without one.
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { vTruncate } from '@navide/plugin-ui/foundation'

import type { useBackend } from '../composables/useBackend'
import { relativeTime } from '../lib/relativeTime'
import { qrcodegen } from '../lib/vendor/qrcodegen'

const props = defineProps<{ backend: ReturnType<typeof useBackend> }>()
const { t } = useI18n()

interface PhoneRequest {
  requestId: string
  deviceName: string
  code: string
  expiresAt: number
}
interface TrustedPhone {
  phoneId: string
  deviceName: string
  pairedAt?: number
  lastSeenAt?: number | string | null
}
interface MobileState {
  configured: boolean
  reachable: boolean
  linkError: string
  offer: { expiresAt: number } | null
  requests: PhoneRequest[]
  phones: TrustedPhone[]
}

const state = ref<MobileState | null>(null)
const loadError = ref('')
/** The QR text from the last "Add phone". Only the offer reply carries it. */
const qrText = ref('')
const qrExpiresAt = ref(0)
const now = ref(Date.now())
const busy = ref('')
const actionError = ref('')

const requests = computed(() => state.value?.requests ?? [])
const phones = computed(() => state.value?.phones ?? [])
/** The QR stays up only while the backend still holds the offer: a phone that
 *  redeemed it consumes it, and the digits card takes its place. */
const offerLive = computed(
  () => Boolean(qrText.value) && Boolean(state.value?.offer) && qrExpiresAt.value * 1000 > now.value,
)
const offerExpired = computed(
  () => Boolean(qrText.value) && qrExpiresAt.value * 1000 <= now.value && !requests.value.length,
)
const countdown = computed(() => {
  const left = Math.max(0, Math.ceil(qrExpiresAt.value - now.value / 1000))
  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`
})

const qrSvg = computed(() => {
  if (!qrText.value) return null
  const qr = qrcodegen.QrCode.encodeText(qrText.value, qrcodegen.QrCode.Ecc.MEDIUM)
  const border = 4
  let path = ''
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (qr.getModule(x, y)) path += `M${x + border},${y + border}h1v1h-1z`
    }
  }
  return { size: qr.size + border * 2, path }
})

const unavailableMessage = computed(() => {
  if (!state.value) return ''
  if (!state.value.configured) return t('settings.p2p.mobile.not-configured')
  if (!state.value.reachable) {
    return t('settings.p2p.mobile.unreachable', { reason: state.value.linkError })
  }
  return ''
})

async function refresh(): Promise<void> {
  try {
    const resp = await props.backend.send<MobileState>('p2p.mobile.state', {})
    if (!resp.ok) {
      loadError.value = resp.error?.message || t('settings.p2p.mobile.err-generic')
      return
    }
    loadError.value = ''
    state.value = resp.payload ?? null
  } catch (err) {
    loadError.value = err instanceof Error ? err.message : String(err)
  }
}

async function addPhone(): Promise<void> {
  if (busy.value) return
  busy.value = 'offer'
  actionError.value = ''
  try {
    const confirm = await window.agentTeam?.trustConfirm('p2p.mobile.offer', '')
    const resp = await props.backend.send<{ qr: string; expiresAt: number }>('p2p.mobile.offer', { confirm })
    if (!resp.ok || !resp.payload?.qr) {
      actionError.value = resp.error?.message || t('settings.p2p.mobile.err-generic')
      return
    }
    qrText.value = resp.payload.qr
    qrExpiresAt.value = resp.payload.expiresAt
    await refresh()
  } catch (err) {
    actionError.value = err instanceof Error ? err.message : String(err)
  } finally {
    busy.value = ''
  }
}

/** Trust, decline or remove: confirmation first, then the request. */
async function decide(
  action: 'p2p.mobile.trust' | 'p2p.mobile.reject' | 'p2p.mobile.remove',
  id: string,
): Promise<void> {
  if (busy.value) return
  busy.value = `${action}:${id}`
  actionError.value = ''
  try {
    const confirm = await window.agentTeam?.trustConfirm(action, id)
    const payload = action === 'p2p.mobile.remove' ? { phoneId: id, confirm } : { requestId: id, confirm }
    const resp = await props.backend.send(action, payload)
    if (!resp.ok) {
      actionError.value = resp.error?.message || t('settings.p2p.mobile.err-generic')
    } else if (action !== 'p2p.mobile.remove') {
      qrText.value = ''
    }
    await refresh()
  } catch (err) {
    actionError.value = err instanceof Error ? err.message : String(err)
  } finally {
    busy.value = ''
  }
}

function lastSeen(phone: TrustedPhone): string {
  const raw = phone.lastSeenAt
  let at = Number.NaN
  if (typeof raw === 'number') at = raw < 1e12 ? raw * 1000 : raw
  else if (typeof raw === 'string' && raw) at = Date.parse(raw)
  if (!Number.isFinite(at)) return t('settings.p2p.mobile.never-seen')
  const { unit, count } = relativeTime(at, now.value)
  return t('settings.p2p.mobile.last-seen', { time: t(`time.ago-${unit}`, { count }) })
}

let off: (() => void) | null = null
let tick: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  void refresh()
  off = props.backend.on('p2p.mobile.changed', () => void refresh())
  tick = setInterval(() => {
    now.value = Date.now()
  }, 1000)
})
onUnmounted(() => {
  off?.()
  if (tick) clearInterval(tick)
})
</script>

<template>
  <section class="net mobile-app" data-mobile-app>
    <h2 class="net-title">{{ t('settings.p2p.mobile.title') }}</h2>
    <div class="card net-card">
      <p class="req-what">{{ t('settings.p2p.mobile.intro') }}</p>
      <p class="pair-label">{{ t('settings.p2p.mobile.sees-title') }}</p>
      <p class="req-what">{{ t('settings.p2p.mobile.sees') }}</p>

      <p v-if="unavailableMessage" class="hint" data-mobile-unavailable>{{ unavailableMessage }}</p>
      <p v-else-if="loadError" class="hint" data-mobile-unavailable>{{ loadError }}</p>

      <!-- A phone that scanned the code: the digits to compare, and the answer. -->
      <div v-for="req in requests" :key="req.requestId" class="req pair-card" data-mobile-request>
        <div class="req-head">
          <span class="dev-name" v-truncate>
            {{ t('settings.p2p.mobile.request-title', { device: req.deviceName || t('settings.p2p.mobile.unnamed-phone') }) }}
          </span>
        </div>
        <p class="pair-label">{{ t('settings.p2p.mobile.code-label') }}</p>
        <p class="pair-code">{{ req.code }}</p>
        <p class="req-what">{{ t('settings.p2p.mobile.compare') }}</p>
        <div class="req-acts">
          <button class="btn small" :disabled="!!busy" @click="decide('p2p.mobile.trust', req.requestId)">
            {{ t('settings.p2p.mobile.trust') }}
          </button>
          <button
            class="btn ghost small danger"
            :disabled="!!busy"
            @click="decide('p2p.mobile.reject', req.requestId)"
          >
            {{ t('settings.p2p.mobile.decline') }}
          </button>
        </div>
      </div>

      <div v-if="offerLive && qrSvg" class="qr-block" data-mobile-qr>
        <svg
          class="qr"
          role="img"
          :aria-label="t('settings.p2p.mobile.qr-label')"
          :viewBox="`0 0 ${qrSvg.size} ${qrSvg.size}`"
          shape-rendering="crispEdges"
        >
          <rect :width="qrSvg.size" :height="qrSvg.size" fill="#fff" />
          <path :d="qrSvg.path" fill="#000" />
        </svg>
        <p class="req-what">{{ t('settings.p2p.mobile.scan') }}</p>
        <p class="hint">{{ t('settings.p2p.mobile.expires-in', { time: countdown }) }}</p>
      </div>
      <p v-else-if="offerExpired" class="hint">{{ t('settings.p2p.mobile.expired') }}</p>

      <div v-if="!offerLive && !requests.length" class="req-acts add-row">
        <button
          class="btn small"
          :disabled="!!busy || state?.configured === false"
          data-mobile-add
          @click="addPhone"
        >
          {{ t(offerExpired ? 'settings.p2p.mobile.new-code' : 'settings.p2p.mobile.add') }}
        </button>
      </div>

      <p v-if="actionError" class="req-what danger-text" data-mobile-error>{{ actionError }}</p>

      <p class="pair-label">{{ t('settings.p2p.mobile.trusted-title') }}</p>
      <p v-if="!phones.length" class="req-what">{{ t('settings.p2p.mobile.none') }}</p>
      <div v-for="phone in phones" :key="phone.phoneId" class="req" data-mobile-phone>
        <div class="req-head">
          <span class="dev-name" v-truncate>{{ phone.deviceName || t('settings.p2p.mobile.unnamed-phone') }}</span>
          <span class="dev-count">{{ lastSeen(phone) }}</span>
        </div>
        <div class="req-acts">
          <button
            class="btn ghost small danger"
            :disabled="!!busy"
            @click="decide('p2p.mobile.remove', phone.phoneId)"
          >
            {{ t('settings.p2p.mobile.remove') }}
          </button>
        </div>
      </div>
      <p v-if="phones.length" class="hint">{{ t('settings.p2p.mobile.remove-hint') }}</p>
    </div>
  </section>
</template>

<style scoped>
/* The account window's own tokens and shapes; its styles are scoped, so the
   few this section uses are repeated here rather than reached into. */
.net { margin-top: 18px; }
.net-title { margin: 0; font-size: 11.5px; font-weight: 500; color: var(--text-secondary); }
.card {
  border: 1px solid var(--border-default); border-radius: var(--radius-md); margin-top: 8px;
  background: var(--bg-subtle);
}
.net-card { min-height: 62px; padding: 10px 14px; }
.hint { margin: 8px 0 0; font-size: 11.5px; color: var(--text-secondary); }
.req { padding: 8px 0; border-bottom: 1px solid var(--border-muted); }
.req:last-of-type { border-bottom: none; }
.req-head { display: flex; align-items: baseline; gap: 8px; }
.req-what { margin: 3px 0 7px; font-size: 12px; color: var(--text-secondary); }
.req-acts { display: flex; gap: 6px; }
.add-row { margin: 8px 0; }
.danger-text { color: var(--danger-fg); }
.dev-name {
  flex: 1 1 auto; min-width: 0;
  color: var(--text-bright); font-size: 14px; font-weight: 500;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.dev-count { margin-left: auto; font-size: 11px; color: var(--text-secondary); flex-shrink: 0; }
.pair-label {
  margin: 8px 0 0; font-size: var(--font-3xs); text-transform: uppercase;
  letter-spacing: 0.06em; color: var(--text-secondary);
}
.pair-code {
  margin: 2px 0 0; font-family: var(--font-mono, monospace);
  font-size: 22px; letter-spacing: 0.18em; color: var(--text-primary);
  user-select: text;
}
.qr-block { margin: 8px 0; }
/* Black on white whatever the theme: a scanner needs the contrast. */
.qr { display: block; width: 184px; height: 184px; border-radius: var(--radius-sm); }
.btn {
  appearance: none; border-radius: var(--radius-sm); font: inherit; font-weight: 500; cursor: pointer;
  background: var(--accent-emphasis); border: 1px solid var(--accent-emphasis); color: var(--text-on-emphasis);
}
.btn.small { padding: 2px 10px; font-size: 12px; flex-shrink: 0; }
.btn:not(:disabled):hover { box-shadow: inset 0 0 0 1px var(--text-on-emphasis); }
.btn.ghost { background: transparent; border-color: var(--border-default); color: inherit; }
.btn.ghost:not(:disabled):hover { background: var(--bg-muted); border-color: var(--border-strong); box-shadow: none; }
.btn.ghost.small.danger { color: var(--danger-fg); }
.btn:focus-visible { outline: 2px solid var(--accent-fg); outline-offset: 2px; }
.btn:disabled { opacity: 0.5; cursor: default; }
</style>
