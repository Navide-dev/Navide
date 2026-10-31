// Which terminal implementation a pane is built from.
//
// Always xterm.js, except in development builds where a developer names panes
// in localStorage under `navide.dev.nvtermPanes` (a comma-separated list of
// pane ids, `install` for the onboarding install terminal, or `*` for all).
// Those panes are built from nvterm's xterm.js-shaped compatibility layer
// instead. This is an internal testing aid while nvterm is developed on its
// own branch — it is not a user setting, and production builds compile the
// nvterm branch away (import.meta.env.DEV is a build-time constant).
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { SerializeAddon } from '@xterm/addon-serialize'
import { WebglAddon } from '@xterm/addon-webgl'
import { xtermCompat } from '@navide/nvterm'

export interface TerminalKit {
  Terminal: typeof Terminal
  FitAddon: typeof FitAddon
  Unicode11Addon: typeof Unicode11Addon
  SerializeAddon: typeof SerializeAddon
  WebglAddon: typeof WebglAddon
  /** True when the classes come from nvterm. */
  nvterm: boolean
}

export const NVTERM_PANES_KEY = 'navide.dev.nvtermPanes'

const XTERM_KIT: TerminalKit = { Terminal, FitAddon, Unicode11Addon, SerializeAddon, WebglAddon, nvterm: false }

/** Whether the developer flag asks for nvterm in this pane. Always false outside development builds. */
export function nvtermRequestedFor(paneKey: string): boolean {
  if (!import.meta.env.DEV) return false
  try {
    const value = localStorage.getItem(NVTERM_PANES_KEY)
    if (!value) return false
    const keys = value.split(',').map((k) => k.trim())
    return keys.includes('*') || keys.includes(paneKey)
  } catch {
    return false
  }
}

function nvtermKit(): TerminalKit {
  // The compatibility layer matches the xterm.js calls Navide makes, not the
  // whole xterm.js type surface, hence the casts.
  return {
    Terminal: xtermCompat.Terminal as unknown as typeof Terminal,
    FitAddon: xtermCompat.FitAddon as unknown as typeof FitAddon,
    Unicode11Addon: xtermCompat.Unicode11Addon as unknown as typeof Unicode11Addon,
    SerializeAddon: xtermCompat.SerializeAddon as unknown as typeof SerializeAddon,
    WebglAddon: xtermCompat.WebglAddon as unknown as typeof WebglAddon,
    nvterm: true,
  }
}

/** The classes to build a pane's terminal from: xterm.js unless the development flag names this pane. */
export function terminalKit(paneKey: string): TerminalKit {
  if (import.meta.env.DEV && nvtermRequestedFor(paneKey)) return nvtermKit()
  return XTERM_KIT
}
