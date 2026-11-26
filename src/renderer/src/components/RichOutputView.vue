<script setup lang="ts">
// The rich output view of a CLI pane: its recent turns with each reply's
// Markdown rendered. Laid over the terminal as a sibling of .xterm-host, so
// the terminal is never resized, redrawn or cleared by switching views.
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { renderMarkdown, isSafeLinkHref, type RenderedMarkdown, type RichTurn } from '../lib/richTurns'

const props = defineProps<{ turns: readonly RichTurn[] }>()
const { t } = useI18n()

// Per turn, the reply it was last rendered from: a turn's reply is filled in
// place when its turn ends, so the cache is checked against the text itself.
const cache = new Map<number, { reply: string; out: RenderedMarkdown }>()

const rendered = computed(() => {
  const copy = t('pane.rich.copy')
  const live = new Set<number>()
  const list = props.turns.map((turn) => {
    live.add(turn.id)
    if (!turn.reply) return { turn, out: null }
    let hit = cache.get(turn.id)
    if (!hit || hit.reply !== turn.reply) {
      hit = { reply: turn.reply, out: renderMarkdown(turn.reply, { copy }) }
      cache.set(turn.id, hit)
    }
    return { turn, out: hit.out }
  })
  for (const id of cache.keys()) if (!live.has(id)) cache.delete(id)
  return list
})

const scroller = ref<HTMLElement | null>(null)
let pinnedToBottom = true

function onScroll(): void {
  const el = scroller.value
  if (el) pinnedToBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24
}

watch(
  rendered,
  () => {
    if (!pinnedToBottom) return
    void nextTick(() => {
      const el = scroller.value
      if (el) el.scrollTop = el.scrollHeight
    })
  },
  { immediate: true }
)

/** Never navigate the window or open a new one: an http(s) link opens in the
 *  browser. True when the event was on a link. */
function openLink(e: MouseEvent): boolean {
  const link = (e.target as HTMLElement | null)?.closest('a')
  if (!link) return false
  e.preventDefault()
  const href = link.getAttribute('href') ?? ''
  if (isSafeLinkHref(href)) void window.agentTeam?.openExternal?.(href)
  return true
}

function onAuxClick(e: MouseEvent): void {
  // Middle-click: opened externally like a click, never as a new window.
  if (e.button === 1) openLink(e)
}

async function onClick(e: MouseEvent, out: RenderedMarkdown | null): Promise<void> {
  if (openLink(e)) return
  const target = e.target as HTMLElement | null
  const button = target?.closest<HTMLButtonElement>('button.rich-copy')
  if (!button || !out) return
  const code = out.codes[Number(button.dataset.code)]
  if (code === undefined) return
  try {
    await navigator.clipboard.writeText(code)
    button.textContent = t('pane.rich.copied')
    setTimeout(() => (button.textContent = t('pane.rich.copy')), 1500)
  } catch {
    /* clipboard refused: the button simply stays as it was */
  }
}
</script>

<template>
  <div ref="scroller" class="rich-output" data-testid="rich-output" @scroll.passive="onScroll">
    <p v-if="rendered.length === 0" class="rich-empty" data-testid="rich-empty">{{ $t('pane.rich.empty') }}</p>
    <template v-else>
      <p class="rich-note">{{ $t('pane.rich.empty') }}</p>
      <section v-for="item in rendered" :key="item.turn.id" class="rich-turn">
        <div v-if="item.turn.prompt" class="rich-prompt" data-testid="rich-prompt">
          <span class="rich-prompt-who">{{ $t('pane.rich.you') }}</span>
          <span class="rich-prompt-text">{{ item.turn.prompt }}</span>
        </div>
        <!-- v-html: escaped by markdownToHtml, sanitized by DOMPurify (renderMarkdown fails closed) -->
        <div v-if="item.out" class="rich-reply" data-testid="rich-reply" @click="onClick($event, item.out)" @auxclick="onAuxClick" v-html="item.out.html"></div>
        <p v-if="item.turn.truncated" class="rich-truncated" data-testid="rich-truncated">{{ $t('pane.rich.truncated') }}</p>
      </section>
    </template>
  </div>
</template>

