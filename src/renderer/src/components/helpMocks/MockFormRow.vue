<script setup lang="ts">
// One row of a settings list: drag grip, checkbox, label, an inline code chip,
// a hint, a trailing select, or a status badge — whichever the caller asks for.
//
// The `tag` form also serves Git's `.file-row`: the `.file-status` letter,
// the `.file-name-main` and the dimmed `.file-path-dim` beside it
// (navide-git's src/components/GitPane.vue:1911-1922).
//
// Mirrors SettingsModal.vue's `.cli-agent-row`: the ⠿ grip, the checkbox and
// label, and the greyed `.is-disabled` state (:2537-2559); and `.perm-row`
// with its `<code>` flag and three-state `<select>` (:2571-2589).
defineProps<{
  label: string
  /** Draw the ⠿ drag grip. */
  grip?: boolean
  /** Leading one-or-two-character tag — Git's M / A / U status letter. */
  tag?: string
  tagTone?: 'add' | 'del' | 'warn' | 'muted'
  /** Checkbox state; omit for a row with no checkbox. */
  check?: 'on' | 'off'
  /** Inline code chip after the label — a CLI flag, a path. */
  code?: string
  /** Trailing dropdown, showing the chosen option. */
  select?: string
  /** Trailing grey note. */
  hint?: string
  /** Trailing pill, e.g. an install status. */
  badge?: string
  badgeTone?: 'ok' | 'warn' | 'crit'
  /** Drawn as switched off. */
  dim?: boolean
  mark?: string
}>()
</script>

<template>
  <div class="mk-frow" :class="{ dim }">
    <span v-if="grip" class="mk-frow-grip" aria-hidden="true">⠿</span>
    <span v-if="check" class="mk-frow-check" :class="check" aria-hidden="true">{{
      check === 'on' ? '✓' : ''
    }}</span>
    <span v-if="tag" class="mk-frow-tag" :class="tagTone">{{ tag }}</span>
    <span class="mk-frow-label">{{ label }}</span>
    <code v-if="code" class="mk-frow-code">{{ code }}</code>
    <span v-if="hint" class="mk-frow-hint">{{ hint }}</span>
    <span class="mk-frow-gap" />
    <span v-if="badge" class="mk-frow-badge" :class="badgeTone">{{ badge }}</span>
    <span v-if="select" class="mk-frow-select">
      {{ select }}<span class="mk-frow-caret" aria-hidden="true">▾</span>
    </span>
    <span v-if="mark" class="mk-frow-mark">{{ mark }}</span>
  </div>
</template>

<style scoped>
.mk-frow {
  display: flex;
  align-items: center;
  gap: 0.45em;
  padding: 0.3em 0.5em;
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-xs);
  background: var(--bg-base);
  color: var(--text-primary);
  min-width: 0;
  white-space: nowrap;
}
.mk-frow.dim { color: var(--text-muted); }

.mk-frow-grip { flex: none; color: var(--text-muted); cursor: grab; }
.mk-frow-check {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 0.95em;
  height: 0.95em;
  border: 1px solid var(--border-strong);
  border-radius: 2px;
  font-size: 0.8em;
}
.mk-frow-check.on {
  background: var(--accent-emphasis);
  border-color: var(--accent-emphasis);
  color: var(--text-on-emphasis);
}

.mk-frow-tag {
  flex: none;
  width: 1em;
  text-align: center;
  font-family: var(--font-mono);
  color: var(--text-secondary);
}
.mk-frow-tag.add { color: var(--diff-add-fg); }
.mk-frow-tag.del { color: var(--diff-del-fg); }
.mk-frow-tag.warn { color: var(--warning-fg); }
.mk-frow-tag.muted { color: var(--text-muted); }

.mk-frow-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.mk-frow-code {
  flex: none;
  font-family: var(--font-mono);
  font-size: 0.85em;
  padding: 0 0.35em;
  border-radius: var(--radius-xs);
  background: var(--bg-inset);
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}
.mk-frow-hint { min-width: 0; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; }
.mk-frow-gap { flex: 1 1 auto; min-width: 0; }

.mk-frow-badge {
  flex: none;
  padding: 0 0.5em;
  border-radius: 999px;
  background: var(--bg-muted);
  color: var(--text-secondary);
  font-size: 0.85em;
}
.mk-frow-badge.ok { background: var(--success-muted); color: var(--success-fg); }
.mk-frow-badge.warn { background: var(--attention-muted); color: var(--attention-fg); }
.mk-frow-badge.crit { background: var(--danger-muted); color: var(--danger-fg); }

.mk-frow-select {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 0.3em;
  padding: 0.1em 0.45em;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-xs);
  background: var(--bg-subtle);
  color: var(--text-secondary);
}
.mk-frow-caret { color: var(--text-muted); }
.mk-frow-mark { flex: none; color: var(--accent-fg); font-size: 1.1em; }
</style>
