<script setup lang="ts">
import { computed, ref } from 'vue'
import { vTruncate } from '@navide/plugin-ui/foundation'
import type { useGitAccounts, GitAccountPublic } from '../composables/useGitAccounts'

const props = defineProps<{
  api: ReturnType<typeof useGitAccounts>
}>()

const { accounts, available, error } = props.api

// ── Add / edit form ─────────────────────────────────────────────────────────
const editingId = ref<string | null>(null) // null = closed, '' = adding new
const fLabel = ref('')
const fHost = ref('github.com')
const fUsername = ref('')
const fToken = ref('')
const saving = ref(false)

const formOpen = computed(() => editingId.value !== null)
const isEditing = computed(() => !!editingId.value)

function openAdd(): void {
  editingId.value = ''
  fLabel.value = ''
  fHost.value = 'github.com'
  fUsername.value = ''
  fToken.value = ''
}

function openEdit(acc: GitAccountPublic): void {
  editingId.value = acc.id
  fLabel.value = acc.label
  fHost.value = acc.host
  fUsername.value = acc.username
  fToken.value = '' // blank = keep existing token
}

function closeForm(): void {
  editingId.value = null
}

const canSave = computed(() => {
  if (!fLabel.value.trim() || !fHost.value.trim() || !fUsername.value.trim()) return false
  // Token is required when adding; optional when editing (blank keeps existing).
  if (!isEditing.value && !fToken.value) return false
  return true
})

async function save(): Promise<void> {
  if (!canSave.value || saving.value) return
  saving.value = true
  try {
    let ok = false
    if (isEditing.value && editingId.value) {
      const patch: Partial<{ label: string; host: string; username: string; token: string }> = {
        label: fLabel.value.trim(),
        host: fHost.value.trim(),
        username: fUsername.value.trim()
      }
      if (fToken.value) patch.token = fToken.value
      ok = await props.api.updateAccount(editingId.value, patch)
    } else {
      ok = await props.api.addAccount({
        label: fLabel.value.trim(),
        host: fHost.value.trim(),
        username: fUsername.value.trim(),
        token: fToken.value
      })
    }
    if (ok) closeForm()
  } finally {
    saving.value = false
  }
}

const confirmRemoveId = ref<string | null>(null)

async function remove(id: string): Promise<void> {
  const ok = await props.api.removeAccount(id)
  if (ok) {
    confirmRemoveId.value = null
    if (editingId.value === id) closeForm()
  }
}
</script>

<template>
  <div class="ga-pane">
    <section class="ga-section">
      <div class="ga-head">
        <div>
          <h3 class="ga-title">{{ $t('settings.accounts.title') }}</h3>
          <p class="ga-hint">{{ $t('settings.accounts.encrypted-note') }}</p>
        </div>
        <button
          v-if="available"
          class="ga-btn primary"
          :disabled="formOpen"
          @click="openAdd"
        >
          {{ $t('settings.accounts.new-account') }}
        </button>
      </div>

      <!-- safeStorage unavailable -->
      <div v-if="!available" class="ga-banner warn">
        {{ $t('settings.accounts.unavailable') }}
      </div>

      <!-- Error surface -->
      <div v-if="error" class="ga-banner danger">{{ error }}</div>

      <!-- Account list -->
      <div v-if="accounts.length" class="ga-list">
        <div v-for="acc in accounts" :key="acc.id" class="ga-row">
          <div class="ga-row-main">
            <span class="ga-row-label">{{ acc.label }}</span>
            <span class="ga-row-meta" v-truncate>{{ acc.host }} · {{ acc.username }} · ••••{{ acc.tokenLast4 }}</span>
          </div>
          <div class="ga-row-actions">
            <template v-if="confirmRemoveId === acc.id">
              <span class="ga-confirm-text">{{ $t('settings.accounts.delete-confirm') }}</span>
              <button class="ga-btn danger sm" @click="remove(acc.id)">
                {{ $t('settings.accounts.delete') }}
              </button>
              <button class="ga-btn ghost sm" @click="confirmRemoveId = null">
                {{ $t('settings.accounts.cancel') }}
              </button>
            </template>
            <template v-else>
              <button
                class="ga-btn ghost sm"
                :disabled="!available"
                @click="openEdit(acc)"
              >
                {{ $t('settings.accounts.edit') }}
              </button>
              <button class="ga-btn ghost sm" @click="confirmRemoveId = acc.id">
                {{ $t('settings.accounts.delete') }}
              </button>
            </template>
          </div>
        </div>
      </div>
      <p v-else class="ga-empty nv-empty nv-empty--inline">{{ $t('settings.accounts.empty') }}</p>

      <!-- Add / edit form -->
      <div v-if="formOpen" class="ga-form">
        <div class="ga-form-title">
          {{ isEditing ? $t('settings.accounts.edit') : $t('settings.accounts.new-account') }}
        </div>
        <div class="ga-field">
          <label class="ga-label">{{ $t('settings.accounts.label') }}</label>
          <input v-model="fLabel" class="ga-input" type="text" spellcheck="false" />
        </div>
        <div class="ga-field">
          <label class="ga-label">{{ $t('settings.accounts.host') }}</label>
          <input v-model="fHost" class="ga-input" type="text" spellcheck="false" placeholder="github.com" />
        </div>
        <div class="ga-field">
          <label class="ga-label">{{ $t('settings.accounts.username') }}</label>
          <input v-model="fUsername" class="ga-input" type="text" autocomplete="username" spellcheck="false" />
        </div>
        <div class="ga-field">
          <label class="ga-label">{{ $t('settings.accounts.token') }}</label>
          <input
            v-model="fToken"
            class="ga-input"
            type="password"
            autocomplete="new-password"
            spellcheck="false"
            :placeholder="isEditing ? $t('settings.accounts.token-keep') : ''"
          />
          <p class="ga-field-hint">{{ $t('settings.accounts.token-hint') }}</p>
        </div>
        <div class="ga-form-actions">
          <button class="ga-btn ghost sm" @click="closeForm">
            {{ $t('settings.accounts.cancel') }}
          </button>
          <button class="ga-btn primary sm" :disabled="!canSave || saving" @click="save">
            {{ $t('settings.accounts.save') }}
          </button>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.ga-pane {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 18px 22px;
}
.ga-section { margin-bottom: 26px; }
.ga-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 14px;
}
.ga-title { margin: 0 0 4px; font-size: var(--font-sm); font-weight: 600; color: var(--text-bright); }
.ga-hint { margin: 0; font-size: 11.5px; color: var(--text-secondary); max-width: 46ch; line-height: 1.4; }

