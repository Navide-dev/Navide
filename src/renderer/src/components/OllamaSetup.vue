<script setup lang="ts">
import { computed, defineAsyncComponent, onUnmounted, ref, watch } from 'vue'
import type { useBackend } from '../composables/useBackend'
import type { useOnboarding } from '../composables/useOnboarding'
import InstallTerminal from './InstallTerminal.vue'

const CliInstallDialog = defineAsyncComponent(() => import('./CliInstallDialog.vue'))

/**
 * Getting Ollama to a usable state: install it, start its service, pull a first
 * model. This used to be the Analyzer part of the first-run wizard's Agents
 * step; it lives in Settings → Analyzer now, next to the connection status, so
 * a first run is not asked for a multi-GB download it may never need.
 *
 * Renders nothing once Ollama answers and has a model: the model manager below
 * it takes over from there.
 */
const props = defineProps<{
  backend: ReturnType<typeof useBackend>
  /** The owner's onboarding instance, shared with CLI management. */
  onboarding: ReturnType<typeof useOnboarding>
}>()
const emit = defineEmits<{
  /** Ollama was installed, started or given a model: re-read its health. */
  changed: []
  /** The guided install dialog opened or closed, so the owner can hold Esc. */
  'install-open-change': [open: boolean]
}>()

const ob = props.onboarding

const ollamaDep = computed(() => ob.analyzerDeps.value.find((d) => d.id === 'ollama'))
const missing = computed(() => !!ollamaDep.value && ollamaDep.value.status !== 'ok')
const busy = computed(() => !!ob.installing.value || ob.runBusy.value)
const detectBusy = computed(() => ob.loading.value || busy.value)

/** ollama installed but its daemon is down — pulling a model cannot work. */
const stopped = computed(() => ollamaDep.value?.status === 'ok' && !ob.ollamaServiceUp.value)
const needsModel = computed(() => ollamaDep.value?.status === 'ok' && ob.ollamaServiceUp.value && ob.models.value.length === 0)

/** The last "Start Ollama" press failed; the detail is in the log. */
const ollamaStartFailed = ref(false)

async function startOllama(): Promise<void> {
  ollamaStartFailed.value = false
  const result = await ob.startOllamaService()
  ollamaStartFailed.value = !result?.ok
  if (result?.ok) emit('changed')
}

/** The same guided install the spawn dropdown uses: Homebrew first if needed. */
const installOpen = ref(false)
watch(installOpen, (open) => emit('install-open-change', open))
onUnmounted(() => emit('install-open-change', false))

function closeInstall(): void {
  installOpen.value = false
  void ob.refresh({ fresh: true })
  emit('changed')
}

// ── Model picker ──────────────────────────────────────────────────────────────
const selectedModel = ref('')
const customModel = ref('')
const pullTarget = computed(() => customModel.value.trim() || selectedModel.value)

function isInstalled(name: string): boolean {
  return ob.models.value.includes(name)
}

function pickModel(name: string): void {
  selectedModel.value = name
  customModel.value = ''
}

// Default selection follows the recommended catalog entry once it arrives.
watch(
  ob.modelCatalog,
  (cat) => {
    if (!selectedModel.value && !customModel.value && cat.length) {
      selectedModel.value = (cat.find((m) => m.recommended) ?? cat[0]).name
    }
  },
  { immediate: true },
)

async function pull(): Promise<void> {
  const result = await ob.pullModel(pullTarget.value)
  if (result?.ok) emit('changed')
}
</script>

<template>
  <div v-if="missing || stopped || needsModel || ob.run.value || ob.runFallback.value" class="os" data-testid="ollama-setup">
    <div v-if="missing" class="os-row" data-testid="ollama-setup-missing">
      <span class="os-text">{{ $t('settings.analyzer.ollama-missing') }}</span>
      <button class="nv-btn nv-btn--primary" :disabled="busy" @click="installOpen = true">
        {{ $t('settings.analyzer.install-ollama') }}
      </button>
    </div>

    <div v-else-if="stopped" class="os-row" data-testid="ollama-setup-stopped">
      <span class="os-text">{{ $t('onboard.ollama-stopped') }}</span>
      <button class="nv-btn nv-btn--primary" :disabled="busy" @click="startOllama">
        {{ $t('action.start-ollama') }}
      </button>
      <button class="nv-btn" :disabled="detectBusy" @click="ob.refresh({ fresh: true })">
        {{ ob.loading.value ? $t('label.detecting') : $t('action.re-detect') }}
      </button>
      <p v-if="ollamaStartFailed" class="os-error" role="alert">{{ $t('onboard.ollama-start-failed') }}</p>
    </div>

    <div v-else-if="needsModel" class="os-model" data-testid="ollama-setup-model">
      <div class="os-model-title">{{ $t('label.analysis-model') }}</div>
      <p class="os-text">{{ $t('hint.download-model') }}</p>
      <div class="ob-models">
        <div class="ob-installed">
          <span class="ob-chip empty">{{ $t('label.no-models-installed') }}</span>
        </div>

        <div class="ob-model-grid">
          <button
            v-for="m in ob.modelCatalog.value"
            :key="m.name"
            type="button"
            class="ob-model-card"
            :class="{ selected: selectedModel === m.name }"
            @click="pickModel(m.name)"
          >
            <span class="ob-model-radio" />
            <span class="ob-model-info">
              <span class="ob-model-name">
                {{ m.name }}
                <span v-if="m.recommended" class="ob-tag rec">{{ $t('label.recommended') }}</span>
                <span v-if="isInstalled(m.name)" class="ob-tag inst">{{ $t('label.installed') }}</span>
              </span>
              <span class="ob-model-desc">{{ m.desc }}</span>
            </span>
            <span class="ob-model-size">{{ m.size }}</span>
          </button>
        </div>

        <label class="ob-model-custom">
          <span class="ob-model-custom-label">{{ $t('label.other-model') }}</span>
          <input
            v-model="customModel"
            class="ob-input"
            :placeholder="$t('onboard.custom-model-placeholder')"
            spellcheck="false"
          />
        </label>
      </div>
      <div class="os-row">
        <button
          class="nv-btn nv-btn--primary"
          :disabled="!pullTarget || !!ob.pulling.value || busy"
          @click="pull"
        >
          {{
            ob.pulling.value
              ? $t('onboard.downloading', { name: ob.pulling.value })
              : $t('action.download-model', { name: pullTarget || $t('label.model') })
          }}
        </button>
        <button class="nv-btn" :disabled="detectBusy" @click="ob.refresh({ fresh: true })">
          {{ ob.loading.value ? $t('label.detecting') : $t('action.re-detect') }}
        </button>
      </div>
    </div>

    <InstallTerminal v-if="ob.run.value || ob.runFallback.value" class="os-terminal" :onboarding="ob" />

    <CliInstallDialog
      v-if="installOpen"
      :backend="backend"
      dep-id="ollama"
      origin="settings"
      fallback-label="Ollama"
      @close="closeInstall"
    />
  </div>
