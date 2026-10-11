<script setup lang="ts">
/**
 * The Share sub-tab: every share link this account has made, from any of its
 * devices, and what can be done to one that still opens — copy its URL
 * (rebuilt from the wrapped key, so any device holding the ring can), add
 * seven days, re-key it (new URL; the old one stops), revoke it — or revoke
 * them all. Revoking asks once more first.
 */
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { useBackend } from '../../composables/useBackend'
import { useShareLinks } from '../../composables/useShareLinks'
import { formatWhen as when } from '../../composables/useSyncInventory'
import SettingsCard from '../settings/SettingsCard.vue'
import SettingsSection from '../settings/SettingsSection.vue'

// `source`: a list the host already loaded (Settings probes share.list to
// decide whether to offer this tab), so opening it does not ask again.
const props = defineProps<{ backend: ReturnType<typeof useBackend>; source?: ReturnType<typeof useShareLinks> }>()
const { t } = useI18n()
const { links, status, loading, refresh, act } = props.source ?? useShareLinks(props.backend)

onMounted(() => {
  if (!props.source) void refresh()
})

const WEEK_SECONDS = 7 * 86400
const busy = ref('')
const armed = ref('')
const done = ref('')
const failed = ref('')

async function run(key: string, action: () => Promise<string>, reload: boolean): Promise<void> {
  busy.value = key
  armed.value = ''
  done.value = ''
  failed.value = ''
  try {
    done.value = await action()
    if (reload) await refresh()
  } catch (err) {
    failed.value = err instanceof Error ? err.message : String(err)
  } finally {
    busy.value = ''
  }
}

async function copy(url: unknown): Promise<void> {
  if (typeof url !== 'string' || !url) throw new Error('SHARE_FAILED')
  await navigator.clipboard.writeText(url)
}

const copyLink = (id: string) =>
  run(id, async () => {
    await copy((await act('share.copy_link', { linkId: id })).url)
    return t('settings.cloud.share.copied')
  }, false)
const extend = (id: string) =>
  run(id, async () => {
    await act('share.extend', { linkId: id, ttlSeconds: WEEK_SECONDS })
    return t('settings.cloud.share.extended')
  }, true)
const rekey = (id: string) =>
  run(id, async () => {
    await copy((await act('share.rekey', { linkId: id })).url)
    return t('settings.cloud.share.rekeyed')
  }, true)
const revoke = (id: string) =>
  run(id, async () => {
    await act('share.revoke', { linkId: id })
    return t('settings.cloud.share.revoked')
  }, true)
const revokeAll = () =>
  run('all', async () => {
    await act('share.revoke_all', {})
    return t('settings.cloud.share.revoked-all')
  }, true)
</script>

