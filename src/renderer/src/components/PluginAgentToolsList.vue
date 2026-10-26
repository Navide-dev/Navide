<script setup lang="ts">
// The agent tools a Navide plugin declares, as the consent surfaces show them:
// name, the method it calls, the full plain description, the plugin's own
// read-only / changes-data claim, the timeout, and the whole input schema the
// agent will read (collapsed). Presentation only; the Host decides whether any
// of them is served.
import { computed } from 'vue'
import { revealInvisibleText } from '../../../shared/pluginAgentTools'

const props = defineProps<{
  tools: ReadonlyArray<{
    name: string
    title: string
    description: string
    risk: 'read' | 'write'
    timeoutMs: number
    method?: string
    inputSchema?: Record<string, unknown>
    collidesWith?: string
    sharedWith?: string[]
  }>
}>()

// Disclosed, not limited: how much the agent will read in tools/list.
const totalSize = computed(() => {
  const bytes = new TextEncoder().encode(JSON.stringify(props.tools)).length
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`
})
</script>

<template>
  <div class="agent-tools">
    <h5 class="agent-tools-heading">{{ $t('settings.extensions.agentTools.heading', { count: tools.length }) }}</h5>
    <p class="agent-tools-total">{{ $t('settings.extensions.agentTools.total', { count: tools.length, size: totalSize }) }}</p>
    <ul class="agent-tools-list">
      <li v-for="tool in tools" :key="tool.name" class="agent-tool" :data-agent-tool="tool.name">
        <span class="agent-tool-head">
          <code class="agent-tool-name">{{ tool.name }}</code>
          <span class="agent-tool-risk" :class="`agent-tool-risk--${tool.risk}`">
            {{ $t(tool.risk === 'write' ? 'settings.extensions.agentTools.write' : 'settings.extensions.agentTools.read') }}
          </span>
          <span class="agent-tool-timeout">
            {{ $t('settings.extensions.agentTools.timeout', { seconds: tool.timeoutMs / 1000 }) }}
          </span>
        </span>
        <span class="agent-tool-title">{{ tool.title }}</span>
        <span v-if="tool.method" class="agent-tool-method">
          {{ $t('settings.extensions.agentTools.method', { method: tool.method }) }}
        </span>
        <span class="agent-tool-description">{{ tool.description }}</span>
        <details v-if="tool.inputSchema" class="agent-tool-schema">
          <summary>{{ $t('settings.extensions.agentTools.inputSchema') }}</summary>
          <pre class="agent-tool-schema-body">{{ revealInvisibleText(JSON.stringify(tool.inputSchema, null, 2)) }}</pre>
        </details>
        <span v-if="tool.collidesWith" class="agent-tool-collision" role="note">
          {{ $t('settings.extensions.agentTools.collision', { heldBy: tool.collidesWith }) }}
        </span>
        <span v-if="tool.sharedWith?.length" class="agent-tool-collision" role="note">
          {{ $t('settings.extensions.agentTools.sharedWith', { others: tool.sharedWith.join(', ') }) }}
        </span>
      </li>
    </ul>
    <p class="agent-tools-data-flow">{{ $t('settings.extensions.agentTools.dataFlow') }}</p>
  </div>
</template>

<style scoped>
.agent-tools {
  margin: 0 0 var(--space-3);
}
.agent-tools-heading {
  margin: 0 0 var(--space-2);
  color: var(--text-secondary);
  font-size: var(--font-2xs);
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
.agent-tools-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 8px;
}
.agent-tool {
  display: grid;
  gap: 2px;
}
.agent-tool-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--space-2);
}
.agent-tool-name {
  font-family: var(--font-mono);
  font-size: var(--font-2xs);
  font-weight: 600;
}
.agent-tool-risk {
  padding: 1px 7px;
  border-radius: var(--radius-xs);
  font-size: var(--font-2xs);
  font-weight: 600;
}
.agent-tool-risk--write {
  background: var(--risk-subtle);
  color: var(--risk-fg);
}
.agent-tool-risk--read {
  background: var(--bg-hover);
  color: var(--text-secondary);
}
.agent-tool-timeout,
.agent-tool-method,
.agent-tool-title {
  color: var(--text-secondary);
  font-size: var(--font-xs);
}
.agent-tool-description {
  font-size: var(--font-xs);
  overflow-wrap: anywhere;
}
.agent-tool-schema summary {
  cursor: pointer;
  color: var(--text-secondary);
  font-size: var(--font-xs);
}
.agent-tool-schema-body {
  max-height: 240px;
  margin: var(--space-1) 0 0;
  overflow: auto;
  font-family: var(--font-mono);
  font-size: var(--font-2xs);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.agent-tool-collision {
  color: var(--risk-fg);
  font-size: var(--font-xs);
}
.agent-tools-total {
  margin: 0 0 var(--space-2);
  color: var(--text-secondary);
  font-size: var(--font-xs);
}
.agent-tools-data-flow {
  margin: var(--space-2) 0 0;
  color: var(--text-secondary);
  font-size: var(--font-xs);
}
</style>
