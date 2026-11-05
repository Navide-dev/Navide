<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import GitRecoveryPanel from './GitRecoveryPanel.vue'

const props = defineProps<{
  workspacePath: string
  visible: boolean
}>()

const { t } = useI18n()

const slot = ref<HTMLElement | null>(null)
const slotError = ref(false)
let disposed = false
// Reactive: the template needs it to tell an empty slot that has a native
// view stacked over it from one with nothing to show at all.
const openedWorkspace = ref('')
let visibleInHost = false
let lastBounds: { x: number; y: number; width: number; height: number } | null = null
let lastGeometry = ''
let queue = Promise.resolve()
const legacyFallback = ref(false)
const legacyFallbackReason = ref('')
let zoomFactor = 1
let zoomLoaded = false
let zoomLoad: Promise<void> | null = null
let zoomRevision = 0
let pendingGeometry: { x: number; y: number; width: number; height: number } | null = null
let syncGeneration = 0
let syncScheduled = false
let animationFrame: number | null = null
let offZoomChanged: (() => void) | null = null

function resetViewState(): void {
  openedWorkspace.value = ''
  visibleInHost = false
  lastBounds = null
  lastGeometry = ''
}

function invalidateZoomFactor(): void {
  zoomRevision += 1
  zoomLoaded = false
  zoomLoad = null
}

function rawGeometry(): { x: number; y: number; width: number; height: number } | null {
  const element = slot.value
  if (!element) return null
  const rect = element.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return null
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
}

function capturePendingGeometry(): void {
  pendingGeometry = rawGeometry()
}

function isCurrent(generation: number, workspacePath: string): boolean {
  return !disposed &&
    generation === syncGeneration &&
    props.workspacePath.trim() === workspacePath
}

async function ensureZoomFactor(): Promise<void> {
  if (zoomLoaded) return
  const revision = zoomRevision
  if (!zoomLoad) {
    zoomLoad = (async () => {
      let nextFactor = 1
      try {
        const value = await window.agentTeam?.getZoomFactor?.()
        nextFactor = typeof value === 'number' && value > 0 ? value : 1
      } catch {
        nextFactor = 1
      }
      if (revision !== zoomRevision) return
      zoomFactor = nextFactor
      zoomLoaded = true
    })()
  }
  await zoomLoad
  if (revision !== zoomRevision) {
    await ensureZoomFactor()
  }
}

async function currentBounds(): Promise<{ x: number; y: number; width: number; height: number } | null> {
  const rect = pendingGeometry ?? rawGeometry()
  pendingGeometry = null
  if (!rect) return null
  await ensureZoomFactor()
  const scale = zoomFactor > 0 ? zoomFactor : 1
  return {
    x: rect.x / scale,
    y: rect.y / scale,
    width: rect.width / scale,
    height: rect.height / scale,
  }
}

function enqueue(task: () => Promise<void>): void {
  queue = queue.then(task).catch(async (error: unknown) => {
    // Every unexpected IPC/geometry failure must have a visible terminal
    // state. The queue remains usable after the error, while the current
    // workspace is gated until the user explicitly retries.
    console.warn('[git-plugin-slot] sync failed', error)
    const workspacePath = props.workspacePath.trim()
    if (workspacePath && !disposed && !slotError.value) {
      await enterError(syncGeneration, workspacePath)
    }
  })
}

function applyLegacyFallback(reason = ''): void {
  legacyFallbackReason.value = reason
  slotError.value = false
  pendingGeometry = null
  resetViewState()
  legacyFallback.value = true
}

async function enterError(generation: number, workspacePath: string): Promise<void> {
  if (!isCurrent(generation, workspacePath)) return
  const hadNativeView = openedWorkspace.value !== ''
  resetViewState()
  slotError.value = true
  capturePendingGeometry()
  if (hadNativeView) {
    try {
      await window.agentTeam?.closeGitLeftView()
    } catch {
      // The error state is already fail-closed; cleanup is best effort.
    }
  }
}

