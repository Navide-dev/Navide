<script setup lang="ts">
/**
 * The Share sub-tab: every share link this account has made, from any of its
 * devices. This build lists what `share.list` returns and nothing more —
 * copying, extending, re-keying and revoking arrive with the server calls.
 */
import { onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import type { useBackend } from '../../composables/useBackend'
import { useShareLinks } from '../../composables/useShareLinks'
import SettingsCard from '../settings/SettingsCard.vue'
import SettingsSection from '../settings/SettingsSection.vue'

const props = defineProps<{ backend: ReturnType<typeof useBackend> }>()
const { t } = useI18n()
const { links, status, loading, refresh } = useShareLinks(props.backend)

onMounted(() => {
  void refresh()
})

const when = (at: string): string => (at ? new Date(at).toLocaleString() : '—')
</script>

<template>
  <SettingsSection :label="t('settings.cloud.share.title')">
    <p class="sl-hint">{{ t('settings.cloud.share.hint') }}</p>
    <p v-if="status === 'unavailable'" class="sl-note" data-notice="unavailable">
      {{ t('settings.cloud.share.unavailable') }}
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
        </div>
      </div>
    </SettingsCard>
    <div class="sl-actions">
      <button type="button" :disabled="loading" @click="refresh">{{ t('settings.cloud.share.refresh') }}</button>
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
  grid-template-columns: minmax(0, 2fr) minmax(0, 1fr) repeat(2, minmax(0, 1fr)) 48px minmax(0, 1fr);
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
  margin-top: 8px;
}
</style>
