<script setup lang="ts">
// One transcript entry of an ACP pane. Its own component so a streamed chunk
// re-renders only the entry it lands in, never the whole transcript; the
// entry's text arrives in bounded parts (lib/acpPane.ts ACP_PART_MAX), so a
// long reply grows by appending, not by rewriting one ever-longer node.
import { entryText, type TranscriptEntry } from '../lib/acpPane'

defineProps<{ entry: TranscriptEntry }>()
</script>

<template>
  <div class="acp-entry" :data-role="entry.role">
    <template v-if="entry.role === 'tool'">
      <span class="acp-tool">{{ entryText(entry) }}</span>
      <small v-if="entry.status" class="acp-tool-status">{{ entry.status }}</small>
    </template>
    <template v-else>
      <span v-for="(part, j) in entry.parts" :key="j">{{ part }}</span>
      <small v-if="entry.delivery === 'unsent'" class="acp-delivery" data-testid="acp-unsent">{{ $t('pane.acp.unsent') }}</small>
      <small v-else-if="entry.delivery === 'unconfirmed'" class="acp-delivery" data-testid="acp-unconfirmed">{{ $t('pane.acp.unconfirmed') }}</small>
    </template>
  </div>
</template>

<style scoped>
.acp-entry { white-space: pre-wrap; word-break: break-word; margin-bottom: 8px; }
.acp-entry[data-role='user'] { color: var(--text-secondary); border-left: 2px solid var(--border-default); padding-left: 6px; }
.acp-entry[data-role='thought'] { color: var(--text-secondary); font-style: italic; }
.acp-entry[data-role='notice'] { color: var(--danger-fg); }
.acp-tool { font-size: var(--font-xs); }
.acp-delivery {
  margin-left: 6px;
  color: var(--danger-fg);
  font-size: var(--font-2xs);
}

.acp-tool-status { margin-left: 6px; color: var(--text-secondary); }
</style>
