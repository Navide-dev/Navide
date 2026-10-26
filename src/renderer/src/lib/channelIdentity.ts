// How a channel link and its bot are named wherever the app shows one: the
// pane-header chip and popover, the sidebar marker, the Channel connections list
// and Settings → Channels all build their text here, so a bot reads the same everywhere.

import { DEFAULT_ACCOUNT, type ChannelAccountState, type ChannelBinding } from '../composables/useChannels'

/** Translator shape: vue-i18n's `t` for a bare key. */
export type ChannelIdentityT = (key: string) => string

// The name the user gave the bot, else the display name its platform reports
// (Telegram's getMe first_name, say). A quick-added bot is named after its handle,
// so that copy gives way to the platform's display name when there is one.
function givenOrDisplayName(state: ChannelAccountState): string {
  const { identity, display_name: displayName } = state.status
  return (state.name !== identity && state.name) || displayName || state.name
}

/** The name a bot goes by, falling back to its handle ("@navide_bot"); '' when nothing is known yet. */
export function channelBotName(state: ChannelAccountState | null | undefined): string {
  return state ? givenOrDisplayName(state) || state.status.identity || '' : ''
}

/**
 * A bot slot's label where its handle is already shown beside it (Settings → Channels,
 * the pane popover's bot groups): its name, else the slot's own name.
 */
export function channelBotLabel(
  state: ChannelAccountState | null | undefined,
  account: string,
  t: ChannelIdentityT,
): string {
  return (state && givenOrDisplayName(state)) || (account === DEFAULT_ACCOUNT ? t('channels.bot.default') : account)
}

export interface ChannelIdentityContext {
  t: ChannelIdentityT
  /** The bot the binding talks through (store.accountState). */
  state?: ChannelAccountState | null
  /** The chat, as the caller can name it; '' when unknown. */
  chat?: string
  /** Trailing details for the full form only (a topic, the mirror level). */
  extra?: string[]
}

/**
 * `short`: platform · bot, or platform · chat while the bot has no name yet.
 * `full`: platform · bot · chat · extras, skipping whatever is unknown.
 */
export function formatChannelIdentity(
  binding: Pick<ChannelBinding, 'platform'>,
  ctx: ChannelIdentityContext,
  mode: 'short' | 'full',
): string {
  const platform = ctx.t(`channels.platform.${binding.platform}`)
  const bot = channelBotName(ctx.state)
  const parts = mode === 'short'
    ? [platform, bot || ctx.chat]
    : [platform, bot, ctx.chat, ...(ctx.extra ?? [])]
  return parts.filter(Boolean).join(' · ')
}
