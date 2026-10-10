<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { useBackend } from '../composables/useBackend'
import { consumeConvenienceOverviewRequest, useConvenienceState } from '../composables/useConvenience'
import ConvenienceOverview from './ConvenienceOverview.vue'
import { convenienceText } from '../lib/convenienceText'

// Settings → CLI Extensions: what each AI CLI installed for itself, as the
// backend's `cli_extensions.list` reflects it. Read-only on purpose (Phase 1 of
// the CLI extensions plan): the only button rescans. Terms follow
// docs/en-US/glossary.md — the vendor's own type label is shown untranslated.

interface CliExtension {
  cli: string
  id: string
  name: string
  version: string
  kind: string
  type_label: string
  scope: string
  enabled: boolean
  exec_tier: 'L1' | 'L2' | 'L3'
  capabilities: string[]
  native_consent: string
  owner: string
  evidence: string
  path: string
  components: string[]
  detail: string
  valid: boolean
  error: string
}

interface CliVendor {
  cli: string
  label: string
  supported: boolean
  note: string
  count: number
}

const props = defineProps<{ backend: Pick<ReturnType<typeof useBackend>, 'send'> }>()

const { t } = useI18n()
// Second tab: the convenience features overview (what Navide itself changes
// on this computer). An announcement's link opens it through
// openConvenienceOverview().
const tab = ref<'installed' | 'convenience'>(consumeConvenienceOverviewRequest() ? 'convenience' : 'installed')
const { overviewRequest } = useConvenienceState()
watch(overviewRequest, () => { if (consumeConvenienceOverviewRequest()) tab.value = 'convenience' })
/** The overview card a `navide-change` row was opened from. */
const focusFeature = ref('')

// Rows of kind `navide-change` are Navide's own writes, named by convenience
// feature id: shown by the feature's name and linked to its overview card.
function isNavideChange(item: CliExtension): boolean {
  return item.kind === 'navide-change'
}

function openFeature(id: string): void {
  focusFeature.value = id
  tab.value = 'convenience'
}
const vendors = ref<CliVendor[]>([])
const items = ref<CliExtension[]>([])
const loading = ref(false)
const error = ref('')

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const resp = await props.backend.send<{ vendors: CliVendor[]; items: CliExtension[] }>('cli_extensions.list', {})
    if (resp.ok && resp.payload) {
      vendors.value = resp.payload.vendors
      items.value = resp.payload.items
    } else {
      error.value = resp.error?.message || resp.error?.code || '?'
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    loading.value = false
  }
}

const valid = computed(() => items.value.filter((item) => item.valid))
const inProcess = computed(() => valid.value.filter((item) => item.exec_tier === 'L3').length)

// L3 first inside each CLI: code running in the CLI's own process is what a
// reader should see before hooks and text assets.
const TIER_ORDER = { L3: 0, L2: 1, L1: 2 } as const
const groups = computed(() =>
  vendors.value.map((vendor) => ({
    vendor,
    rows: items.value
      .filter((item) => item.cli === vendor.cli)
      .sort((a, b) => TIER_ORDER[a.exec_tier] - TIER_ORDER[b.exec_tier] || a.name.localeCompare(b.name)),
  })),
)

onMounted(() => { void load() })
</script>

<template>
  <div class="cli-ext-tabs" role="tablist">
    <button type="button" role="tab" class="cli-ext-tab" data-tab="installed" :aria-selected="tab === 'installed'" @click="tab = 'installed'">
      {{ t('settings.cliExtensions.tabInstalled') }}
    </button>
    <button type="button" role="tab" class="cli-ext-tab" data-tab="convenience" :aria-selected="tab === 'convenience'" @click="tab = 'convenience'">
      {{ t('convenience.overview.title') }}
    </button>
  </div>
  <ConvenienceOverview v-if="tab === 'convenience'" :backend="props.backend" :focus="focusFeature" />
  <section v-show="tab === 'installed'" class="cli-ext" data-settings-section="cli-extensions">
    <p class="cli-ext-intro">{{ t('settings.cliExtensions.intro') }}</p>
    <div class="cli-ext-summary">
      <span class="cli-ext-counts">{{ t('settings.cliExtensions.summary', { total: valid.length, l3: inProcess }) }}</span>
      <button type="button" class="cli-ext-rescan" :disabled="loading" @click="load">
        {{ loading ? t('settings.cliExtensions.loading') : t('settings.cliExtensions.rescan') }}
      </button>
    </div>
    <p class="cli-ext-note">{{ t('settings.cliExtensions.machineWide') }}</p>
    <p v-if="error" role="alert" class="cli-ext-error">{{ t('settings.cliExtensions.loadFailed', { error }) }}</p>

    <details v-for="group in groups" :key="group.vendor.cli" class="cli-ext-group" :data-cli="group.vendor.cli" open>
      <summary>
        <span class="cli-ext-vendor">{{ group.vendor.label }}</span>
        <span class="cli-ext-vendor-count">{{ group.vendor.count }}</span>
      </summary>
      <p v-if="!group.vendor.supported" class="cli-ext-empty cli-ext-unsupported">{{ t('settings.cliExtensions.unsupported') }}</p>
      <p v-else-if="!group.rows.length" class="cli-ext-empty">{{ t('settings.cliExtensions.empty') }}</p>
      <ul v-else class="cli-ext-list">
        <li
          v-for="item in group.rows"
          :key="item.id"
          class="cli-ext-card"
          :data-id="item.id"
          :data-tier="item.exec_tier"
          :class="{ off: !item.enabled, broken: !item.valid }"
        >
          <div class="cli-ext-head">
            <button
              v-if="isNavideChange(item)"
              type="button"
              class="cli-ext-name cli-ext-feature-link"
              :data-feature="item.name"
              @click="openFeature(item.name)"
            >{{ convenienceText(item.name, 'name') }}</button>
            <span v-else class="cli-ext-name">{{ item.name }}</span>
            <span v-if="item.version" class="cli-ext-version">{{ item.version }}</span>
            <span class="cli-ext-type">{{ item.type_label }}</span>
            <span class="cli-ext-tier" :class="`tier-${item.exec_tier}`" :title="t(`settings.cliExtensions.tierHint.${item.exec_tier}`)">
              {{ t(`settings.cliExtensions.tier.${item.exec_tier}`) }}
            </span>
            <span v-if="item.owner === 'navide'" class="cli-ext-owner">{{ t('settings.cliExtensions.ownerNavide') }}</span>
            <span v-if="!item.enabled" class="cli-ext-disabled">{{ t('settings.cliExtensions.disabled') }}</span>
          </div>
          <p v-if="!item.valid" class="cli-ext-error">{{ t('settings.cliExtensions.invalid', { error: item.error }) }}</p>
          <template v-else>
            <div v-if="item.capabilities.length" class="cli-ext-caps">
              <span v-for="cap in item.capabilities" :key="cap" class="cli-ext-cap" :data-cap="cap">{{ t(`settings.cliExtensions.capability.${cap}`) }}</span>
              <span v-if="item.evidence === 'inferred'" class="cli-ext-inferred" :title="t('settings.cliExtensions.inferredHint')">{{ t('settings.cliExtensions.inferred') }}</span>
            </div>
            <p v-if="!isNavideChange(item)" class="cli-ext-consent">{{ t(`settings.cliExtensions.consent.${item.native_consent}`) }}</p>
            <code v-if="item.detail" v-truncate class="cli-ext-detail">{{ item.detail }}</code>
            <code v-if="item.path" v-truncate class="cli-ext-path">{{ item.path }}</code>
          </template>
        </li>
      </ul>
    </details>
  </section>
