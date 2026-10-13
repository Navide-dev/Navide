<script setup lang="ts">
// Markdown rendered for the rail, reusing the shared line-based renderer from
// the editor (no marked/markdown-it dependency) plus lazily-loaded mermaid for
// ```mermaid fences. Read-only: unlike PlanMarkdownBody there is no section
// edit, no PlanStore and no backend write path.
import { computed, defineComponent, h, onMounted, ref } from 'vue'
import { InlineText, renderLines } from '../editor/markdownRender'

const props = defineProps<{ content: string }>()

const lines = computed(() => renderLines(props.content))

// Renders one ```mermaid fence. mermaid is imported dynamically so the chunk
// only loads for documents that actually contain a diagram. On any failure the
// raw fence is shown as a code block rather than leaving a blank space.
const MermaidBlock = defineComponent({
  props: { code: { type: String, required: true } },
  setup(blockProps) {
    const svg = ref('')
    const failed = ref(false)
    onMounted(async () => {
      try {
        const mermaid = (await import('mermaid')).default
        mermaid.initialize({
          startOnLoad: false,
          theme: 'neutral',
          securityLevel: 'strict',
          fontFamily: 'inherit',
          layout: 'dagre',
          look: 'classic',
        })
        const id = `mp-mermaid-${Math.random().toString(36).slice(2, 9)}`
        const { svg: out } = await mermaid.render(id, blockProps.code)
        svg.value = out
      } catch {
        failed.value = true
      }
    })
    return () => {
      if (failed.value) return h('pre', { class: 'mp-code' }, h('code', blockProps.code))
      if (!svg.value) return h('div', { class: 'mp-mermaid mp-mermaid--loading' }, '…')
      return h('div', { class: 'mp-mermaid', innerHTML: svg.value })
    }
  },
})
</script>

<template>
  <div class="mp">
    <template v-for="(line, i) in lines" :key="i">
      <MermaidBlock
        v-if="line.kind === 'codeblock' && line.lang === 'mermaid'"
        :code="line.text"
      />
      <pre v-else-if="line.kind === 'codeblock'" class="mp-code"><code>{{ line.text }}</code></pre>
      <component
        :is="line.level <= 2 ? 'h3' : 'h4'"
        v-else-if="line.kind === 'heading'"
        class="mp-h"
      >
        <InlineText :text="line.text" />
      </component>
      <div v-else-if="line.kind === 'bullet'" class="mp-li">
        <span class="mp-mark">•</span><span><InlineText :text="line.text" /></span>
      </div>
      <div v-else-if="line.kind === 'ordered'" class="mp-li">
        <span class="mp-mark">{{ line.marker }}</span><span><InlineText :text="line.text" /></span>
      </div>
      <blockquote v-else-if="line.kind === 'quote'" class="mp-quote">
        <InlineText :text="line.text" />
      </blockquote>
      <p v-else-if="line.kind === 'paragraph'" class="mp-p">
        <InlineText :text="line.text" />
      </p>
      <div v-else class="mp-blank" />
    </template>
  </div>
</template>

<style scoped>
.mp {
  height: 100%;
  overflow: auto;
  padding: 10px 12px;
  font-size: 12.5px;
  line-height: var(--lh-loose);
}
.mp-h {
  font-size: 13.5px;
  font-weight: 700;
  margin: 12px 0 5px;
}
.mp-h:first-child {
  margin-top: 0;
}
.mp-p {
  margin: 0 0 8px;
}
.mp-li {
  display: flex;
  gap: 7px;
  margin-bottom: 3px;
}
.mp-mark {
  flex: none;
  opacity: 0.6;
}
.mp-quote {
  margin: 0 0 8px;
  padding-left: 10px;
  border-left: 2px solid var(--border-default);
  opacity: 0.85;
}
.mp-code {
  margin: 0 0 8px;
  padding: 8px 10px;
  border-radius: 6px;
  background: var(--bg-elevated, rgba(127, 127, 127, 0.12));
  font-family: var(--font-mono, ui-monospace, 'SF Mono', Menlo, monospace);
  font-size: var(--font-2xs);
  line-height: 1.6;
  overflow-x: auto;
}
.mp-blank {
  height: 6px;
}
.mp :deep(.mp-mermaid) {
  margin: 0 0 10px;
  overflow-x: auto;
}
.mp :deep(.mp-mermaid svg) {
  max-width: 100%;
  height: auto;
}
.mp :deep(.mp-mermaid--loading) {
  opacity: 0.5;
  font-size: var(--font-2xs);
}
.mp :deep(code) {
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--bg-elevated, rgba(127, 127, 127, 0.15));
  font-family: var(--font-mono, ui-monospace, Menlo, monospace);
  font-size: 0.9em;
}
</style>