.ga-banner {
  border-radius: 6px;
  padding: 8px 10px;
  font-size: 11.5px;
  line-height: 1.4;
  margin-bottom: 12px;
}
.ga-banner.warn {
  background: var(--attention-subtle, var(--bg-muted));
  border: 1px solid var(--attention-muted, var(--border-default));
  color: var(--attention-fg, var(--text-primary));
}
.ga-banner.danger {
  background: var(--danger-subtle, var(--bg-muted));
  border: 1px solid var(--danger-muted, var(--border-default));
  color: var(--danger-fg, var(--text-primary));
}

.ga-list { display: flex; flex-direction: column; gap: 6px; }
.ga-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 10px;
  border: 1px solid var(--border-default);
  border-radius: 6px;
  background: var(--bg-subtle);
}
.ga-row-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.ga-row-label { font-size: 12.5px; font-weight: 600; color: var(--text-primary); }
.ga-row-meta { font-size: var(--font-2xs); color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ga-row-actions { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
.ga-confirm-text { font-size: var(--font-2xs); color: var(--text-secondary); }

.ga-empty { font-size: 11.5px; color: var(--text-muted); margin: 0; }

.ga-form {
  margin-top: 14px;
  padding: 14px;
  border: 1px solid var(--border-default);
  border-radius: 8px;
  background: var(--bg-inset, var(--bg-subtle));
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.ga-form-title { font-size: var(--font-xs); font-weight: 600; color: var(--text-bright); }
.ga-field { display: flex; flex-direction: column; gap: 4px; }
.ga-label { font-size: var(--font-2xs); color: var(--text-secondary); }
.ga-field-hint { margin: 2px 0 0; font-size: 10.5px; color: var(--text-muted); line-height: 1.4; }
.ga-input {
  background: var(--bg-base);
  border: 1px solid var(--border-default);
  border-radius: 4px;
  color: var(--text-primary);
  font-size: var(--font-xs);
  padding: 5px 8px;
}
.ga-input:focus { outline: none; border-color: var(--accent-focus); }
.ga-form-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 2px; }

.ga-btn {
  border-radius: 5px;
  font-size: var(--font-xs);
  padding: 5px 10px;
  cursor: pointer;
  border: 1px solid var(--border-default);
  background: transparent;
  color: var(--text-primary);
}
.ga-btn.sm { font-size: var(--font-2xs); padding: 3px 8px; }
.ga-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.ga-btn.primary {
  background: var(--accent-emphasis);
  border-color: var(--accent-emphasis);
  color: var(--text-on-emphasis);
}
.ga-btn.primary:hover:not(:disabled) { background: var(--accent-fg); border-color: var(--accent-fg); }
.ga-btn.ghost { background: transparent; color: var(--text-secondary); }
.ga-btn.ghost:hover:not(:disabled) { border-color: var(--border-strong); color: var(--text-primary); }
.ga-btn.danger {
  background: var(--danger-emphasis, var(--danger-fg));
  border-color: var(--danger-emphasis, var(--danger-fg));
  color: var(--text-on-emphasis);
}
</style>