function sync(): void {
  enqueue(async () => {
    if (disposed) return
    if (legacyFallback.value) return
    if (slotError.value) {
      capturePendingGeometry()
      return
    }
    const generation = syncGeneration
    const workspacePath = props.workspacePath.trim()
    if (!workspacePath) {
      if (openedWorkspace.value) await window.agentTeam?.closeGitLeftView()
      if (!isCurrent(generation, workspacePath)) return
      resetViewState()
      pendingGeometry = null
      return
    }

    if (openedWorkspace.value && openedWorkspace.value !== workspacePath) {
      await window.agentTeam?.closeGitLeftView()
      if (!isCurrent(generation, workspacePath)) return
      resetViewState()
    }

    let bounds: { x: number; y: number; width: number; height: number } | null
    try {
      bounds = await currentBounds()
    } catch {
      await enterError(generation, workspacePath)
      return
    }
    if (!isCurrent(generation, workspacePath)) return

    if (bounds) {
      lastBounds = bounds
      const geometry = [bounds.x, bounds.y, bounds.width, bounds.height].join(':')
      if (props.visible && !openedWorkspace.value) {
        try {
          const result = await window.agentTeam?.openGitLeftView({ workspace_path: workspacePath, bounds })
          if (!isCurrent(generation, workspacePath)) {
            if (result?.ok && result.fallback !== 'legacy') {
              try { await window.agentTeam?.closeGitLeftView() } catch { /* stale cleanup */ }
            }
            return
          }
          if (!result?.ok) {
            await enterError(generation, workspacePath)
            return
          }
          if (result.fallback === 'legacy') {
            applyLegacyFallback(result.reason)
            return
          }
          openedWorkspace.value = workspacePath
          visibleInHost = true
          lastGeometry = geometry
        } catch {
          await enterError(generation, workspacePath)
        }
      } else if (openedWorkspace.value && (props.visible !== visibleInHost || geometry !== lastGeometry)) {
        try {
          const result = await window.agentTeam?.updateGitLeftView({ bounds, visible: props.visible })
          if (!isCurrent(generation, workspacePath)) return
          if (!result?.ok) {
            await enterError(generation, workspacePath)
            return
          }
          if (result.fallback === 'legacy') {
            applyLegacyFallback(result.reason)
            return
          }
          visibleInHost = props.visible
          lastGeometry = geometry
        } catch {
          await enterError(generation, workspacePath)
        }
      }
    } else if (openedWorkspace.value && !props.visible && visibleInHost && lastBounds) {
      try {
        const result = await window.agentTeam?.updateGitLeftView({ bounds: lastBounds, visible: false })
        if (!isCurrent(generation, workspacePath)) return
        if (!result?.ok) {
          await enterError(generation, workspacePath)
          return
        }
        if (result.fallback === 'legacy') {
          applyLegacyFallback(result.reason)
          return
        }
        visibleInHost = false
      } catch {
        await enterError(generation, workspacePath)
      }
    }
  })
}

function scheduleSync(): void {
  if (disposed) return
  if (slotError.value) {
    capturePendingGeometry()
    return
  }
  if (syncScheduled) return
  syncScheduled = true
  const run = (): void => {
    syncScheduled = false
    animationFrame = null
    sync()
  }
  if (typeof window.requestAnimationFrame === 'function') {
    animationFrame = window.requestAnimationFrame(run)
  } else {
    queueMicrotask(run)
  }
}

function retry(): void {
  if (disposed) return
  syncGeneration += 1
  slotError.value = false
  pendingGeometry = null
  invalidateZoomFactor()
  scheduleSync()
}

let observer: ResizeObserver | null = null
onMounted(() => {
  offZoomChanged = window.agentTeam?.onZoomChanged?.(() => {
    invalidateZoomFactor()
    scheduleSync()
  }) ?? null
  observer = new ResizeObserver(() => scheduleSync())
  if (slot.value) observer.observe(slot.value)
  window.addEventListener('scroll', scheduleSync, true)
  window.addEventListener('resize', scheduleSync)
  sync()
})

watch(
  () => [props.workspacePath, props.visible] as const,
  ([workspacePath], [previousWorkspacePath]) => {
    syncGeneration += 1
    if (workspacePath !== previousWorkspacePath) {
      slotError.value = false
      pendingGeometry = null
    }
    sync()
  },
)

onBeforeUnmount(() => {
  disposed = true
  syncGeneration += 1
  offZoomChanged?.()
  offZoomChanged = null
  if (animationFrame !== null) window.cancelAnimationFrame?.(animationFrame)
  animationFrame = null
  syncScheduled = false
  observer?.disconnect()
  window.removeEventListener('scroll', scheduleSync, true)
  window.removeEventListener('resize', scheduleSync)
  queue = queue.then(async () => {
    await window.agentTeam?.closeGitLeftView()
    resetViewState()
  }).catch(() => {})
})
</script>

<template>
  <div ref="slot" class="git-plugin-host-slot" aria-label="Git">
    <GitRecoveryPanel v-if="legacyFallback" :reason="legacyFallbackReason" />
    <div v-else-if="slotError" class="git-plugin-host-slot__error" role="alert" aria-live="polite">
      <span>{{ t('git.left-view-unavailable') }}</span>
      <button type="button" class="ghost" @click="retry">{{ t('action.retry') }}</button>
    </div>
    <span v-else-if="!workspacePath" class="git-plugin-host-slot__empty">{{ t('git.open-workspace') }}</span>
    <!-- The Host composes the v2 panel as a native view stacked over this
         element, so an empty slot is normal *while one is open*. With no view
         open there is nothing left to draw it: a geometry read of 0 makes
         `sync` return without opening anything and without an error, and the
         user is left with the bare "Legacy recovery" label. Give that state a
         terminal face with a way out. -->
    <div v-else-if="!openedWorkspace" class="git-plugin-host-slot__error" role="status" aria-live="polite">
      <span>{{ t('git.left-view-unavailable') }}</span>
      <button type="button" class="ghost" @click="retry">{{ t('action.retry') }}</button>
    </div>
  </div>
</template>

<style scoped>
.git-plugin-host-slot {
  width: 100%;
  height: 100%;
  flex: 1 1 auto;
  min-height: 0;
  position: relative;
  overflow: hidden;
}

.git-plugin-host-slot__empty {
  color: var(--text-secondary);
  display: block;
  font-size: 12px;
  padding: 16px;
}

.git-plugin-host-slot__error {
  align-items: center;
  color: var(--text-secondary);
  display: flex;
  gap: 8px;
  padding: 16px;
}
</style>
