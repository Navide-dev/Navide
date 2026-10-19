<script setup lang="ts">
// An in-window plugin contribution, carried by an Electron <webview>.
//
// It used to be a native WebContentsView positioned from measured DOM bounds.
// That composites above the whole document, so a modal could never cover a
// plugin panel, and geometry had to be mirrored by hand (bounds, host resize,
// zoom factor). As a guest in this document the panel is laid out and stacked
// by CSS like anything else.
//
// Identity stays with the Host: prepareContribution returns only a URL holding
// a one-time token, and main overrides the guest's webPreferences on attach.
// Measured, not assumed: `display: none` keeps a guest's webContents alive and
// running — both when applied after attach and when the guest is created
// inside an already-hidden subtree — which is what lets a hidden Git tab keep
// its changes badge current.
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { PluginSource } from '../../../shared/pluginSource'
import { chromeSourceMark } from '../lib/pluginSourceMark'
import PluginSourceBadge from './PluginSourceBadge.vue'

export interface PluginRegionContribution {
  pluginId: string
  packageVersion: string | null
  contributionKey: string
  title: string
  icon: string | null
  /** Single-colour artwork: the renderer paints it in the current text colour
   *  so it follows the theme like the built-in SVG icons. */
  iconMonochrome?: boolean
  kind: 'custom'
  location: 'top' | 'bottom' | 'right' | 'left' | 'main' | 'window' | 'detail'
  manifestOrder: number
  /** Source and review state of the contributing package (K1). */
  source?: PluginSource
}

const props = defineProps<{
  contribution: PluginRegionContribution
  workspacePath: string
  visible: boolean
  /** Host-owned work that must complete before the guest is prepared. */
  beforePrepare?: () => void | Promise<void>
}>()

const src = ref<string | null>(null)
const error = ref<string | null>(null)
const sourceMark = computed(() => chromeSourceMark(props.contribution.source))
let generation = 0
let themeObserver: MutationObserver | null = null
/** True once a Host-side instance may exist for this contribution key. */
let opened = false

function currentTheme(): string {
  return document.documentElement.getAttribute('data-theme') ?? ''
}

function closeContribution(): void {
  if (!opened) return
  opened = false
  void window.agentTeam?.plugins?.closeContribution({
    contributionKey: props.contribution.contributionKey,
  })
}

async function prepare(): Promise<void> {
  const mine = ++generation
  // Clearing `src` removes the <webview> synchronously, which destroys the
  // guest. The Host only hears about that through the guest's own `destroyed`
  // event and reads it as the plugin dying before its readiness handshake —
  // which downgrades a healthy Manifest v2 package (navide.git above all) to
  // legacy recovery for the rest of the session. Release the instance first so
  // the Host settles the activation itself instead of inferring a failure.
  closeContribution()
  src.value = null
  error.value = null
  if (!props.workspacePath) {
    // Removing the element destroys the guest, but the Host-side instance —
    // its backend subscriptions and capability context — outlives it unless we
    // say so. Reached whenever the window falls back to no workspace.
    closeContribution()
    return
  }
  // The Host allocates an instance (and destroys the previous one for this
  // key) as soon as it is asked, so it holds state from the request onward —
  // not from the response. Anything that gives up in between still has to
  // release it.
  opened = true
  try {
    await props.beforePrepare?.()
    if (mine !== generation) return
    const result = await window.agentTeam?.plugins?.prepareContribution({
      contributionKey: props.contribution.contributionKey,
      workspace_path: props.workspacePath,
      // A guest is its own document, so it cannot inherit our CSS variables and
      // has to be told the theme. Read it off the element we are actually
      // rendering with rather than letting main resolve it from the settings
      // mirror, which can lag this window. Theme is cosmetic metadata, not an
      // authority the Host derives anything from. This is the first-paint
      // value; `dom-ready` re-asserts it once the guest can receive events.
      theme: currentTheme(),
    })
    // A workspace change or unmount may have overtaken this request.
    if (mine !== generation) return
    if (!result?.ok || !result.url) {
      error.value = result?.error ?? 'plugin contribution could not be prepared'
      return
    }
    src.value = result.url
  } catch (cause) {
    if (mine !== generation) return
    error.value = cause instanceof Error ? cause.message : String(cause)
  }
}

/** Send the theme this window is rendering with to the Host, which routes it to
 *  the guests as read-only metadata. Fired from the guest's own `dom-ready`
 *  (its first moment able to receive anything) and on every later switch. */
let lastPushedTheme: string | null = null

function pushTheme(): void {
  const theme = currentTheme()
  // The Host broadcast reaches every plugin, and one observer runs per
  // contribution, so an unfiltered push would fan out once per contribution
  // for a single switch. Only report an actual change.
  if (!theme || theme === lastPushedTheme) return
  lastPushedTheme = theme
  window.agentTeam?.plugins?.hostThemeChanged?.(theme)
}

onMounted(() => {
  // Follow the theme instead of sampling it: the guest is its own document and
  // cannot inherit our CSS variables, so every switch has to be forwarded.
  themeObserver = new MutationObserver(() => pushTheme())
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
  })
})

watch(
  () => [props.workspacePath, props.contribution.contributionKey] as const,
  () => void prepare(),
  { immediate: true }
)

watch(
  () => props.visible,
  (visible) => {
    // A failed prepare used to be permanent: the old bounds-driven sync retried
    // on every resize tick, this one only re-runs on workspace changes. Opening
    // the tab is the user's natural retry, so treat it as one — a contribution
    // that came up while the backend was still starting recovers instead of
    // showing "unavailable" until the window is restarted.
    if (visible && !src.value && props.workspacePath) void prepare()
  }
)

onBeforeUnmount(() => {
  themeObserver?.disconnect()
  themeObserver = null
  // Drop the generation so an in-flight prepare cannot resurrect this instance
  // after the Host has been told to close it.
  generation += 1
  closeContribution()
})
</script>

<template>
  <div
    v-show="visible"
    class="plugin-region-host"
    :class="{ 'plugin-region-host--marked': sourceMark }"
    :data-plugin-contribution="contribution.contributionKey"
  >
    <!-- K2: a persistent source strip in Navide's own chrome, above the guest. -->
    <div v-if="sourceMark" class="plugin-region-host__source">
      <span class="plugin-region-host__title" v-text="contribution.title" />
      <PluginSourceBadge :source="sourceMark" />
    </div>
    <div v-if="error" class="plugin-region-host__error" role="status">
      {{ contribution.title }} unavailable
    </div>
    <webview
      v-else-if="src"
      class="plugin-region-host__view"
      :src="src"
      @dom-ready="pushTheme"
    />
  </div>
</template>

<style scoped>
.plugin-region-host {
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 0;
}

.plugin-region-host__view {
  display: flex;
  width: 100%;
  height: 100%;
}

.plugin-region-host--marked {
  display: flex;
  flex-direction: column;
}

.plugin-region-host--marked > .plugin-region-host__view,
.plugin-region-host--marked > .plugin-region-host__error {
  flex: 1;
  min-height: 0;
  height: auto;
}

.plugin-region-host__source {
  display: flex;
  flex: none;
  align-items: center;
  gap: 6px;
  min-width: 0;
  padding: 3px 8px;
  border-bottom: 1px solid var(--border-muted);
  font-size: var(--font-2xs);
}

.plugin-region-host__title {
  overflow: hidden;
  color: var(--text-secondary);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.plugin-region-host__error {
  align-items: center;
  color: var(--text-muted, #8b949e);
  display: flex;
  height: 100%;
  justify-content: center;
  padding: 1rem;
}
</style>
