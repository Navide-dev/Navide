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
  /** Set when the file holding the on/off switch could not be read: `enabled` is then a default. */
  enabled_error?: string
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
      {{ t('settings.cliExtensions.tabConvenience') }}
    </button>
  </div>
  <div v-if="tab === 'convenience'" class="cli-ext-convenience">
    <ConvenienceOverview :backend="props.backend" :focus="focusFeature" />
  </div>
  <section v-show="tab === 'installed'" class="cli-ext" data-settings-section="cli-extensions">
    <header class="cli-ext-header">
      <p class="cli-ext-intro">{{ t('settings.cliExtensions.intro') }}</p>
      <div class="cli-ext-summary">
        <span class="cli-ext-counts">{{ t('settings.cliExtensions.summary', { total: valid.length, l3: inProcess }) }}</span>
        <button type="button" class="cli-ext-rescan" :disabled="loading" @click="load">
          {{ loading ? t('settings.cliExtensions.loading') : t('settings.cliExtensions.rescan') }}
        </button>
      </div>
      <p class="cli-ext-note">{{ t('settings.cliExtensions.machineWide') }}</p>
    </header>
    <p v-if="error" role="alert" class="cli-ext-error">{{ t('settings.cliExtensions.loadFailed', { error }) }}</p>

    <template v-for="group in groups" :key="group.vendor.cli">
      <!-- A CLI with nothing to list is one row: there is nothing to unfold. -->
      <div v-if="!group.vendor.supported || !group.rows.length" class="cli-ext-group is-empty" :data-cli="group.vendor.cli">
        <div class="cli-ext-group-head">
          <span class="cli-ext-vendor">{{ group.vendor.label }}</span>
          <span class="cli-ext-vendor-count">{{ group.vendor.count }}</span>
          <span v-if="!group.vendor.supported" class="cli-ext-empty cli-ext-unsupported">{{ t('settings.cliExtensions.unsupported') }}</span>
          <span v-else class="cli-ext-empty">{{ t('settings.cliExtensions.empty') }}</span>
        </div>
      </div>
      <details v-else class="cli-ext-group" :data-cli="group.vendor.cli" open>
        <summary class="cli-ext-group-head">
          <span class="cli-ext-chevron" aria-hidden="true" />
          <span class="cli-ext-vendor">{{ group.vendor.label }}</span>
          <span class="cli-ext-vendor-count">{{ group.vendor.count }}</span>
        </summary>
        <ul class="cli-ext-list">
          <li
            v-for="item in group.rows"
            :key="item.id"
            class="cli-ext-card"
            :data-id="item.id"
            :data-tier="item.exec_tier"
            :class="{ off: !item.enabled && !item.enabled_error, broken: !item.valid }"
          >
            <div class="cli-ext-title">
              <button
                v-if="isNavideChange(item)"
                type="button"
                class="cli-ext-name cli-ext-feature-link"
                :data-feature="item.name"
                @click="openFeature(item.name)"
              >{{ convenienceText(item.name, 'name') }}</button>
              <span v-else class="cli-ext-name">{{ item.name }}</span>
              <span v-if="item.version" class="cli-ext-version">{{ item.version }}</span>
            </div>
            <div class="cli-ext-badges">
              <span v-truncate class="cli-ext-type">{{ item.type_label }}</span>
              <span v-truncate class="cli-ext-tier" :class="`tier-${item.exec_tier}`" :title="t(`settings.cliExtensions.tierHint.${item.exec_tier}`)">
                {{ t(`settings.cliExtensions.tier.${item.exec_tier}`) }}
              </span>
              <span v-if="item.owner === 'navide'" v-truncate class="cli-ext-owner">{{ t('settings.cliExtensions.ownerNavide') }}</span>
              <span v-if="item.enabled_error" v-truncate class="cli-ext-unknown">{{ t('settings.cliExtensions.enabledUnknown') }}</span>
              <span v-else-if="!item.enabled" v-truncate class="cli-ext-disabled">{{ t('settings.cliExtensions.disabled') }}</span>
            </div>
            <p v-if="!item.valid" class="cli-ext-error">{{ t('settings.cliExtensions.invalid', { error: item.error }) }}</p>
            <template v-else>
              <p v-if="item.enabled_error" class="cli-ext-warning">{{ t('settings.cliExtensions.enabledUnknownReason', { error: item.enabled_error }) }}</p>
              <div v-if="item.capabilities.length" class="cli-ext-caps">
                <span v-for="cap in item.capabilities" :key="cap" v-truncate class="cli-ext-cap" :data-cap="cap">{{ t(`settings.cliExtensions.capability.${cap}`) }}</span>
                <span v-if="item.evidence === 'inferred'" v-truncate class="cli-ext-inferred" :title="t('settings.cliExtensions.inferredHint')">{{ t('settings.cliExtensions.inferred') }}</span>
              </div>
              <p v-if="!isNavideChange(item)" class="cli-ext-consent">{{ t(`settings.cliExtensions.consent.${item.native_consent}`) }}</p>
              <code v-if="item.detail" v-truncate class="cli-ext-detail">{{ item.detail }}</code>
              <code v-if="item.path" v-truncate class="cli-ext-path">{{ item.path }}</code>
            </template>
          </li>
        </ul>
      </details>
    </template>
  </section>