<style scoped>
.rich-output {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 2;
  overflow-y: auto;
  padding: 12px 16px 24px;
  background: var(--bg-base);
  color: var(--text-primary);
  font-size: var(--font-sm);
  line-height: 1.6;
  user-select: text;
}
.rich-empty,
.rich-note {
  color: var(--text-secondary);
  font-size: var(--font-xs);
}
.rich-note { margin: 0 0 12px; }
.rich-truncated {
  margin: 4px 0 0;
  color: var(--text-secondary);
  font-size: var(--font-xs);
}
.rich-turn {
  max-width: 880px;
  margin: 0 auto 20px;
}
.rich-prompt {
  display: flex;
  gap: 8px;
  margin-bottom: 8px;
  padding: 6px 10px;
  border-radius: var(--radius-sm);
  background: var(--bg-muted);
  color: var(--text-secondary);
  white-space: pre-wrap;
  word-break: break-word;
}
.rich-prompt-who {
  flex: none;
  font-weight: 600;
  color: var(--accent-fg);
}
.rich-reply { word-break: break-word; }
.rich-reply :deep(.rich-plain) { white-space: pre-wrap; }
.rich-reply :deep(h1),
.rich-reply :deep(h2),
.rich-reply :deep(h3),
.rich-reply :deep(h4) {
  margin: 16px 0 8px;
  line-height: 1.3;
  color: var(--text-bright);
}
.rich-reply :deep(h1) { font-size: 1.4em; }
.rich-reply :deep(h2) { font-size: 1.25em; border-bottom: 1px solid var(--border-muted); padding-bottom: 4px; }
.rich-reply :deep(h3) { font-size: 1.1em; }
.rich-reply :deep(p) { margin: 0 0 10px; }
.rich-reply :deep(ul),
.rich-reply :deep(ol) { margin: 0 0 10px; padding-left: 22px; }
.rich-reply :deep(li) { margin: 2px 0; }
.rich-reply :deep(a) { color: var(--accent-fg); text-decoration: underline; cursor: pointer; }
.rich-reply :deep(blockquote) {
  margin: 0 0 10px;
  padding-left: 10px;
  border-left: 3px solid var(--border-default);
  color: var(--text-secondary);
}
.rich-reply :deep(code) {
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 0.92em;
  padding: 1px 4px;
  border-radius: var(--radius-xs);
  background: var(--bg-muted);
}
.rich-reply :deep(table) {
  border-collapse: collapse;
  margin: 0 0 12px;
  display: block;
  overflow-x: auto;
}
.rich-reply :deep(th),
.rich-reply :deep(td) {
  border: 1px solid var(--border-default);
  padding: 4px 10px;
  text-align: left;
}
.rich-reply :deep(th) { background: var(--bg-subtle); font-weight: 600; }
.rich-reply :deep(hr) { border: none; border-top: 1px solid var(--border-muted); margin: 14px 0; }
.rich-reply :deep(.rich-code) {
  margin: 0 0 12px;
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-sm);
  background: var(--bg-inset, var(--bg-subtle));
  overflow: hidden;
}
.rich-reply :deep(.rich-code-bar) {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 2px 8px;
  border-bottom: 1px solid var(--border-muted);
  font-size: var(--font-2xs);
  color: var(--text-secondary);
}
.rich-reply :deep(.rich-copy) {
  border: 1px solid var(--border-default);
  border-radius: var(--radius-xs);
  background: var(--bg-elevated);
  color: var(--text-primary);
  font-size: var(--font-2xs);
  padding: 1px 8px;
  cursor: pointer;
}
.rich-reply :deep(.rich-copy:hover) { border-color: var(--accent-focus); }
.rich-reply :deep(pre) {
  margin: 0;
  padding: 8px 10px;
  overflow-x: auto;
}
.rich-reply :deep(pre code) { padding: 0; background: none; font-size: var(--font-xs); }
.rich-reply :deep(.hljs-comment),
.rich-reply :deep(.hljs-quote) { color: var(--syntax-comment); font-style: italic; }
.rich-reply :deep(.hljs-keyword),
.rich-reply :deep(.hljs-selector-tag),
.rich-reply :deep(.hljs-literal) { color: var(--syntax-keyword); }
.rich-reply :deep(.hljs-string),
.rich-reply :deep(.hljs-regexp),
.rich-reply :deep(.hljs-addition) { color: var(--syntax-string); }
.rich-reply :deep(.hljs-number) { color: var(--syntax-number); }
.rich-reply :deep(.hljs-title),
.rich-reply :deep(.hljs-title.function_),
.rich-reply :deep(.hljs-section) { color: var(--syntax-function); }
.rich-reply :deep(.hljs-type),
.rich-reply :deep(.hljs-built_in),
.rich-reply :deep(.hljs-title.class_) { color: var(--syntax-type); }
.rich-reply :deep(.hljs-variable),
.rich-reply :deep(.hljs-attr),
.rich-reply :deep(.hljs-attribute),
.rich-reply :deep(.hljs-name),
.rich-reply :deep(.hljs-tag) { color: var(--syntax-variable); }
.rich-reply :deep(.hljs-operator),
.rich-reply :deep(.hljs-meta) { color: var(--syntax-operator); }
.rich-reply :deep(.hljs-deletion) { color: var(--syntax-invalid); }
</style>
