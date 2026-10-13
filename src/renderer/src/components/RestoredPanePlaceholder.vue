<script setup lang="ts">
import { vTruncate } from '@navide/plugin-ui/foundation'

const props = defineProps<{
  paneId: string
  title: string
  /** Title came from the auto-namer — see TerminalPane's matching prop. */
  autoNamed?: boolean
  subtitle?: string
  pipeTag?: string
  isFocus?: boolean
  realizing?: boolean
  /** The pane was working when the app was restarted, and the relaunch did not
   *  bring it back by itself (over the cap, or the resume failed). */
  interrupted?: boolean
}>()

const emit = defineEmits<{
  activate: []
  minimize: []
  'context-menu': [event: MouseEvent]
}>()

// The container stays a plain div: clicking anywhere in it resumes (mouse
// convenience), while the keyboard entry point is the real <button> in the
// body. Declaring the container role="button" instead would nest the minimize
// button inside it, and a keydown on minimize would bubble up and resume too.
function activate(): void {
  if (!props.realizing) emit('activate')
}
</script>

<template>
  <div
    :class="['pane', 'restored-pane-placeholder', { 'pane-focus': isFocus, realizing }]"
    :data-pane-id="paneId"
    :aria-busy="realizing"
    @click="activate"
    @contextmenu.prevent.stop="emit('context-menu', $event)"
  >
    <button
      class="minimize-btn"
      :title="$t('pane.terminal.minimize-tooltip')"
      @click.stop="emit('minimize')"
    >⊟</button>
    <header class="pane-header">
      <div class="header-main">
        <span v-if="pipeTag" class="pipe-tag">{{ pipeTag }}</span>
        <span class="title" v-truncate>{{ title }}</span>
        <span
          v-if="autoNamed"
          class="auto-name-mark"
          :title="$t('pane.terminal.auto-named-tooltip')"
        >◦</span>
        <span
          v-if="interrupted"
          class="interrupted-mark"
          :title="$t('pane.terminal.interrupted-at-launch-tooltip')"
        >{{ $t('pane.terminal.interrupted-at-launch') }}</span>
      </div>
      <span v-if="subtitle" class="header-sub" v-truncate>{{ subtitle }}</span>
    </header>
    <button
      class="resume-prompt"
      type="button"
      :disabled="realizing"
      @click.stop="activate"
    >
      <span class="resume-icon">↩</span>
      <span>{{ $t(realizing ? 'pane.terminal.resuming' : 'pane.terminal.click-to-resume') }}</span>
    </button>
  </div>
</template>

<style scoped>
.pane {
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
  background: var(--bg-base);
  border: 1px solid var(--border-muted);
  border-radius: 4px;
  overflow: hidden;
  position: relative;
}

.pane.pane-focus {
  border-color: var(--accent-focus);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent-focus) 27%, transparent);
}

.resume-prompt:focus-visible {
  outline: 2px solid var(--accent-focus);
  outline-offset: -2px;
}

.pane-header {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 1px;
  padding: 5px 32px 5px 12px;
  background: var(--bg-subtle);
  border-bottom: 1px solid var(--border-muted);
  font-size: var(--font-xs);
  color: var(--text-primary);
}

.header-main {
  display: flex;
  align-items: center;
  gap: 8px;
}

.header-sub {
  overflow: hidden;
  color: var(--text-secondary);
  font-size: var(--font-3xs);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pipe-tag {
  flex-shrink: 0;
  padding: 1px 5px;
  border-radius: 3px;
  background: var(--accent-muted);
  color: var(--accent-bright);
  font-size: 9px;
  font-weight: 700;
}

.title {
  overflow: hidden;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Matches TerminalPane's marker so a cold placeholder and a live pane read the
   same. */
.auto-name-mark {
  flex-shrink: 0;
  font-size: 0.75em;
  line-height: 1;
  opacity: 0.45;
  margin-left: -6px; /* same gap pull-back as TerminalPane's header */
  user-select: none;
}

.interrupted-mark {
  flex-shrink: 0;
  padding: 1px 5px;
  border: 1px solid var(--warning-fg);
  border-radius: 3px;
  color: var(--warning-fg);
  font-size: 9px;
  font-weight: 700;
  white-space: nowrap;
}

.minimize-btn {
  position: absolute;
  top: 5px;
  right: 6px;
  z-index: 1;
  padding: 0 3px;
  border: 0;
  border-radius: 3px;
  background: none;
  color: var(--text-disabled);
  cursor: pointer;
  font-size: var(--font-md);
  line-height: 1;
}

.minimize-btn:hover {
  background: var(--bg-muted);
  color: var(--text-primary);
}

.resume-prompt {
  display: flex;
  flex: 1;
  align-items: center;
  justify-content: center;
  gap: 8px;
  width: 100%;
  padding: 0;
  border: 0;
  background: none;
  color: var(--text-secondary);
  cursor: pointer;
  font-family: inherit;
  font-size: var(--font-sm);
}

.resume-icon {
  font-size: 18px;
}

.realizing .resume-prompt {
  cursor: wait;
}
</style>