</template>

<style scoped>
/* The two tabs and the overview sit outside the scrolling list, so they
   carry the same page gutter; the overview scrolls on its own. */
.cli-ext-tabs { display: flex; flex-wrap: wrap; flex-shrink: 0; gap: 4px; margin: 12px 22px 0; border-bottom: 1px solid var(--border-muted); }
.cli-ext-tab { font: inherit; font-size: var(--font-xs); color: var(--text-secondary); background: none; border: none; border-bottom: 2px solid transparent; padding: 4px 8px; cursor: pointer; }
.cli-ext-tab[aria-selected='true'] { color: var(--text-bright); border-bottom-color: var(--accent-fg, var(--text-bright)); }
.cli-ext-convenience { flex: 1; min-height: 0; padding: 12px 22px 18px; overflow-y: auto; overflow-x: hidden; }
/* The Settings tab body is full-bleed and overflow:hidden (see .s-body--bleed
   in SettingsModal), so like the other bleed panes this one carries the page
   gutter and owns the scroll; without both the list sat flush against the
   edges and everything past the first screen was clipped. */
.cli-ext {
  display: flex;
  flex: 1;
  min-height: 0;
  flex-direction: column;
  gap: 10px;
  padding: 16px 22px 18px;
  overflow-y: auto;
  overflow-x: hidden;
  color: var(--text-primary);
}
/* A scrolling flex column must not squeeze its rows to fit. */
.cli-ext > * { flex-shrink: 0; }
.cli-ext-header { display: flex; flex-direction: column; gap: 8px; margin-bottom: 4px; }
.cli-ext-intro, .cli-ext-note { margin: 0; font-size: 11.5px; line-height: 1.5; color: var(--text-secondary); text-wrap: pretty; }
.cli-ext-summary { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; min-width: 0; }
.cli-ext-counts { flex: 1 1 240px; min-width: 0; font-size: var(--font-sm); font-weight: 600; color: var(--text-bright); }
.cli-ext-rescan { flex-shrink: 0; font: inherit; font-size: var(--font-2xs); color: var(--text-primary); background: var(--bg-muted); border: 1px solid var(--border-default); border-radius: var(--radius-control); padding: 4px 10px; cursor: pointer; }
.cli-ext-rescan:hover:not(:disabled) { background: var(--bg-elevated); color: var(--text-bright); }
.cli-ext-rescan:disabled { opacity: 0.5; cursor: default; }
.cli-ext-error { margin: 0; font-size: var(--font-2xs); color: var(--danger-fg); overflow-wrap: anywhere; }
.cli-ext-warning { margin: 0; font-size: var(--font-2xs); color: var(--warning-fg, var(--text-primary)); overflow-wrap: anywhere; }