<template>
  <SettingsSection :label="t('settings.cloud.share.title')">
    <p class="sl-hint">{{ t('settings.cloud.share.hint') }}</p>
    <p v-if="status === 'unavailable'" class="sl-note" data-notice="unavailable">
      {{ t('settings.cloud.share.unavailable') }}
    </p>
    <p v-else-if="status === 'error'" class="sl-note" data-notice="error">
      {{ t('settings.cloud.share.error') }}
    </p>
    <p v-else-if="status === 'ok' && !links.length" class="sl-note" data-notice="empty">
      {{ t('settings.cloud.share.empty') }}
    </p>
    <SettingsCard v-else-if="links.length">
      <div class="sl-table" role="table">
        <div class="sl-row sl-row--head" role="row">
          <span role="columnheader">{{ t('settings.cloud.share.col-item') }}</span>
          <span role="columnheader">{{ t('settings.cloud.share.col-creator') }}</span>
          <span role="columnheader">{{ t('settings.cloud.share.col-created') }}</span>
          <span role="columnheader">{{ t('settings.cloud.share.col-expires') }}</span>
          <span role="columnheader">{{ t('settings.cloud.share.col-opens') }}</span>
          <span role="columnheader">{{ t('settings.cloud.share.col-last-open') }}</span>
          <span role="columnheader"></span>
        </div>
        <div
          v-for="link in links"
          :key="link.linkId"
          class="sl-row"
          :class="{ 'sl-row--gone': !!link.revokedAt }"
          role="row"
          :data-link-id="link.linkId"
        >
          <span role="cell" class="sl-item">
            <strong>{{ link.title || link.linkId.slice(0, 6) }}</strong>
            <small>{{ link.kind }}<template v-if="link.deviceName"> · {{ link.deviceName }}</template></small>
          </span>
          <span role="cell">
            {{ link.createdBy === 'agent' ? t('settings.cloud.share.creator-agent', { pane: link.pane || '—' }) : t('settings.cloud.share.creator-user') }}
          </span>
          <span role="cell">{{ when(link.createdAt) }}</span>
          <span role="cell">{{ when(link.expiresAt) }}</span>
          <span role="cell">{{ link.openCount }}</span>
          <span role="cell">{{ when(link.lastOpenedAt) }}</span>
          <span role="cell" class="sl-actions-cell">
            <template v-if="link.active">
              <button type="button" data-action="copy" :disabled="!!busy" @click="copyLink(link.linkId)">
                {{ t('settings.cloud.share.copy') }}
              </button>
              <button type="button" data-action="extend" :disabled="!!busy" @click="extend(link.linkId)">
                {{ t('settings.cloud.share.extend') }}
              </button>
              <button type="button" data-action="rekey" :disabled="!!busy" @click="rekey(link.linkId)">
                {{ t('settings.cloud.share.rekey') }}
              </button>
              <button
                v-if="armed !== link.linkId"
                type="button"
                data-action="revoke"
                :disabled="!!busy"
                @click="armed = link.linkId"
              >
                {{ t('settings.cloud.share.revoke') }}
              </button>
              <template v-else>
                <button type="button" data-action="revoke-confirm" @click="revoke(link.linkId)">
                  {{ t('settings.cloud.share.revoke-confirm') }}
                </button>
                <button type="button" data-action="revoke-cancel" @click="armed = ''">
                  {{ t('settings.cloud.share.cancel') }}
                </button>
              </template>
            </template>
          </span>
        </div>
      </div>
    </SettingsCard>
    <p v-if="done" class="sl-note" data-notice="done">{{ done }}</p>
    <p v-if="failed" class="sl-note sl-error" data-notice="action-error">
      {{ t('settings.cloud.share.action-failed', { code: failed }) }}
    </p>
    <div class="sl-actions">
      <button type="button" :disabled="loading" @click="refresh">{{ t('settings.cloud.share.refresh') }}</button>
      <template v-if="links.some((l) => l.active)">
        <button v-if="armed !== 'all'" type="button" data-action="revoke-all" :disabled="!!busy" @click="armed = 'all'">
          {{ t('settings.cloud.share.revoke-all') }}
        </button>
        <template v-else>
          <button type="button" data-action="revoke-all-confirm" @click="revokeAll()">
            {{ t('settings.cloud.share.revoke-all-confirm') }}
          </button>
          <button type="button" data-action="revoke-all-cancel" @click="armed = ''">
            {{ t('settings.cloud.share.cancel') }}
          </button>
        </template>
      </template>
    </div>
  </SettingsSection>
</template>

<style scoped>
.sl-hint,
.sl-note {
  font-size: var(--font-row-desc);
  color: var(--text-secondary);
  margin: 0 0 8px;
}
.sl-table {
  display: flex;
  flex-direction: column;
}
.sl-row {
  display: grid;
  grid-template-columns: minmax(0, 2fr) minmax(0, 1fr) repeat(2, minmax(0, 1fr)) 48px minmax(0, 1fr) auto;
  gap: 10px;
  align-items: center;
  padding: var(--space-row-y) var(--space-row-x);
  font-size: var(--font-row-desc);
}
.sl-row + .sl-row {
  border-top: 1px solid var(--border-muted);
}
.sl-row--head {
  color: var(--text-secondary);
  font-weight: 600;
}
.sl-row--gone {
  opacity: 0.55;
}
.sl-item {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.sl-item strong,
.sl-item small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sl-item small {
  color: var(--text-secondary);
}
.sl-actions {
  display: flex;
  gap: 6px;
  margin-top: 8px;
}
.sl-actions-cell {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.sl-error {
  color: var(--text-danger, var(--text-secondary));
}
</style>
