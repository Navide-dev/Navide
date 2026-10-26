import { ref, type Ref } from 'vue'
import { settingsGet } from '@navide/plugin-ui/shared'
import {
  DEFAULT_EDITOR_COMMAND_KEY,
  DEFAULT_EDITOR_ID,
  DEFAULT_EDITOR_SETTING_KEY,
  normalizeDefaultEditor,
} from '../lib/defaultEditor'

// Which built-in Navide plugins (navide.plans, navide.git, navide.mini-ide) the
// user disabled. One module-level set for the whole main window: the sidebar
// tabs, the commands and the "open in editor" entries all read it. The Host
// sends `plugins:contributionsChanged` whenever the switch moves.
const disabled = ref<ReadonlySet<string>>(new Set())
let subscribed = false

async function refresh(): Promise<void> {
  const api = window.agentTeam?.plugins
  if (!api?.disabledBuiltins) return
  try {
    disabled.value = new Set(await api.disabledBuiltins())
  } catch {
    // Not a main window, or the Host is going away: keep the last answer.
  }
}

export function useDisabledBuiltins(): {
  disabled: Ref<ReadonlySet<string>>
  isDisabled: (pluginId: string) => boolean
  refresh: () => Promise<void>
} {
  if (!subscribed) {
    subscribed = true
    void refresh()
    window.agentTeam?.plugins?.onContributionsChanged?.(() => void refresh())
  }
  return { disabled, isDisabled: (pluginId) => disabled.value.has(pluginId), refresh }
}

/** Whether an "open in editor" with this editor id (or the user's default
 *  editor when none is given) can only go to the Mini-IDE, which the user
 *  disabled. Opens that go to an external editor or the system app still work. */
export function isMiniIdeOnlyOpenBlocked(editorId?: string): boolean {
  if (!disabled.value.has('navide.mini-ide')) return false
  const target = editorId ?? normalizeDefaultEditor(
    settingsGet(DEFAULT_EDITOR_SETTING_KEY, DEFAULT_EDITOR_ID),
    settingsGet<string[]>(DEFAULT_EDITOR_COMMAND_KEY, []),
  )
  return target === DEFAULT_EDITOR_ID
}
