<script setup lang="ts">
// A2-3 (DESIGN-A2 G2): the "Local folder" info card, opened from the source
// badge of a developer folder in the Navide plugin list or a view's title
// strip. Host chrome, never inside a plugin frame. It shows what was loaded:
// the folder, when and how it was last loaded, the content fingerprint taken
// then and who loaded it. The fingerprint is only disclosed; Navide never
// compares it or refuses a load over it.
import { computed, ref } from 'vue'
import { revealInvisibleText as reveal } from '../../../shared/pluginAgentTools'
import { revealPath } from '../composables/hostShell'

export interface DeveloperFolderInfo {
  pluginId: string
  path: string
  lastLoad?: {
    at: string
    trigger: string
    fingerprint?: string
    fileCount?: number
  } | null
  loadedBy?: { kind: 'user' } | { kind: 'agent'; requester: string; requestId?: string; approvedAt?: string } | null
}

const props = defineProps<{ folder: DeveloperFolderInfo }>()
defineEmits<{ close: [] }>()

const TRIGGERS = ['user-load', 'manual-reload', 'auto-reload', 'startup', 'developer-mode-on']
const copied = ref(false)

const loadedAt = computed(() => (props.folder.lastLoad?.at ? new Date(props.folder.lastLoad.at).toLocaleString() : ''))
const trigger = computed(() => {
  const value = props.folder.lastLoad?.trigger
  return value && TRIGGERS.includes(value) ? value : null
})
const fingerprint = computed(() => props.folder.lastLoad?.fingerprint ?? '')

async function copyFingerprint(): Promise<void> {
  try {
    await navigator.clipboard.writeText(fingerprint.value)
    copied.value = true
  } catch {
    copied.value = false
  }
}
</script>

<template>
  <div class="nv-folder-card" role="dialog" :aria-label="$t('pluginDisclosure.source.developer-unpacked')" :data-plugin-id="folder.pluginId">
    <header class="nv-folder-card-head">
      <strong>{{ $t('pluginDisclosure.source.developer-unpacked') }}</strong>
      <span class="nv-folder-card-id">{{ reveal(folder.pluginId) }}</span>
      <button type="button" class="nv-folder-card-close nv-btn nv-btn--sm" @click="$emit('close')">
        {{ $t('settings.extensions.developerMode.infoCard.close') }}
      </button>
    </header>
    <dl class="nv-folder-card-facts">
      <dt>{{ $t('settings.extensions.developerMode.infoCard.path') }}</dt>
      <dd>
        <code class="nv-folder-card-path">{{ reveal(folder.path) }}</code>
        <button type="button" class="nv-folder-card-reveal nv-btn nv-btn--sm" @click="revealPath(folder.path)">
          {{ $t('settings.extensions.developerMode.infoCard.reveal') }}
        </button>
      </dd>
      <dt>{{ $t('settings.extensions.developerMode.infoCard.loadedAt') }}</dt>
      <dd class="nv-folder-card-loaded">
        <template v-if="loadedAt">
          {{ loadedAt }}
          <span v-if="trigger" class="nv-folder-card-trigger">{{ $t(`settings.extensions.developerMode.infoCard.trigger.${trigger}`) }}</span>
        </template>
        <template v-else>{{ $t('settings.extensions.developerMode.infoCard.notRecorded') }}</template>
      </dd>
      <dt>{{ $t('settings.extensions.developerMode.infoCard.fingerprint') }}</dt>
      <dd class="nv-folder-card-fingerprint">
        <template v-if="fingerprint">
          <code :title="fingerprint">{{ fingerprint.slice(0, 12) }}</code>
          <button type="button" class="nv-folder-card-copy nv-btn nv-btn--sm" @click="copyFingerprint">
            {{ copied ? $t('settings.extensions.developerMode.infoCard.copied') : $t('settings.extensions.developerMode.infoCard.copy') }}
          </button>
          <span v-if="folder.lastLoad?.fileCount !== undefined" class="nv-folder-card-files">
            {{ $t('settings.extensions.developerMode.infoCard.fileCount', { count: folder.lastLoad.fileCount }) }}
          </span>
        </template>
        <template v-else-if="loadedAt">{{ $t('settings.extensions.developerMode.infoCard.computing') }}</template>
        <template v-else>{{ $t('settings.extensions.developerMode.infoCard.notRecorded') }}</template>
      </dd>
      <dt>{{ $t('settings.extensions.developerMode.infoCard.loadedBy') }}</dt>
      <dd class="nv-folder-card-loader">
        <template v-if="folder.loadedBy?.kind === 'agent'">
          {{ $t('settings.extensions.developerMode.infoCard.byAgent', {
            requester: reveal(folder.loadedBy.requester),
            time: folder.loadedBy.approvedAt ? new Date(folder.loadedBy.approvedAt).toLocaleString() : '',
          }) }}
        </template>
        <template v-else-if="folder.loadedBy?.kind === 'user'">{{ $t('settings.extensions.developerMode.infoCard.byUser') }}</template>
        <template v-else>{{ $t('settings.extensions.developerMode.infoCard.byUnknown') }}</template>
      </dd>
    </dl>
    <p class="nv-folder-card-note">{{ $t('settings.extensions.developerMode.infoCard.notReviewed') }}</p>
    <p class="nv-folder-card-note">{{ $t('settings.extensions.developerMode.infoCard.mayChange') }}</p>
  </div>
</template>

<style scoped>
.nv-folder-card {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  max-width: 520px;
  padding: var(--space-3);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: var(--surface-raised, var(--bg-primary));
  font-size: var(--font-sm);
  box-shadow: var(--shadow-md);
}
.nv-folder-card-head {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
}
.nv-folder-card-close {
  margin-left: auto;
}
.nv-folder-card-facts {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 4px var(--space-3);
  margin: 0;
}
.nv-folder-card-facts dd {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--space-2);
  margin: 0;
  min-width: 0;
}
.nv-folder-card-path {
  overflow-wrap: anywhere;
}
.nv-folder-card-note {
  margin: 0;
  color: var(--text-secondary);
}
</style>
