<script setup lang="ts">
// A header strip: caret, label, count badge, optional status chip, and the
// icon buttons banked to the right.
//
// Boundary with MockMessageLog: the message log is a whole panel whose rows
// are three lines each, so it stays its own component rather than being
// assembled from this strip plus MockFormRow (which is a single-line row).
//
// Mirrors the Git panel's `.sec-hdr` — `.sec-caret`, `.sec-label`,
// `.sec-badge` and the `.sec-btn` actions (− to unstage all, ↩ to discard,
// ＋ to stage all) in navide-git's src/components/GitPane.vue:1828-1836
// and :1958-1970; also stands in for ConflictPane's own title strip.
defineProps<{
  /** Section name. Omitted for a bare action row, like the commit buttons. */
  label?: string
  /** Draw the ▾ disclosure caret before the label. */
  caret?: boolean
  /** Count pill after the label. */
  badge?: string
  /** Emphasised chip, e.g. CONFLICT. */
  chip?: string
  chipTone?: 'warn' | 'crit'
  /** Grey text between the chip and the buttons, e.g. "1 / 3 resolved". */
  note?: string
  /** Icon or short-word buttons, right-aligned. */
  buttons?: { label: string; primary?: boolean; danger?: boolean }[]
  mark?: string
}>()
</script>

<template>
  <div class="mk-bar">
    <span v-if="caret" class="mk-bar-caret" aria-hidden="true">▾</span>
    <span v-if="label" class="mk-bar-label">{{ label }}</span>
    <span v-if="badge" class="mk-bar-badge">{{ badge }}</span>
    <span v-if="chip" class="mk-bar-chip" :class="chipTone">{{ chip }}</span>
    <span v-if="note" class="mk-bar-note">{{ note }}</span>
    <span class="mk-bar-gap" />
    <span
      v-for="button in buttons"
      :key="button.label"
      class="mk-bar-btn"
      :class="{ primary: button.primary, danger: button.danger }"
    >{{ button.label }}</span>
    <span v-if="mark" class="mk-bar-mark">{{ mark }}</span>
  </div>
</template>

<style scoped>
.mk-bar {
  display: flex;
  align-items: center;
  gap: 0.4em;
  padding: 0.28em 0.5em;
  background: var(--bg-subtle);
  border-bottom: 1px solid var(--border-muted);
  color: var(--text-secondary);
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
}
.mk-bar-caret { flex: none; color: var(--text-muted); }
.mk-bar-label {
  min-width: 0;
  color: var(--text-bright);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  font-size: 0.9em;
  overflow: hidden;
  text-overflow: ellipsis;
}
.mk-bar-badge {
  flex: none;
  padding: 0 0.45em;
  border-radius: 999px;
  background: var(--bg-muted);
  color: var(--text-secondary);
  font-size: 0.85em;
}
.mk-bar-chip {
  flex: none;
  padding: 0 0.45em;
  border-radius: var(--radius-xs);
  background: var(--bg-muted);
  color: var(--text-secondary);
  font-size: 0.82em;
  letter-spacing: 0.05em;
}
.mk-bar-chip.warn { background: var(--attention-muted); color: var(--attention-fg); }
.mk-bar-chip.crit { background: var(--danger-muted); color: var(--danger-fg); }
.mk-bar-note { flex: none; color: var(--text-muted); font-size: 0.9em; }
.mk-bar-gap { flex: 1 1 auto; min-width: 0; }
.mk-bar-btn {
  flex: none;
  padding: 0 0.45em;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-xs);
  background: var(--bg-base);
  color: var(--text-secondary);
}
.mk-bar-btn.primary {
  background: var(--accent-emphasis);
  border-color: var(--accent-emphasis);
  color: var(--text-on-emphasis);
}
.mk-bar-btn.danger { color: var(--danger-fg); }
.mk-bar-mark { flex: none; color: var(--accent-fg); font-size: 1.1em; }
</style>
