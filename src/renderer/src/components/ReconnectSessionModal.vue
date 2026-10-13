<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { vTruncate } from '@navide/plugin-ui/foundation'

// Manual "reconnect a lost conversation" picker. Mirrors AgentHistoryModal's
// overlay/modal shell and its props(list)/emits(select,close) shape. The pane
// this picker acts on lives in App.vue; this component is presentation-only:
// it lists orphan transcripts for the workspace and lets the user pick one.
export interface OrphanSession {
  session_id: string
  preview: string[]
  size_bytes: number
  mtime: number
  resumable: boolean
  name: string
}

const props = defineProps<{
  show: boolean
  orphans: OrphanSession[]
  loading: boolean
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'select', sessionId: string): void
}>()

const selectedId = ref('')

// Reset the selection whenever the picker opens.
watch(() => props.show, (open) => {
  if (open) selectedId.value = ''
})

// Only a resumable orphan can be confirmed: a non-resumable row is disabled (so
// it can't be selected) and, defensively, excluded here so confirm stays off.
const selected = computed(() =>
  props.orphans.find((o) => o.session_id === selectedId.value && o.resumable) ?? null
)

function formatSize(bytes: number): string {
  if (!bytes || bytes < 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatMtime(mtime: number): string {
  if (!mtime) return '—'
  // Backend sends seconds since epoch.
  const d = new Date(mtime * 1000)
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString()
}

function confirmSelection(): void {
  if (!selected.value) return
  emit('select', selected.value.session_id)
}
</script>

<template>
  <Teleport v-if="show" to="body">
    <div class="reconnect-overlay nv-modal-overlay" @click.self="emit('close')">
      <div class="reconnect-modal nv-modal-shell nv-modal-shell--standard">
        <div class="reconnect-header">
          <span>{{ $t('reconnect.modal-title') }}</span>
          <button class="reconnect-close" @click="emit('close')">✕</button>
        </div>
        <div class="reconnect-body">
          <div v-if="loading" class="reconnect-empty">{{ $t('reconnect.loading') }}</div>
          <div v-else-if="orphans.length === 0" class="reconnect-empty">{{ $t('reconnect.empty') }}</div>
          <template v-else>
            <p class="reconnect-hint">{{ $t('reconnect.modal-hint') }}</p>
            <div class="reconnect-list">
              <button
                v-for="orphan in orphans"
                :key="orphan.session_id"
                class="reconnect-row"
                :class="{ selected: orphan.session_id === selectedId }"
                :disabled="!orphan.resumable"
                @click="orphan.resumable && (selectedId = orphan.session_id)"
              >
                <div class="reconnect-row-head">
                  <span class="reconnect-name" v-truncate>{{ orphan.name || $t('reconnect.unnamed') }}</span>
                  <span
                    class="reconnect-badge"
                    :class="orphan.resumable ? 'ok' : 'stale'"
                  >{{ orphan.resumable ? $t('reconnect.resumable') : $t('reconnect.not-resumable') }}</span>
                </div>
                <div v-if="orphan.preview.length" class="reconnect-preview">
                  <div v-for="(line, i) in orphan.preview" :key="i" class="reconnect-preview-line" v-truncate>{{ line }}</div>
                </div>
                <div class="reconnect-meta">
                  <span>{{ formatMtime(orphan.mtime) }}</span>
                  <span>·</span>
                  <span>{{ formatSize(orphan.size_bytes) }}</span>
                </div>
              </button>
            </div>
          </template>
        </div>
        <div v-if="!loading && orphans.length > 0" class="reconnect-footer">
          <button class="reconnect-btn nv-btn" @click="emit('close')">{{ $t('action.cancel') }}</button>
          <button
            class="reconnect-btn primary nv-btn nv-btn--primary"
            :disabled="!selected"
            @click="confirmSelection"
          >{{ $t('reconnect.confirm') }}</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.reconnect-overlay {
  position: fixed;
  inset: 0;
  background: var(--modal-backdrop);
  backdrop-filter: blur(var(--modal-backdrop-blur));
  -webkit-backdrop-filter: blur(var(--modal-backdrop-blur));
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1100;
  -webkit-app-region: no-drag;
}
.reconnect-modal {
  background: var(--bg-base);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-lg);
  width: min(var(--modal-w-standard), 92vw);
  max-height: 78vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-shadow: var(--shadow-modal);
}
.reconnect-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border-muted);
  font-size: var(--font-sm);
  font-weight: 600;
  color: var(--text-bright);
}
.reconnect-close {
  background: transparent;
  border: none;
  color: var(--text-secondary);
  font-size: var(--font-md);
  cursor: pointer;
  padding: 2px 6px;
  border-radius: var(--radius-sm);
}
.reconnect-close:hover {
  color: var(--text-bright);
  background: var(--bg-muted);
}
.reconnect-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 12px 14px;
}
.reconnect-empty {
  color: var(--text-secondary);
  font-size: var(--font-xs);
  text-align: center;
  padding: 32px 12px;
}
.reconnect-hint {
  margin: 0 0 10px;
  font-size: var(--font-xs);
  color: var(--text-secondary);
}
.reconnect-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.reconnect-row {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 100%;
  text-align: left;
  padding: 10px 12px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  background: var(--bg-subtle);
  cursor: pointer;
  transition:
    border-color var(--motion-fast) var(--ease-out),
    background-color var(--motion-fast) var(--ease-out);
}
.reconnect-row:hover:not(:disabled) {
  border-color: var(--accent-muted);
}
.reconnect-row:disabled {
  opacity: 0.5;
  cursor: default;
}
.reconnect-row.selected {
  border-color: var(--accent-fg);
  background: var(--bg-selected);
}
.reconnect-row-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.reconnect-name {
  font-size: var(--font-xs);
  font-weight: 600;
  color: var(--text-bright);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.reconnect-badge {
  flex-shrink: 0;
  font-size: var(--font-3xs);
  font-weight: 600;
  padding: 1px 8px;
  border-radius: 10px;
}
.reconnect-badge.ok {
  color: var(--success-fg);
  background: var(--success-subtle);
  border: 1px solid var(--success-muted);
}
.reconnect-badge.stale {
  color: var(--text-secondary);
  background: var(--bg-muted);
  border: 1px solid var(--border-default);
}
.reconnect-preview {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: var(--font-2xs);
  color: var(--text-primary);
}
.reconnect-preview-line {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.reconnect-meta {
  display: flex;
  gap: 6px;
  font-size: var(--font-3xs);
  color: var(--text-muted);
}
.reconnect-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 10px 14px;
  border-top: 1px solid var(--border-muted);
}
.reconnect-btn {
  font-size: var(--font-xs);
  padding: 4px 14px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-default);
  background: transparent;
  color: var(--text-primary);
  cursor: pointer;
}
.reconnect-btn.primary {
  border-color: var(--accent-muted);
  background: var(--accent-subtle);
  color: var(--accent-bright);
}
.reconnect-btn.primary:disabled {
  opacity: 0.5;
  cursor: default;
}
.reconnect-btn:hover:not(:disabled) {
  border-color: var(--accent-bright);
}
</style>
