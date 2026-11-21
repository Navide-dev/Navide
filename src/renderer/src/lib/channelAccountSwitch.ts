import { type AgentAccountSwitchAccounts } from './agentAccountSwitch'
import { emailLocalPart } from './accountLabel'

/**
 * A chat's account menu (Telegram /account and the "switch account" button on
 * a usage-limit notice; plan telegram_904bcf): ui.accounts.channelMenu, reached
 * only from the backend's channels layer with the bound pane as caller. It
 * lists the rows the usage badge shows for the CLI — remaining %, stale, signed
 * out — named the way the pane header chip names an account (accountChipLabel):
 * the alias, else the email's local part, else the given name. Never a whole
 * email address or a credential. The switch itself is not made here: the
 * backend runs the shared no-confirm account switch.
 *
 * Only the hot-swap CLI (claude) is offered: its switch restarts nothing.
 */

export const CHANNEL_SWITCH_AGENT = 'claude'
const DEFAULT_SLOT_ID = '__default__'

export interface ChannelAccountRow {
  /** "__default__" for the built-in Default. */
  id: string
  /** The user's alias, the email's local part, or the account's name (an auto-added account's name may be an email; the backend masks it). */
  label: string
  /** The built-in Default with no alias or email: label is the generic "Default", which the chat words in its own language. */
  builtin: boolean
  /** Remaining % of the headline window, or null when there is no reading. */
  remaining: number | null
  stale: boolean
  signedOut: boolean
  active: boolean
}

export interface ChannelAccountDeps {
  accounts: AgentAccountSwitchAccounts & {
    profilesForAgent: (agentKey: string) => { id: string; authKind?: string }[]
    /** Every account in the user's order (null = Default), as automatic switching ranks them. */
    orderedSlotIds: (agentKey: string) => (string | null)[]
    signedOut: (agentKey: string, profileId: string | null) => boolean
    /** The signed-in email, when the CLI reports one. */
    email: (agentKey: string, profileId: string | null) => string | null
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
  const apiKeys = new Set(
    deps.accounts.profilesForAgent(agentKey).filter((p) => p.authKind === 'api-key').map((p) => p.id),
  )
  const ids = deps.accounts.orderedSlotIds(agentKey).filter((id) => id === null || !apiKeys.has(id))
  const rows: ChannelAccountRow[] = ids.map((id) => {
    const usage = deps.usage(agentKey, id)
    const alias = deps.accounts.aliasFor(agentKey, id)
    const email = deps.accounts.email(agentKey, id)
    const named = alias || (email ? emailLocalPart(email) : '') || (id === null ? '' : deps.accounts.findProfile(id)?.name ?? id)
    return {
      id: id ?? DEFAULT_SLOT_ID,
      label: named || 'Default',
      builtin: !named,
      remaining: usage.remaining,
      stale: usage.stale,
      signedOut: deps.accounts.signedOut(agentKey, id),
      active: id === active,
    }
  })
  return { status: 'ok', agentKey, activeId: active ?? DEFAULT_SLOT_ID, fixedCount: deps.fixedCount(), rows }
}
