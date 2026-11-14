<script setup lang="ts">
/**
 * Settings → Accounts: the switches an agent or a chat button made without
 * the user's click (account_switch_log, kept 90 days). Read-only — the record
 * is how the user learns who switched what, when and why.
 */
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { useBackend } from '../../composables/useBackend'

export interface AccountSwitchLogEntry {
  id: number
  created_at: number
  source: string
  requester: string
  agent_key: string
  from_name: string | null
  to_name: string | null
  to_profile_id: string
  pane_name: string | null
  reason: string
  status: string
  code: string | null
}

const props = defineProps<{ backend?: ReturnType<typeof useBackend> }>()
const { t } = useI18n()

const entries = ref<AccountSwitchLogEntry[]>([])
const loading = ref(false)

async function refresh(): Promise<void> {
  if (!props.backend) return
  loading.value = true
  try {
    const resp = await props.backend.send<{ entries?: AccountSwitchLogEntry[] }>('account_switch_log.list', { limit: 200 })
    entries.value = resp.payload?.entries ?? []
  } catch {
    // Unreachable backend: keep what is shown.
  } finally {
    loading.value = false
  }
}

onMounted(refresh)

function when(ts: number): string {
  return new Date(ts * 1000).toLocaleString()
}

const STATUS_KEYS: Record<string, string> = {
  switched: 'switched',
  'switched-signed-out': 'switched',
  'switched-pane': 'switched',
  queued: 'queued',
  requested: 'queued',
  superseded: 'superseded',
  cancelled: 'cancelled',
  stale: 'stale',
}

function statusLabel(entry: AccountSwitchLogEntry): string {
  const key = STATUS_KEYS[entry.status] ?? 'failed'
  const label = t(`settings.accounts.cli.switch-log-status-${key}`)
  return key === 'failed' ? `${label} (${entry.code || entry.status})` : label
}
</script>

<template>
  <section class="switch-log" data-testid="account-switch-log">
    <div class="switch-log-head">
      <span class="cli-group-label">{{ t('settings.accounts.cli.switch-log-title') }}</span>
      <button type="button" class="switch-log-refresh" :disabled="loading" @click="refresh">
        {{ t('settings.accounts.cli.switch-log-refresh') }}
      </button>
    </div>
    <p class="switch-log-hint">{{ t('settings.accounts.cli.switch-log-hint') }}</p>
    <p v-if="!entries.length" class="switch-log-empty">{{ t('settings.accounts.cli.switch-log-empty') }}</p>
    <table v-else class="switch-log-table">
      <thead>
        <tr>
          <th>{{ t('settings.accounts.cli.switch-log-col-time') }}</th>
          <th>{{ t('settings.accounts.cli.switch-log-col-who') }}</th>
          <th>{{ t('settings.accounts.cli.switch-log-col-account') }}</th>
          <th>{{ t('settings.accounts.cli.switch-log-col-status') }}</th>
          <th>{{ t('settings.accounts.cli.switch-log-col-reason') }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="entry in entries" :key="entry.id" data-testid="account-switch-log-row">
          <td class="switch-log-time">{{ when(entry.created_at) }}</td>
          <td>{{ entry.requester }}</td>
          <td>
            {{ entry.agent_key }}: {{ entry.from_name || '?' }} → {{ entry.to_name || entry.to_profile_id }}
            <span v-if="entry.pane_name" class="switch-log-pane">
              ({{ t('settings.accounts.cli.switch-log-pane', { pane: entry.pane_name }) }})
            </span>
          </td>
          <td>{{ statusLabel(entry) }}</td>
          <td class="switch-log-reason">{{ entry.reason || '—' }}</td>
        </tr>
      </tbody>
    </table>
  </section>
</template>

<style scoped>
.switch-log { display: flex; flex-direction: column; gap: 8px; }
.switch-log-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.switch-log-hint, .switch-log-empty { margin: 0; color: var(--text-secondary); font-size: 12px; }
.switch-log-refresh {
  font-size: 12px; padding: 2px 10px; border-radius: 6px;
  border: 1px solid var(--border-default); background: transparent; color: var(--text-primary); cursor: pointer;
}
.switch-log-refresh:disabled { opacity: 0.5; cursor: default; }
.switch-log-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.switch-log-table th {
  text-align: left; font-weight: 600; color: var(--text-secondary);
  padding: 4px 8px; border-bottom: 1px solid var(--border-default);
}
.switch-log-table td { padding: 4px 8px; border-bottom: 1px solid var(--border-subtle, var(--border-default)); vertical-align: top; }
.switch-log-time { white-space: nowrap; }
.switch-log-pane { color: var(--text-secondary); }
.switch-log-reason { word-break: break-word; }
</style>
