// Settings → General → Experimental features → "Model arena": whether the
// window offers the arena entries (＋ menu "Compare" block, pane right-click,
// ⌥⌘A). Off by default; off, none of them show and the shortcut does nothing.
//
// Module-scoped ref, like useAcpPrefs: a second window flipping the switch
// repaints this one instead of leaving it on a stale copy.

import { ref } from 'vue'

import { onSettingsChanged, settingsGet, settingsSet } from '@navide/plugin-ui/shared'

export const ARENA_EXPERIMENTAL_KEY = 'modelArenaExperimental'

function load(): boolean {
  return settingsGet<boolean>(ARENA_EXPERIMENTAL_KEY, false) === true
}

const arenaEnabled = ref<boolean>(load())

onSettingsChanged((keys) => {
  if (keys.includes(ARENA_EXPERIMENTAL_KEY)) arenaEnabled.value = load()
})

export function setArenaEnabled(on: boolean): void {
  if (arenaEnabled.value === on) return
  arenaEnabled.value = on
  settingsSet(ARENA_EXPERIMENTAL_KEY, on)
}

export function useArenaPrefs() {
  return { arenaEnabled }
}
