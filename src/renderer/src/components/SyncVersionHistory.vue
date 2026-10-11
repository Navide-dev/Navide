<script setup lang="ts">
/**
 * Earlier versions of one synced item, and putting one back. The server keeps
 * each item's last 10 versions or 30 days, whichever ends first. A restored
 * version lands the way a synced record does: a prompt at once, an MCP server
 * or skill through the approval card, and it reaches the other devices on the
 * next sync round.
 */
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { useBackend } from '../composables/useBackend'

type Backend = ReturnType<typeof useBackend>

interface Version {
  rev: number
  updatedAt: string
  deviceId: string
  supersededAt: string
}

const SCOPES = ['prompts', 'mcp', 'skills'] as const

const props = defineProps<{ backend: Backend }>()
const { t } = useI18n()

const open = ref(false)
const scope = ref<(typeof SCOPES)[number]>('prompts')
const items = ref<string[]>([])
const itemId = ref('')
const versions = ref<Version[] | null>(null)
const busy = ref(false)
const notice = ref('')
const error = ref('')

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function readVersions(payload: unknown): Version[] {
  const rows = isRecord(payload) && Array.isArray(payload.versions) ? payload.versions : []
  return rows.filter(isRecord).map((row) => ({
    rev: Number(row.rev ?? 0),
    updatedAt: String(row.updatedAt ?? ''),
    deviceId: String(row.deviceId ?? ''),
    supersededAt: String(row.supersededAt ?? ''),
  }))
}

function when(iso: string): string {
  const at = new Date(iso)
  return Number.isNaN(at.getTime()) ? iso : at.toLocaleString()
}

async function loadItems(): Promise<void> {
  error.value = ''
  versions.value = null
  const resp = await props.backend.send('sync.inventory', { scope: scope.value })
  if (!resp?.ok) {
    items.value = []
    error.value = resp?.error?.message ?? t('settings.sync.history-error')
    return
  }
  const scopes = isRecord(resp.payload) && isRecord(resp.payload.scopes) ? resp.payload.scopes : {}
  const entry = scopes[scope.value]
  const rows = isRecord(entry) && Array.isArray(entry.items) ? entry.items : []
  items.value = [...new Set(rows.filter(isRecord).map((row) => String(row.itemId ?? '')).filter(Boolean))]
  if (!items.value.includes(itemId.value)) itemId.value = items.value[0] ?? ''
}

async function show(): Promise<void> {
  if (!itemId.value) return
  busy.value = true
  error.value = ''
  notice.value = ''
  try {
    const resp = await props.backend.send('sync.versions', { scope: scope.value, itemId: itemId.value })
    if (!resp?.ok) {
      versions.value = null
      error.value = resp?.error?.message ?? t('settings.sync.history-error')
      return
    }
    versions.value = readVersions(resp.payload)
  } finally {
    busy.value = false
  }
}

async function restore(version: Version): Promise<void> {
  busy.value = true
  error.value = ''
  notice.value = ''
  try {
    const resp = await props.backend.send('sync.restore_version', {
      scope: scope.value,
      itemId: itemId.value,
      rev: version.rev,
    })
    if (!resp?.ok) {
      error.value = resp?.error?.message ?? t('settings.sync.history-error')
      return
    }
    const held = isRecord(resp.payload) && resp.payload.held === true
    notice.value = t(held ? 'settings.sync.history-held' : 'settings.sync.history-restored')
  } finally {
    busy.value = false
  }
}

function toggle(): void {
  open.value = !open.value
  if (open.value) void loadItems()
}

watch(scope, () => void loadItems())
watch(itemId, () => {
  versions.value = null
  notice.value = ''
})
</script>

<template>
  <div class="sync-history">
    <button type="button" class="sync-history-toggle" data-test="history-open" :aria-expanded="open" @click="toggle">
      {{ open ? '▾' : '▸' }} {{ t('settings.sync.history-title') }}
    </button>
    <template v-if="open">
      <p class="sync-hint">{{ t('settings.sync.history-hint') }}</p>
      <div class="sync-history-pick">
        <select v-model="scope" data-test="history-scope" :aria-label="t('settings.sync.history-scope')">
          <option v-for="s in SCOPES" :key="s" :value="s">{{ t('settings.sync.scope-' + s) }}</option>
        </select>
        <select
          v-model="itemId"
          data-test="history-item"
          :disabled="!items.length"
          :aria-label="t('settings.sync.history-item')"
        >
          <option v-for="name in items" :key="name" :value="name">{{ name }}</option>
        </select>
        <button type="button" data-test="history-show" :disabled="busy || !itemId" @click="show">
          {{ t('settings.sync.history-show') }}
        </button>
      </div>
      <p v-if="!items.length && !error" class="sync-hint">{{ t('settings.sync.history-no-items') }}</p>
      <template v-if="versions">
        <p v-if="!versions.length" class="sync-hint">{{ t('settings.sync.history-empty') }}</p>
        <button
          v-else
          type="button"
          data-test="history-restore-previous"
          :disabled="busy"
          @click="restore(versions[0])"
        >
          {{ t('settings.sync.history-restore-previous') }}
        </button>
        <ul class="sync-history-list">
          <li v-for="v in versions" :key="v.rev" data-test="history-version">
            <span>{{ when(v.updatedAt) }}</span>
            <span class="sync-hint">{{ t('settings.sync.history-device', { device: v.deviceId }) }}</span>
            <button type="button" data-test="history-restore" :disabled="busy" @click="restore(v)">
              {{ t('settings.sync.history-restore') }}
            </button>
          </li>
        </ul>
      </template>
      <p v-if="notice" class="sync-note">{{ notice }}</p>
      <p v-if="error" class="err-msg">{{ error }}</p>
    </template>
  </div>
</template>

<style scoped>
.sync-history {
  margin-top: 16px;
}
.sync-history-toggle {
  background: none;
  border: none;
  padding: 0;
  color: var(--text-primary);
  font-weight: 600;
  cursor: pointer;
}
.sync-history-pick {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  margin: 8px 0;
}
.sync-history-pick select {
  min-width: 0;
  max-width: 100%;
}
.sync-history-list {
  list-style: none;
  padding: 0;
  margin: 8px 0 0;
}
.sync-history-list li {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  padding: 4px 0;
}
.sync-hint,
.sync-note {
  font-size: var(--font-row-desc);
  color: var(--text-secondary);
  margin: 6px 0 0;
}
</style>
