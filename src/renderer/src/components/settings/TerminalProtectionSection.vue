<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { useBackend } from '../../composables/useBackend'
import {
  patternProblem,
  useTerminalProtection,
  type TerminalPattern,
  type TerminalRefusal,
} from '../../composables/useTerminalProtection'
import SettingsSection from './SettingsSection.vue'
import SettingsCard from './SettingsCard.vue'
import ToggleSwitch from './ToggleSwitch.vue'

/**
 * Settings → Security → Terminal command protection: which commands Navide
 * refuses to type into a plain terminal pane (backend guard/terminal_policy).
 * Built-in categories with a switch each, the user's block patterns and allow
 * prefixes, and a box that runs the exact check enforcement runs. Loosening
 * asks the main process for a confirmation (see useTerminalProtection).
 */
const props = defineProps<{
  backend: Pick<ReturnType<typeof useBackend>, 'send'>
}>()

const { t, te } = useI18n()
const store = useTerminalProtection(props.backend)
const busy = ref(false)

onMounted(() => {
  void store.refresh()
})

async function run(op: () => Promise<{ ok: boolean }>): Promise<boolean> {
  busy.value = true
  try {
    return (await op()).ok
  } finally {
    busy.value = false
  }
}

function categoryTitle(id: string, fallback: string): string {
  const key = `guard.terminal.category.${id}`
  return te(key) ? t(key) : fallback
}

const blocks = computed(() => store.patterns.value.filter((p) => p.kind === 'block'))
const allows = computed(() => store.patterns.value.filter((p) => p.kind === 'allow'))

// ── add pattern ──────────────────────────────────────────────────────────────
const blockInput = ref('')
const allowInput = ref('')
const blockProblem = computed(() => (blockInput.value ? patternProblem(blockInput.value) : null))
const allowProblem = computed(() => (allowInput.value ? patternProblem(allowInput.value) : null))

async function add(kind: 'block' | 'allow'): Promise<void> {
  const input = kind === 'block' ? blockInput : allowInput
  if (!input.value.trim() || patternProblem(input.value)) return
  if (await run(() => store.addPattern(kind, input.value))) input.value = ''
}

async function remove(p: TerminalPattern): Promise<void> {
  await run(() => store.removePattern(p))
}

// ── test a command ───────────────────────────────────────────────────────────
const testInput = ref('')
const testResult = ref<{ refused: boolean; refusal: TerminalRefusal | null } | null>(null)
const testError = ref('')

async function runTest(): Promise<void> {
  const command = testInput.value.trim()
  if (!command) return
  busy.value = true
  const res = await store.test(command)
  busy.value = false
  testResult.value = res.ok && res.data ? res.data : null
  testError.value = res.ok ? '' : (res.error ?? t('guard.error.generic'))
}

function ruleLabel(rule: string): string {
  if (rule === 'block-pattern') return t('guard.terminal.rule.block-pattern')
  const cat = store.categories.value.find((c) => c.id === rule)
  return categoryTitle(rule, cat?.description ?? rule)
}
</script>