.cli-ext-group { min-width: 0; border: 1px solid var(--border-muted); border-radius: var(--radius-md); background: var(--bg-inset); }
.cli-ext-group-head { display: flex; align-items: center; gap: 8px; min-width: 0; padding: 8px 12px; font-size: var(--font-sm); color: var(--text-bright); }
summary.cli-ext-group-head { cursor: pointer; list-style: none; border-radius: var(--radius-md); }
summary.cli-ext-group-head::-webkit-details-marker { display: none; }
summary.cli-ext-group-head:hover { background: var(--bg-hover-faint); }
.cli-ext-group[open] > summary.cli-ext-group-head { border-bottom: 1px solid var(--border-muted); border-radius: var(--radius-md) var(--radius-md) 0 0; }
.cli-ext-chevron { flex-shrink: 0; width: 0; height: 0; border-left: 5px solid var(--text-secondary); border-top: 4px solid transparent; border-bottom: 4px solid transparent; transition: transform 0.12s ease; }
.cli-ext-group[open] > summary .cli-ext-chevron { transform: rotate(90deg); }
.cli-ext-vendor { min-width: 0; font-weight: 600; overflow-wrap: anywhere; }
.cli-ext-vendor-count { flex-shrink: 0; min-width: 18px; padding: 0 6px; border-radius: var(--radius-pill); background: var(--bg-muted); font-size: var(--font-2xs); line-height: 16px; text-align: center; color: var(--text-secondary); }
.cli-ext-group.is-empty > .cli-ext-group-head { flex-wrap: wrap; padding: 6px 12px; }
.cli-ext-group.is-empty .cli-ext-vendor { font-weight: 500; color: var(--text-primary); }
.cli-ext-empty { margin-left: auto; min-width: 0; font-size: var(--font-2xs); color: var(--text-muted); text-align: right; }

.cli-ext-list { list-style: none; margin: 0; padding: 10px; display: flex; flex-direction: column; gap: 8px; }
.cli-ext-card { display: flex; flex-direction: column; gap: 6px; min-width: 0; padding: 9px 12px; border: 1px solid var(--border-muted); border-radius: var(--radius-sm); background: var(--bg-elevated); }
.cli-ext-card.off { opacity: 0.7; }
.cli-ext-card.broken { border-color: var(--danger-muted); }
.cli-ext-title { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 8px; min-width: 0; }
.cli-ext-name {
  min-width: 0;
  font-size: var(--font-xs);
  font-weight: 600;
  color: var(--text-bright);
  overflow-wrap: anywhere;
}
.cli-ext-version { min-width: 0; font-family: var(--font-mono); font-size: 10.5px; color: var(--text-secondary); overflow-wrap: anywhere; }
.cli-ext-badges, .cli-ext-caps { display: flex; flex-wrap: wrap; gap: 4px; min-width: 0; }
.cli-ext-type, .cli-ext-tier, .cli-ext-owner, .cli-ext-disabled, .cli-ext-unknown, .cli-ext-cap, .cli-ext-inferred { max-width: 100%; overflow: hidden; text-overflow: ellipsis; box-sizing: border-box; font-size: 10.5px; line-height: 16px; border-radius: var(--radius-pill); padding: 0 7px; border: 1px solid var(--border-default); color: var(--text-secondary); white-space: nowrap; }
.cli-ext-type { color: var(--text-primary); background: var(--bg-muted); }
.cli-ext-tier.tier-L3 { color: var(--danger-fg); border-color: var(--danger-muted); background: var(--danger-subtle); }
.cli-ext-tier.tier-L2 { color: var(--warning-fg, var(--text-primary)); border-color: var(--attention-muted); background: var(--attention-subtle); }
.cli-ext-owner { color: var(--accent-fg, var(--text-primary)); border-color: var(--accent-muted); background: var(--accent-subtle); }
.cli-ext-disabled { border-style: dashed; }
.cli-ext-unknown { border-style: dashed; color: var(--warning-fg, var(--text-primary)); border-color: var(--attention-muted); }
.cli-ext-cap { border-color: var(--border-muted); }
.cli-ext-feature-link { font: inherit; font-weight: 600; background: none; border: none; padding: 0; cursor: pointer; text-align: left; text-decoration: underline; }
.cli-ext-inferred { border-style: dashed; }
.cli-ext-consent { margin: 0; font-size: var(--font-2xs); color: var(--text-secondary); }
.cli-ext-detail, .cli-ext-path { display: block; min-width: 0; padding: 3px 6px; border-radius: var(--radius-xs); background: var(--bg-inset); font-size: 10.5px; color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
