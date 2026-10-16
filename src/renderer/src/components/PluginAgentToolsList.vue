<script setup lang="ts">
// The agent tools a Navide plugin declares, as the consent surfaces show them:
// name, the full plain description, read-only or changes data, and timeout.
// Presentation only; the Host decides whether any of them is served.
defineProps<{
  tools: ReadonlyArray<{
    name: string
    title: string
    description: string
    risk: 'read' | 'write'
    timeoutMs: number
    collidesWith?: string
  }>
}>()
</script>

<template>
  <div class="agent-tools">
    <h5 class="agent-tools-heading">{{ $t('settings.extensions.agentTools.heading') }}</h5>
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
        <span class="agent-tool-description">{{ tool.description }}</span>
        <span v-if="tool.collidesWith" class="agent-tool-collision" role="note">
          {{ $t('settings.extensions.agentTools.collision', { heldBy: tool.collidesWith }) }}
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
.agent-tool-title {
  color: var(--text-secondary);
  font-size: var(--font-xs);
}
.agent-tool-description {
  font-size: var(--font-xs);
  overflow-wrap: anywhere;
}
.agent-tool-collision {
  color: var(--risk-fg);
  font-size: var(--font-xs);
}
.agent-tools-data-flow {
  margin: var(--space-2) 0 0;
  color: var(--text-secondary);
  font-size: var(--font-xs);
}
</style>
