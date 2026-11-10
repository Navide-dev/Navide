// Settings → CLI Agents → "ACP (experimental)": whether the ＋ menu offers
// agents run over the Agent Client Protocol (ACP panes). Off by default.
//
// The backend reads the same key (acp_vendors.SETTING_KEY) and is where the
// switch takes effect: off, no CLI can be started over ACP at all and the MCP
// tools describe no ACP pane. This ref only decides what the menu offers.
//
// Module-scoped ref, like usePushChannelPrefs: a second window editing the
// switch repaints this one instead of leaving it on a stale copy.

import { ref } from 'vue'

import { onSettingsChanged, settingsGet, settingsSet } from '@navide/plugin-ui/shared'

/** The key both sides agree on — see acp_vendors.SETTING_KEY. */
export const ACP_EXPERIMENTAL_KEY = 'acpExperimental'

/** The CLIs the ＋ menu offers over ACP while the switch is on, and the
 *  adapter each needs installed (acp_vendors.VERIFIED_LAUNCHES). */
export const ACP_MENU_ENTRIES: readonly { agentKey: string; adapterDep: string }[] = [
  { agentKey: 'claude', adapterDep: 'claude-acp' },
]

function load(): boolean {
  return settingsGet<boolean>(ACP_EXPERIMENTAL_KEY, false) === true
}

const acpEnabled = ref<boolean>(load())

onSettingsChanged((keys) => {
  if (keys.includes(ACP_EXPERIMENTAL_KEY)) acpEnabled.value = load()
})

export function setAcpEnabled(on: boolean): void {
  if (acpEnabled.value === on) return
  acpEnabled.value = on
  settingsSet(ACP_EXPERIMENTAL_KEY, on)
}

export function useAcpPrefs() {
  return { acpEnabled }
}