</template>

<style scoped>
.os {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 10px;
}
.os-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.os-text {
  margin: 0;
  font-size: var(--font-xs);
  color: var(--text-secondary);
}
.os-error {
  flex-basis: 100%;
  margin: 0;
  font-size: var(--font-xs);
  color: var(--danger-fg);
}
.os-model-title {
  font-weight: 600;
}
.os-terminal {
  margin-top: 4px;
}

/* ── Model picker ───────────────────────────────────────────────────────────── */
.ob-models {
  flex-basis: 100%;
  margin-bottom: 4px;
}
.ob-installed {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 12px;
}
.ob-chip {
  font: 11px/1 ui-monospace, Menlo, monospace;
  padding: 4px 8px;
  border-radius: 999px;
  border: 1px solid var(--border-muted);
  background: var(--bg-base);
  color: var(--text-secondary);
}
.ob-chip.ok {
  color: var(--success-fg);
  border-color: color-mix(in srgb, var(--success-fg) 35%, transparent);
}
.ob-chip.empty {
  color: var(--text-muted);
  font-family: inherit;
}
.ob-model-grid {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.ob-model-card {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  text-align: left;
  padding: 9px 12px;
  border: 1px solid var(--border-muted);
  border-radius: 8px;
  background: var(--bg-base);
  cursor: pointer;
  transition:
    border-color 0.12s,
    background 0.12s;
}
.ob-model-card:hover {
  border-color: var(--border-default);
  background: var(--bg-muted);
}
.ob-model-card.selected {
  border-color: var(--accent-emphasis);
  background: color-mix(in srgb, var(--accent-emphasis) 8%, var(--bg-base));
}
.ob-model-radio {
  flex: none;
  width: 15px;
  height: 15px;
  border-radius: 50%;
  border: 2px solid var(--border-default);
  position: relative;
}
.ob-model-card.selected .ob-model-radio {
  border-color: var(--accent-emphasis);
}
.ob-model-card.selected .ob-model-radio::after {
  content: '';
  position: absolute;
  inset: 2px;
  border-radius: 50%;
  background: var(--accent-emphasis);
}
.ob-model-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.ob-model-name {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  font: 12px/1.3 ui-monospace, Menlo, monospace;
  color: var(--text-bright);
}
.ob-model-desc {
  font-size: var(--font-2xs);
  color: var(--text-muted);
}
.ob-model-size {
  flex: none;
  font: 11px/1 ui-monospace, Menlo, monospace;
  color: var(--text-secondary);
  padding: 3px 7px;
  border-radius: 5px;
  background: var(--bg-muted);
}
.ob-tag {
  font-size: 9.5px;
  font-weight: 700;
  letter-spacing: 0.02em;
  padding: 1px 6px;
  border-radius: 999px;
  line-height: var(--lh-base);
}
.ob-tag.rec {
  color: var(--accent-fg);
  background: color-mix(in srgb, var(--accent-fg) 14%, transparent);
}
.ob-tag.inst {
  color: var(--success-fg);
  background: color-mix(in srgb, var(--success-fg) 14%, transparent);
}
.ob-model-custom {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
}
.ob-model-custom-label {
  flex: none;
  font-size: var(--font-2xs);
  color: var(--text-secondary);
}
.ob-input {
  flex: 1;
  min-width: 0;
  font: 11px/1 ui-monospace, Menlo, monospace;
  padding: 7px 10px;
  border: 1px solid var(--border-default);
  border-radius: 6px;
  background: var(--bg-base);
  color: var(--text-bright);
}
.ob-input:focus {
  outline: none;
  border-color: var(--accent-emphasis);
}
.ob-input::placeholder {
  color: var(--text-muted);
}
</style>
