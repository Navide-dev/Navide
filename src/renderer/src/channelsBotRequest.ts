// Hand-off from ui.settings.open {tab: "channels", platform, account} (App.vue)
// to the Channels settings page (ChannelsPane.vue). It names the bot to show,
// or a platform whose add-a-bot form to open; a bot the page does not have
// leaves the page on its usual row.
import { shallowRef } from 'vue'

export interface ChannelsBotTarget {
  platform: string
  account: string
  /** Open the add-a-bot form instead: channels_bot_add_open (no request) or
   *  channels_bot_add_fill (the agent's request, its name prefilled). */
  add?: { name: string; requestId: string; requester: string }
}

/** The bot an open request asked to show, until the Channels page takes it. */
export const channelsBotRequest = shallowRef<ChannelsBotTarget | null>(null)

export function requestChannelsBot(target: ChannelsBotTarget): void {
  // A fresh object each time, so asking for the same bot again still
  // triggers the page's watcher.
  channelsBotRequest.value = { ...target }
}

export function takeChannelsBotRequest(): ChannelsBotTarget | null {
  const request = channelsBotRequest.value
  channelsBotRequest.value = null
  return request
}
