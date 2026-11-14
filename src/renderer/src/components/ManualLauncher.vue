<script setup lang="ts">
import { useId } from 'vue'
import { formatKeySpec, settingsKeySpec } from '@navide/plugin-ui/shared'
import type { AgentSpec } from './ControlPane.vue'
import type { Role, RoleKey } from '../data/roles'
import type { BackendStatus } from '../composables/useBackend'
import { roleDisplayOneLine } from '../lib/builtinNames'

const props = defineProps<{
  /** Whether the spawn card is expanded. */
  open: boolean
  pickedAgent: string
  pickedRole: RoleKey
  resumeSessionId: string
  previewOpen: boolean
  backendStatus: BackendStatus
  manualAgentSpecs: AgentSpec[]
  roles: Role[]
  resumeOptions: { sessionId: string; label: string; workspacePath: string }[]
  canSpawn: boolean
  canResume: boolean
  resumeNotice: string
  currentRole?: Role
}>()

const emit = defineEmits<{
  (e: 'update:open', v: boolean): void
  (e: 'update:pickedAgent', v: string): void
  (e: 'update:pickedRole', v: RoleKey): void
  (e: 'update:resumeSessionId', v: string): void
  (e: 'update:previewOpen', v: boolean): void
  (e: 'spawn'): void
  (e: 'open-terminal'): void
  (e: 'resume-agent'): void
  (e: 'open-settings'): void
}>()

// Unique datalist id per component instance — avoids duplicate IDs when two
// ManualLauncher instances are mounted simultaneously (e.g. explorer + pipeline).
const datalistId = useId()
</script>

