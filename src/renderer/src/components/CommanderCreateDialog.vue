<script setup lang="ts">
// Create a commander, or upgrade an existing pane into one (0.2.51). Both are
// the user's to do in the main window; the backend refuses them from anywhere
// else. Upgrading keeps the pane running and moves its chat binding and
// schedules to the commander (reversible from the detail page).
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useCommanders } from '../composables/useCommanders'
import { useDialogFocus } from '../composables/useDialogFocus'

export interface CommanderCreatePane {
  id: string
  name: string
  agentKey: string
  workspacePath: string
}

const props = defineProps<{
  agentSpecs: { agentKey: string; label: string }[]
  panes: CommanderCreatePane[]
  defaultWorkspace: string
}>()

const { t } = useI18n()
const store = useCommanders()

const ICONS = ['◎', '☁', '◈', '▶', '★', '⚙', '✎', '⚑']
const COLORS = ['#7c5cd6', '#d9822b', '#3f9e8a', '#d6456a', '#3b82f6', '#64748b']

const name = ref('')
const icon = ref(ICONS[0])
const color = ref(COLORS[0])
const duty = ref('')
const workspace = ref('')
const agentKey = ref('')
const model = ref('')
const stall = ref(20)
const paneId = ref('')
const nameError = ref(false)
const root = ref<HTMLElement | null>(null)
const nameInput = ref<HTMLInputElement | null>(null)

const open = computed(() => store.createOpen.value)
/** Panes already serving as a commander's body cannot be upgraded again. */
const upgradable = computed(() => props.panes.filter((p) => !store.bodyPanes.value.has(p.id)))
const pane = computed(() => upgradable.value.find((p) => p.id === paneId.value) ?? null)

watch(open, (v) => {
  if (!v) return
  paneId.value = store.createPaneId.value
  const p = pane.value
  name.value = p?.name ?? ''
  icon.value = ICONS[0]
  color.value = COLORS[0]
  duty.value = ''
  workspace.value = p?.workspacePath || props.defaultWorkspace
  agentKey.value = p?.agentKey || props.agentSpecs[0]?.agentKey || 'claude'
  model.value = ''
  stall.value = 20
  nameError.value = false
}, { immediate: true })

// Picking a pane takes its CLI and workspace: the commander's body is that pane.
watch(paneId, () => {
  const p = pane.value
  if (!p) return
  agentKey.value = p.agentKey
  workspace.value = p.workspacePath || workspace.value
  if (!name.value.trim()) name.value = p.name
})

useDialogFocus(root, () => nameInput.value)

function close(): void {
  store.createOpen.value = false
}

