// Hand-off from ui.settings.open {tab: "channels", platform, account} (App.vue)
// to the Channels settings page (ChannelsPane.vue). It only names the bot to
// show; a bot the page does not have leaves the page on its usual row.
import { shallowRef } from 'vue'

export interface ChannelsBotTarget {
  platform: string
  account: string
}

/** The bot an open request asked to show, until the Channels page takes it. */
export const channelsBotRequest = shallowRef<ChannelsBotTarget | null>(null)

export function requestChannelsBot(target: ChannelsBotTarget): void {
  // A fresh object each time, so asking for the same bot again still
  // triggers the page's watcher.
  channelsBotRequest.value = { platform: target.platform, account: target.account }
}

export function takeChannelsBotRequest(): ChannelsBotTarget | null {
  const request = channelsBotRequest.value
  channelsBotRequest.value = null
  return request
}
