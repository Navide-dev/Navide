import { agentFacingAccountName, type AgentAccountSwitchAccounts } from './agentAccountSwitch'

/**
 * A chat's account menu (Telegram /account and the "switch account" button on
 * a usage-limit notice; plan telegram_904bcf): ui.accounts.channelMenu, reached
 * only from the backend's channels layer with the bound pane as caller. It
 * lists the rows the usage badge shows for the CLI — remaining %, stale, signed
 * out — never an email or a credential. The switch itself is not made here: the
 * backend runs the shared no-confirm account switch.
 *
 * Only the hot-swap CLI (claude) is offered: its switch restarts nothing.
 */

export const CHANNEL_SWITCH_AGENT = 'claude'
const DEFAULT_SLOT_ID = '__default__'

export interface ChannelAccountRow {
  /** "__default__" for the built-in Default. */
  id: string
  /** The user's alias or the account's name (an auto-added account's name may be an email; the backend masks it). */
  label: string
  /** Remaining % of the headline window, or null when there is no reading. */
  remaining: number | null
  stale: boolean
  signedOut: boolean
  active: boolean
}

export interface ChannelAccountDeps {
  accounts: AgentAccountSwitchAccounts & {
    profilesForAgent: (agentKey: string) => { id: string; authKind?: string }[]
    signedOut: (agentKey: string, profileId: string | null) => boolean
  }
  /** remainingPercent(accountUsageFor(...)) and its stale flag, as the badge reads them. */
  usage: (agentKey: string, profileId: string | null) => { remaining: number | null; stale: boolean }
  /** Panes running inside an account's own folder: a live switch does not move them. */
  fixedCount: () => number
}

export function channelAccountMenu(args: Record<string, unknown>, deps: ChannelAccountDeps): Record<string, unknown> {
  const agentKey = String(args.agentKey ?? '')
  if (agentKey !== CHANNEL_SWITCH_AGENT) return { status: 'unsupported', agentKey }
  const active = deps.accounts.defaultProfileId(agentKey)
  const ids: (string | null)[] = [
    null,
    ...deps.accounts.profilesForAgent(agentKey).filter((p) => p.authKind !== 'api-key').map((p) => p.id),
  ]
  const rows: ChannelAccountRow[] = ids.map((id) => {
    const usage = deps.usage(agentKey, id)
    return {
      id: id ?? DEFAULT_SLOT_ID,
      label: agentFacingAccountName(deps.accounts, agentKey, id),
      remaining: usage.remaining,
      stale: usage.stale,
      signedOut: deps.accounts.signedOut(agentKey, id),
      active: id === active,
    }
  })
  return { status: 'ok', agentKey, activeId: active ?? DEFAULT_SLOT_ID, fixedCount: deps.fixedCount(), rows }
}