async function submit(): Promise<void> {
  if (!name.value.trim()) {
    nameError.value = true
    nameInput.value?.focus()
    return
  }
  const fields = {
    name: name.value.trim(),
    icon: icon.value,
    color: color.value,
    duty: duty.value.trim(),
    workspaces: workspace.value ? [workspace.value] : [],
    agent_key: agentKey.value,
    model: model.value.trim(),
    stall_minutes: Math.max(1, Number(stall.value) || 20),
  }
  const made = pane.value ? await store.upgradePane(pane.value.id, fields) : await store.create(fields)
  if (!made) return
  close()
  store.openDetail(made.id)
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.preventDefault()
    close()
  }
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="ccd-backdrop" @mousedown.self="close">
      <div
        ref="root"
        class="ccd"
        role="dialog"
        aria-modal="true"
        :aria-label="pane ? t('commander.create.upgrade-title') : t('commander.create.title')"
        data-testid="commander-create"
        @keydown="onKeydown"
      >
        <h2 class="ccd-title">{{ pane ? t('commander.create.upgrade-title') : t('commander.create.title') }}</h2>
        <form class="ccd-form" @submit.prevent="submit">
          <label class="ccd-field">
            <span>{{ t('commander.create.pane') }}</span>
            <select v-model="paneId" data-testid="commander-create-pane">
              <option value="">{{ t('commander.create.pane-none') }}</option>
              <option v-for="p in upgradable" :key="p.id" :value="p.id">{{ p.name }}</option>
            </select>
          </label>
          <p v-if="pane" class="ccd-note">{{ t('commander.create.upgrade-note') }}</p>
          <label class="ccd-field">
            <span>{{ t('commander.create.name') }}</span>
            <input
              ref="nameInput"
              v-model="name"
              data-testid="commander-create-name"
              :placeholder="t('commander.create.name-placeholder')"
              :aria-invalid="nameError"
              @input="nameError = false"
            />
            <em v-if="nameError" class="ccd-err">{{ t('commander.create.name-required') }}</em>
          </label>
          <div class="ccd-field">
            <span>{{ t('commander.create.icon') }}</span>
            <div class="ccd-swatches">
              <button v-for="i in ICONS" :key="i" type="button" class="ccd-icon" :class="{ on: icon === i }" :style="{ background: color }" :aria-pressed="icon === i" @click="icon = i">{{ i }}</button>
            </div>
          </div>
          <div class="ccd-field">
            <span>{{ t('commander.create.color') }}</span>
            <div class="ccd-swatches">
              <button v-for="c in COLORS" :key="c" type="button" class="ccd-color" :class="{ on: color === c }" :style="{ background: c }" :aria-label="c" :aria-pressed="color === c" @click="color = c"></button>
            </div>
          </div>
          <label class="ccd-field">
            <span>{{ t('commander.create.duty') }}</span>
            <textarea v-model="duty" rows="3" :placeholder="t('commander.detail.duty-placeholder')"></textarea>
          </label>
          <label class="ccd-field">
            <span>{{ t('commander.create.workspace') }}</span>
            <input v-model="workspace" :disabled="!!pane" />
          </label>
          <div class="ccd-two">
            <label class="ccd-field">
              <span>{{ t('commander.create.cli') }}</span>
              <select v-model="agentKey" :disabled="!!pane">
                <option v-for="s in agentSpecs" :key="s.agentKey" :value="s.agentKey">{{ s.label }}</option>
              </select>
            </label>
            <label class="ccd-field">
              <span>{{ t('commander.create.model') }}</span>
              <input v-model="model" :placeholder="t('commander.create.model-placeholder')" />
            </label>
          </div>
          <label class="ccd-field ccd-field--narrow">
            <span>{{ t('commander.create.stall') }}</span>
            <input v-model.number="stall" type="number" min="1" />
          </label>
          <p v-if="store.opError.value" class="ccd-err">{{ store.opError.value }}</p>
          <div class="ccd-actions">
            <button type="button" class="ccd-btn" @click="close">{{ t('commander.create.cancel') }}</button>
            <button type="submit" class="ccd-btn ccd-btn--primary" data-testid="commander-create-submit" :disabled="store.busy.value">
              {{ pane ? t('commander.create.submit-upgrade') : t('commander.create.submit-create') }}
            </button>
          </div>
        </form>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.ccd-backdrop { position: fixed; inset: 0; z-index: calc(var(--z-modal) + 130); background: color-mix(in srgb, var(--bg-base) 55%, transparent); display: flex; align-items: center; justify-content: center; -webkit-app-region: no-drag; }
.ccd { width: min(520px, calc(100vw - 48px)); max-height: calc(100vh - 80px); overflow: auto; background: var(--bg-subtle); border: 1px solid var(--border-default); border-radius: var(--radius-md); box-shadow: var(--shadow-overlay); padding: 18px 20px; font-family: var(--font-ui); color: var(--text-primary); }
.ccd-title { margin: 0 0 14px; font-size: var(--font-md); color: var(--text-bright); }
.ccd-form { display: flex; flex-direction: column; gap: 12px; }
.ccd-field { display: flex; flex-direction: column; gap: 6px; font-size: var(--font-xs); color: var(--text-secondary); min-width: 0; }
.ccd-field--narrow { max-width: 220px; }
.ccd-field input, .ccd-field select, .ccd-field textarea { background: var(--bg-base); color: var(--text-primary); border: 1px solid var(--border-default); border-radius: var(--radius-sm); padding: 6px 8px; font: inherit; font-size: var(--font-xs); }
.ccd-field input[aria-invalid="true"] { border-color: var(--danger-fg); }
.ccd-two { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.ccd-swatches { display: flex; flex-wrap: wrap; gap: 6px; }
.ccd-icon { width: 28px; height: 28px; border-radius: var(--radius-sm); border: 2px solid transparent; color: var(--text-on-emphasis); cursor: pointer; opacity: 0.6; }
.ccd-icon.on { opacity: 1; border-color: var(--text-bright); }
.ccd-color { width: 22px; height: 22px; border-radius: 50%; border: 2px solid transparent; cursor: pointer; }
.ccd-color.on { border-color: var(--text-bright); }
.ccd-note { margin: -4px 0 0; font-size: var(--font-2xs); color: var(--text-secondary); line-height: var(--lh-base); }
.ccd-err { color: var(--danger-fg); font-size: var(--font-2xs); font-style: normal; margin: 0; }
.ccd-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px; }
.ccd-btn { background: var(--bg-base); color: var(--text-primary); border: 1px solid var(--border-default); border-radius: var(--radius-sm); padding: 6px 14px; font-size: var(--font-xs); cursor: pointer; }
.ccd-btn--primary { background: var(--accent-emphasis); border-color: var(--accent-emphasis); color: var(--text-on-emphasis); }
.ccd-btn:disabled { opacity: 0.5; cursor: default; }
</style>
