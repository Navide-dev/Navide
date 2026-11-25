<!--
  The Backend popover's first recovery: restart MCP alone (useMcpHealth).
  Off on Windows, where the backend cannot do it (own_loop.py), with a line
  pointing at the whole-backend restart instead. Styled by App.vue's
  .bp-btn / .bp-mcp-note rules.
-->
<script setup lang="ts">
defineProps<{
  supported: boolean
  restarting: boolean
  busy: boolean
  note: string
}>()
defineEmits<{ restart: [] }>()
</script>

<template>
  <div class="bp-mcp-first">
    <button
      class="bp-btn bp-mcp-restart"
      :disabled="!supported || restarting || busy"
      @click="$emit('restart')"
    >
      {{ restarting ? $t('label.mcp-restarting') : $t('label.mcp-restart') }}
    </button>
    <div v-if="!supported" class="bp-mcp-note bp-mcp-unsupported">{{ $t('label.mcp-restart-unsupported') }}</div>
    <div v-if="note" class="bp-mcp-note">{{ note }}</div>
  </div>
</template>