<template>
  <div class="spawn-card">
    <div class="spawn-card-hdr" @click="emit('update:open', !open)">
      <span class="spawn-caret">{{ open ? '▾' : '▸' }}</span>
      <span>{{ $t('label.manual-spawn') }}</span>
    </div>
    <div v-if="open" class="spawn-card-body">
      <div class="row two-col">
        <select :value="pickedAgent" @change="emit('update:pickedAgent', ($event.target as HTMLSelectElement).value)">
          <option v-for="spec in manualAgentSpecs" :key="spec.agentKey" :value="spec.agentKey">
            {{ spec.label }}
          </option>
        </select>
        <select :value="pickedRole" @change="emit('update:pickedRole', ($event.target as HTMLSelectElement).value as RoleKey)">
          <option value="">{{ $t('label.select-role') }}</option>
          <option v-for="r in roles" :key="r.key" :value="r.key">{{ r.label }}</option>
        </select>
      </div>
      <div class="row spawn-actions">
        <button class="primary wide" :disabled="!canSpawn" @click="emit('spawn')">{{ $t('action.add-to-grid') }}</button>
        <button class="ghost wide terminal-btn" :disabled="!canSpawn" @click="emit('open-terminal')">{{ $t('action.open-terminal') }}</button>
      </div>
      <div class="row resume-actions">
        <input
          :value="resumeSessionId"
          class="resume-input"
          :list="datalistId"
          :placeholder="$t('label.resume-session-id')"
          :disabled="!canSpawn"
          @input="emit('update:resumeSessionId', ($event.target as HTMLInputElement).value)"
        />
        <datalist :id="datalistId">
          <option v-for="opt in resumeOptions" :key="opt.sessionId" :value="opt.sessionId">
            {{ opt.label }}
          </option>
        </datalist>
        <button class="ghost resume-btn" :disabled="!canResume" @click="emit('resume-agent')">
          {{ $t('action.resume-agent') }}
        </button>
      </div>
      <p v-if="resumeNotice" class="hint warn">{{ resumeNotice }}</p>
      <p v-if="!canSpawn" class="hint warn">
        {{ backendStatus !== 'connected' ? $t('label.waiting-backend') : $t('label.set-workspace-first') }}
      </p>

      <div v-if="currentRole" class="prompt-block">
        <div class="prompt-head">
          <button class="link" @click="emit('update:previewOpen', !previewOpen)">
            {{ previewOpen ? '▾' : '▸' }} {{ $t('label.role-system-prompt', { role: currentRole.label }) }}
          </button>
          <button class="link tiny" @click="emit('open-settings')" :title="`${$t('action.settings')} (${formatKeySpec(settingsKeySpec())})`">
            ⚙ {{ $t('action.settings') }}
          </button>
        </div>
        <p class="role-line">{{ roleDisplayOneLine(currentRole) }}</p>
        <pre v-if="previewOpen" class="prompt-preview">{{ currentRole.system_prompt }}</pre>
      </div>
      <div v-else class="prompt-block warn-block">
        <p class="warn">
          {{ roles.length === 0 ? $t('label.no-roles-available') : $t('label.no-role-selected') }}
        </p>
        <div v-if="roles.length === 0" class="row tight">
          <button class="ghost" @click="emit('open-settings')">⚙ {{ $t('action.settings') }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* ── Base styles (needed because this is a scoped child component) ── */
button {
  border: 1px solid var(--border-default);
  background: var(--bg-muted);
  color: var(--text-bright);
  font-size: var(--font-xs);
  padding: 6px 10px;
  border-radius: 4px;
  cursor: pointer;
}
button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
button.wide {
  flex: 1;
}
button.primary {
  background: var(--success-emphasis);
  border-color: var(--success-strong);
  color: var(--text-on-emphasis);
  font-weight: 600;
}
button.primary:not(:disabled):hover {
  background: var(--success-strong);
}
button.ghost {
  background: transparent;
}
button.ghost:hover:not(:disabled) {
  background: var(--bg-muted);
}
button.link {
  background: transparent;
  border: none;
  color: var(--accent-fg);
  font-size: var(--font-2xs);
  padding: 2px 4px;
  text-align: left;
}
select {
  background: var(--bg-subtle);
  border: 1px solid var(--border-default);
  color: var(--text-bright);
  padding: 6px 8px;
  border-radius: 4px;
  font-family: inherit;
  font-size: var(--font-xs);
  box-sizing: border-box;
  width: 100%;
}
select:focus {
  outline: none;
  border-color: var(--accent-emphasis);
}
input {
  background: var(--bg-subtle);
  border: 1px solid var(--border-default);
  color: var(--text-bright);
  padding: 6px 8px;
  border-radius: 4px;
  font-family: inherit;
  font-size: var(--font-xs);
  box-sizing: border-box;
  width: 100%;
}
input:focus {
  outline: none;
  border-color: var(--accent-emphasis);
}
.row {
  display: flex;
  gap: 6px;
  align-items: center;
}
.row.two-col {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
}
.row.tight {
  gap: 4px;
  margin-top: 4px;
}
.hint {
  color: var(--text-secondary);
  font-size: var(--font-3xs);
  margin: 0;
  line-height: var(--lh-base);
}
.hint.warn {
  color: var(--attention-fg);
}
.muted-inline {
  color: var(--text-muted);
  font-size: var(--font-3xs);
}

/* ── Spawn card ── */
.spawn-actions {
  flex-direction: column;
  gap: 4px;
  align-items: stretch;
}
.terminal-btn {
  opacity: 0.6;
  border-style: dashed;
  transition: opacity 0.2s, background 0.2s;
}
.terminal-btn:hover:not(:disabled) {
  opacity: 1;
}
.resume-actions {
  gap: 4px;
  align-items: stretch;
}
.resume-input {
  flex: 1;
  min-width: 0;
  font-size: var(--font-2xs);
  padding: 4px 6px;
  background: var(--bg-muted);
  color: var(--text-bright);
  border: 1px solid var(--border-default);
  border-radius: 4px;
}
.resume-btn {
  flex-shrink: 0;
}
.spawn-card {
  border: 1px solid var(--border-muted);
  border-radius: 6px;
  overflow: hidden;
  margin-top: 6px;
}
.spawn-card-hdr {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  min-height: 28px;
  background: var(--bg-subtle);
  cursor: pointer;
  user-select: none;
  font-size: var(--font-2xs);
  font-weight: 600;
  color: var(--text-primary);
}
.spawn-card-hdr:hover { background: var(--bg-elevated); }
.spawn-caret {
  font-size: 9px;
  color: var(--text-muted);
  width: 10px;
  flex-shrink: 0;
}
.spawn-card-body {
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  border-top: 1px solid var(--border-muted);
}

/* ── Role preview ── */
.prompt-block {
  margin-top: 4px;
  padding: 6px 8px;
  background: var(--bg-subtle);
  border: 1px solid var(--border-muted);
  border-radius: 4px;
}
.role-line {
  margin: 4px 0 0;
  color: var(--text-secondary);
  font-size: var(--font-3xs);
}
.prompt-preview {
  margin: 6px 0 0;
  padding: 6px 8px;
  background: var(--bg-inset);
  border-radius: 4px;
  font-size: var(--font-3xs);
  line-height: var(--lh-base);
  max-height: 220px;
  overflow: auto;
  white-space: pre-wrap;
  color: var(--text-bright);
}
.prompt-head {
  display: flex;
  align-items: center;
  gap: 6px;
}
.prompt-head .tiny {
  margin-left: auto;
  font-size: var(--font-3xs);
}
.warn-block {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.warn-block .warn {
  color: var(--attention-fg);
  margin: 0;
}
</style>
