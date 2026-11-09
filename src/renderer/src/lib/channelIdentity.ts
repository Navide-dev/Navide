// How a channel link and its bot are named wherever the app shows one: the
// pane-header chip and popover, the sidebar marker, the Channel connections list
// and Settings → Channels all build their text here, so a bot reads the same everywhere.

import { DEFAULT_ACCOUNT, type ChannelAccountState, type ChannelBinding } from '../composables/useChannels'

/** Translator shape: vue-i18n's `t` for a bare key. */
export type ChannelIdentityT = (key: string) => string

// A name shaped like a handle ("@old_bot") is not a label the user chose: quick add
// once copied the bot's handle into it at first connect, and it went stale when the
// token changed. Such a name, current or old, counts as no label at all.
function customLabel(state: ChannelAccountState): string {
  return state.name.startsWith('@') ? '' : state.name
}

// The name the user gave the bot, else the display name its platform reports
// (Telegram's getMe first_name, say), else whatever name is stored.
function givenOrDisplayName(state: ChannelAccountState): string {
  return customLabel(state) || state.status.display_name || state.name
}

/**
 * The words beside a bot's live handle in a list row: the user's label, else its
 * display name; '' when that would only repeat `shown`.
 */
export function channelBotTag(state: ChannelAccountState, shown: string): string {
  const tag = customLabel(state) || state.status.display_name || ''
  return tag === shown ? '' : tag
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