</template>

<style scoped>
.cli-ext-tabs { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 10px; border-bottom: 1px solid var(--border-muted); }
.cli-ext-tab { font: inherit; font-size: var(--font-xs); color: var(--text-secondary); background: none; border: none; border-bottom: 2px solid transparent; padding: 4px 8px; cursor: pointer; }
.cli-ext-tab[aria-selected='true'] { color: var(--text-bright); border-bottom-color: var(--accent-fg, var(--text-bright)); }
.cli-ext { display: flex; flex-direction: column; gap: 10px; }
.cli-ext-intro, .cli-ext-note { margin: 0; font-size: 11.5px; color: var(--text-secondary); }
.cli-ext-summary { display: flex; align-items: center; gap: 10px; }
.cli-ext-counts { font-size: var(--font-sm); font-weight: 600; color: var(--text-bright); }
.cli-ext-rescan { font: inherit; font-size: var(--font-2xs); color: var(--text-primary); background: var(--bg-subtle); border: 1px solid var(--border-default); border-radius: var(--radius-xs); padding: 3px 8px; cursor: pointer; }
.cli-ext-rescan:disabled { opacity: 0.5; cursor: default; }
.cli-ext-error { margin: 0; font-size: var(--font-2xs); color: var(--danger-fg); }
.cli-ext-group { border: 1px solid var(--border-muted); border-radius: var(--radius-xs); }
.cli-ext-group > summary { display: flex; align-items: center; gap: 8px; padding: 6px 10px; cursor: pointer; font-size: var(--font-sm); color: var(--text-bright); }
.cli-ext-vendor-count { font-size: var(--font-2xs); color: var(--text-secondary); }
.cli-ext-empty { margin: 0; padding: 4px 10px 10px; font-size: var(--font-2xs); color: var(--text-secondary); }
.cli-ext-list { list-style: none; margin: 0; padding: 0 10px 10px; display: flex; flex-direction: column; gap: 6px; }
.cli-ext-card { border: 1px solid var(--border-muted); border-radius: var(--radius-xs); padding: 6px 8px; display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.cli-ext-card.off { opacity: 0.7; }
.cli-ext-head { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; min-width: 0; }
.cli-ext-name { font-weight: 600; color: var(--text-bright); font-size: var(--font-xs); overflow-wrap: anywhere; }
.cli-ext-feature-link { font: inherit; font-weight: 600; background: none; border: none; padding: 0; cursor: pointer; text-align: left; text-decoration: underline; }
.cli-ext-version { font-size: var(--font-2xs); color: var(--text-secondary); }
.cli-ext-type, .cli-ext-tier, .cli-ext-owner, .cli-ext-disabled, .cli-ext-cap, .cli-ext-inferred { font-size: 10.5px; border-radius: 99px; padding: 0 7px; border: 1px solid var(--border-default); color: var(--text-secondary); white-space: nowrap; }
.cli-ext-tier.tier-L3 { color: var(--danger-fg); border-color: var(--danger-fg); }
.cli-ext-tier.tier-L2 { color: var(--warning-fg, var(--text-primary)); }
.cli-ext-owner { color: var(--accent-fg, var(--text-primary)); }
.cli-ext-caps { display: flex; flex-wrap: wrap; gap: 4px; }
.cli-ext-inferred { border-style: dashed; }
.cli-ext-consent { margin: 0; font-size: var(--font-2xs); color: var(--text-secondary); }
.cli-ext-detail, .cli-ext-path { font-size: 10.5px; color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: block; }
</style>