<template>
  <SettingsSection :label="t('guard.terminal.title')" data-testid="terminal-protection">
    <p class="tp-hint">{{ t('guard.terminal.hint') }}</p>
    <details class="tp-more">
      <summary>{{ t('guard.terminal.more') }}</summary>
      <p>{{ t('guard.terminal.hint-detail') }}</p>
    </details>
    <p v-if="store.error.value" class="tp-error" role="alert" data-testid="terminal-protection-error">{{ store.error.value }}</p>

    <SettingsCard>
      <div
        v-for="c in store.categories.value"
        :key="c.id"
        class="tp-item"
        data-testid="terminal-category-row"
        :data-category="c.id"
      >
        <div class="tp-item-text">
          <span class="tp-item-name">{{ categoryTitle(c.id, c.description) }}</span>
          <code class="tp-code">{{ c.example }}</code>
          <span v-if="!c.default_enabled" class="tp-item-meta">{{ t('guard.terminal.default-off') }}</span>
        </div>
        <ToggleSwitch
          :model-value="c.enabled"
          :disabled="busy"
          :aria-label="categoryTitle(c.id, c.description)"
          data-testid="terminal-category-toggle"
          @update:model-value="(v: boolean) => run(() => store.setCategory(c.id, v))"
        />
      </div>
      <p class="tp-hint tp-inset">{{ t('guard.terminal.loosen-confirm') }}</p>
    </SettingsCard>

    <!-- Block patterns, allow exceptions and the tester belong to this
         section; the rule on the left keeps them from reading as new ones. -->
    <div class="tp-group">
    <h4 class="tp-sub">{{ t('guard.terminal.block.title') }}</h4>
    <p class="tp-hint">{{ t('guard.terminal.block.hint') }}</p>
    <SettingsCard>
      <div v-for="p in blocks" :key="p.id" class="tp-item" data-testid="terminal-block-row">
        <code class="tp-code grow">{{ p.pattern }}</code>
        <button type="button" class="tp-btn ghost sm" :disabled="busy" data-testid="terminal-block-remove" @click="remove(p)">{{ t('guard.rules.remove') }}</button>
      </div>
      <form class="tp-form" @submit.prevent="add('block')">
        <input v-model="blockInput" class="tp-input grow mono" name="block-pattern" autocomplete="off" spellcheck="false" :placeholder="t('guard.terminal.block.placeholder')" data-testid="terminal-block-input" />
        <button type="submit" class="tp-btn primary sm" :disabled="busy || !blockInput.trim() || !!blockProblem" data-testid="terminal-block-add">{{ t('guard.rules.add') }}</button>
      </form>
      <p v-if="blockProblem" class="tp-error tp-inset" role="alert" data-testid="terminal-block-problem">{{ t(`guard.terminal.problem.${blockProblem}`) }}</p>
    </SettingsCard>

    <h4 class="tp-sub">{{ t('guard.terminal.allow.title') }}</h4>
    <p class="tp-warning" role="note" data-testid="terminal-allow-warning">{{ t('guard.terminal.allow.warning') }}</p>
    <SettingsCard>
      <div v-for="p in allows" :key="p.id" class="tp-item" data-testid="terminal-allow-row">
        <code class="tp-code grow">{{ p.pattern }}</code>
        <button type="button" class="tp-btn ghost sm" :disabled="busy" data-testid="terminal-allow-remove" @click="remove(p)">{{ t('guard.rules.remove') }}</button>
      </div>
      <form class="tp-form" @submit.prevent="add('allow')">
        <input v-model="allowInput" class="tp-input grow mono" name="allow-prefix" autocomplete="off" spellcheck="false" :placeholder="t('guard.terminal.allow.placeholder')" data-testid="terminal-allow-input" />
        <button type="submit" class="tp-btn primary sm" :disabled="busy || !allowInput.trim() || !!allowProblem" data-testid="terminal-allow-add">{{ t('guard.rules.add') }}</button>
      </form>
      <p v-if="allowProblem" class="tp-error tp-inset" role="alert" data-testid="terminal-allow-problem">{{ t(`guard.terminal.problem.${allowProblem}`) }}</p>
    </SettingsCard>

    <h4 class="tp-sub">{{ t('guard.terminal.test.title') }}</h4>
    <SettingsCard>
      <form class="tp-form" @submit.prevent="runTest">
        <input v-model="testInput" class="tp-input grow mono" name="terminal-test" autocomplete="off" spellcheck="false" :placeholder="t('guard.terminal.test.placeholder')" data-testid="terminal-test-input" />
        <button type="submit" class="tp-btn primary sm" :disabled="busy || !testInput.trim()" data-testid="terminal-test-run">{{ t('guard.test.run') }}</button>
      </form>
      <div v-if="testResult" class="tp-result" data-testid="terminal-test-result">
        <template v-if="testResult.refused && testResult.refusal">
          <span class="tp-pill bad">{{ t('guard.terminal.test.refused') }}</span>
          <span class="tp-item-meta">{{ ruleLabel(testResult.refusal.rule) }} · <code class="tp-code">{{ testResult.refusal.segment }}</code> — {{ testResult.refusal.reason }}</span>
        </template>
        <span v-else class="tp-pill ok">{{ t('guard.terminal.test.allowed') }}</span>
      </div>
      <p v-if="testError" class="tp-error tp-inset" role="alert">{{ testError }}</p>
    </SettingsCard>
    </div>
  </SettingsSection>
