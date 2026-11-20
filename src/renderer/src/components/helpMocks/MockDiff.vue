<script setup lang="ts">
// A diff hunk: the @@ header, then added / removed / context lines drawn as
// tinted bars. The lines carry no text on purpose — a diff is whatever the
// file actually says, and inventing source would be the one part of the
// picture that could not be true.
//
// Mirrors navide-git's src/editor/DiffPane.vue:204-212 — `.dp-hunk`
// with its `.dp-range` header and the `.hk-btn` per-hunk actions — and the
// `.dp-grid` side-by-side body under it (:218-226). The single-column form is
// ConflictPane.vue's own one-block-at-a-time view.
defineProps<{
  /** The @@ header line, e.g. "@@ -12,7 +12,9 @@". */
  header: string
  /** One entry per line: what kind of change it is, and how long it runs. */
  lines: { kind: 'add' | 'del' | 'ctx'; width: number }[]
  /** Buttons on the header row. */
  actions?: string[]
  /** Side-by-side, the way DiffPane draws a file diff. Off gives the single
   *  column ConflictPane shows for one conflict block. */
  split?: boolean
  mark?: string
}>()
</script>

<template>
  <div class="mk-diff">
    <div class="mk-diff-head">
      <code class="mk-diff-hunk">{{ header }}</code>
      <span class="mk-diff-gap" />
      <span v-for="action in actions" :key="action" class="mk-diff-btn">{{ action }}</span>
      <span v-if="mark" class="mk-diff-mark">{{ mark }}</span>
    </div>
    <div v-if="split" class="mk-diff-body mk-diff-split" aria-hidden="true">
      <template v-for="(line, i) in lines" :key="i">
        <div class="mk-diff-line" :class="line.kind === 'add' ? 'ctx-empty' : line.kind">
          <span class="mk-diff-sign">{{ line.kind === 'del' ? '-' : '' }}</span>
          <span v-if="line.kind !== 'add'" class="mk-diff-bar" :style="{ width: line.width + '%' }" />
        </div>
        <div class="mk-diff-line" :class="line.kind === 'del' ? 'ctx-empty' : line.kind">
          <span class="mk-diff-sign">{{ line.kind === 'add' ? '+' : '' }}</span>
          <span v-if="line.kind !== 'del'" class="mk-diff-bar" :style="{ width: line.width + '%' }" />
        </div>
      </template>
    </div>
    <div v-else class="mk-diff-body" aria-hidden="true">
      <div v-for="(line, i) in lines" :key="i" class="mk-diff-line" :class="line.kind">
        <span class="mk-diff-sign">{{ line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : '' }}</span>
        <span class="mk-diff-bar" :style="{ width: line.width + '%' }" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.mk-diff {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-xs);
  overflow: hidden;
  min-width: 0;
}
.mk-diff-head {
  display: flex;
  align-items: center;
  gap: 0.35em;
  padding: 0.25em 0.45em;
  background: var(--bg-subtle);
  border-bottom: 1px solid var(--border-muted);
  min-width: 0;
  overflow: hidden;
}
.mk-diff-hunk {
  font-family: var(--font-mono);
  font-size: 0.85em;
  color: var(--accent-fg);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}
.mk-diff-gap { flex: 1 1 auto; min-width: 0; }
.mk-diff-btn {
  flex: none;
  padding: 0 0.4em;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-xs);
  background: var(--bg-base);
  color: var(--text-secondary);
  font-size: 0.85em;
  white-space: nowrap;
}
.mk-diff-mark { flex: none; color: var(--accent-fg); font-size: 1.1em; }

.mk-diff-body {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 0.35em 0.45em;
  background: var(--bg-base);
}
.mk-diff-line {
  display: flex;
  align-items: center;
  gap: 0.4em;
  padding: 1px 0.2em;
  border-radius: 2px;
}
.mk-diff-split {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  column-gap: 0.5em;
}
.mk-diff-line.ctx-empty { background: var(--bg-inset); }
.mk-diff-line.add { background: var(--diff-add-bg); }
.mk-diff-line.del { background: var(--diff-del-bg); }
.mk-diff-sign {
  flex: none;
  width: 0.7em;
  font-family: var(--font-mono);
  font-size: 0.85em;
  color: var(--text-muted);
}
.mk-diff-line.add .mk-diff-sign { color: var(--diff-add-fg); }
.mk-diff-line.del .mk-diff-sign { color: var(--diff-del-fg); }
.mk-diff-bar {
  height: 0.3em;
  border-radius: 999px;
  background: var(--border-default);
}
.mk-diff-line.add .mk-diff-bar { background: var(--diff-add-fg); opacity: 0.55; }
.mk-diff-line.del .mk-diff-bar { background: var(--diff-del-fg); opacity: 0.55; }
</style>