</template>

<style scoped>
.tp-hint { margin: 0 0 8px; font-size: var(--font-row-desc); color: var(--text-secondary); line-height: 1.5; text-wrap: pretty; word-break: auto-phrase; }
.tp-warning {
  margin: 0 0 8px; padding: 6px 10px; font-size: var(--font-row-desc); line-height: 1.5;
  color: var(--text-primary); background: var(--attention-subtle); border-left: 3px solid var(--attention-fg);
  border-radius: var(--radius-sm); text-wrap: pretty; word-break: auto-phrase;
}
.tp-error { margin: 8px 0 0; font-size: var(--font-2xs); color: var(--danger-fg); overflow-wrap: anywhere; }
.tp-inset { margin: 0; padding: 0 var(--space-row-x) 8px; }
/* Indented under its section with a thin rule, so the sub-blocks read as part of it. */
.tp-group { margin: 4px 0 8px; padding-left: 12px; border-left: 2px solid var(--border-muted); }
.tp-group > .tp-sub:first-child { margin-top: 10px; }
/* Edge cases fold away under the one-sentence summary. */
.tp-more { margin: -4px 0 8px; font-size: var(--font-row-desc); color: var(--text-secondary); line-height: 1.5; }
.tp-more summary { width: fit-content; cursor: pointer; color: var(--accent-fg); }
.tp-more p { margin: 4px 0 0; max-width: 72ch; text-wrap: pretty; word-break: auto-phrase; }
.tp-sub { margin: 14px 0 4px; font-size: var(--font-xs); font-weight: 600; color: var(--text-primary); }
.tp-item { display: flex; align-items: center; gap: 10px; padding: 8px var(--space-row-x); }
.tp-item + .tp-item { border-top: 1px solid var(--border-muted); }
.tp-item-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.tp-item-name { font-size: var(--font-xs); font-weight: 600; color: var(--text-primary); }
.tp-item-meta { font-size: var(--font-2xs); color: var(--text-secondary); overflow-wrap: anywhere; }
.tp-code { font-family: var(--font-mono, monospace); font-size: var(--font-2xs); color: var(--text-bright); word-break: break-all; }
.tp-code.grow { flex: 1; min-width: 0; }
.tp-form { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 8px var(--space-row-x); }
.tp-input {
  background: var(--bg-base); border: 1px solid var(--border-default); border-radius: var(--radius-sm);
  color: var(--text-primary); font-size: var(--font-xs); padding: 4px 8px;
}
.tp-input.grow { flex: 1; min-width: 160px; }
.tp-input.mono { font-family: var(--font-mono, monospace); }
.tp-input:focus { outline: none; border-color: var(--accent-focus); }
.tp-result { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 0 var(--space-row-x) 10px; }
.tp-pill {
  flex-shrink: 0; font-size: var(--font-2xs); font-weight: 600; border-radius: 999px; padding: 1px 8px;
  border: 1px solid var(--border-default); white-space: nowrap;
}
.tp-pill.ok { color: var(--success-fg); background: var(--success-subtle); border-color: var(--success-muted); }
.tp-pill.bad { color: var(--danger-fg); background: var(--danger-subtle); border-color: var(--danger-muted); }
.tp-btn {
  border-radius: 5px; font-size: var(--font-xs); padding: 5px 10px; cursor: pointer;
  border: 1px solid var(--border-default); background: transparent; color: var(--text-primary); white-space: nowrap;
}
.tp-btn.sm { font-size: var(--font-2xs); padding: 3px 8px; }
.tp-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.tp-btn.primary:disabled { opacity: 1; background: transparent; border-color: var(--border-default); color: var(--text-secondary); }
.tp-btn.primary { background: var(--accent-emphasis); border-color: var(--accent-emphasis); color: var(--text-on-emphasis); }
.tp-btn.ghost { color: var(--text-secondary); }
</style>
