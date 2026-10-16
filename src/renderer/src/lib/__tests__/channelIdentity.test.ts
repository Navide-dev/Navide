import { describe, it, expect } from 'vitest'
import type { ChannelAccountState } from '../../composables/useChannels'
import { channelBotLabel, channelBotName, formatChannelIdentity } from '../channelIdentity'

const t = (key: string): string =>
  ({ 'channels.platform.telegram': 'Telegram', 'channels.bot.default': 'Main bot' } as Record<string, string>)[key] ?? key

function bot(name: string, identity: string, displayName?: string): ChannelAccountState {
  return {
    account: 'default',
    name,
    configured: true,
    enabled: true,
    status: {
      lifecycle: 'ready', connected: true, reconnect_attempts: 0, last_error: '',
      last_connected_at: null, last_inbound_at: null, identity, display_name: displayName,
    },
    config: {},
    capabilities: null,
  }
}

const tg = { platform: 'telegram' as const }

describe('channelBotName', () => {
  it('prefers the name the user gave the bot', () => {
    expect(channelBotName(bot('Neil-m4', '@neil_m4_bot', 'Neil M4'))).toBe('Neil-m4')
  })

  it("uses the platform's display name for an unnamed bot", () => {
    expect(channelBotName(bot('', '@neil_m4_bot', 'Neil M4'))).toBe('Neil M4')
  })

  it('treats a name copied from the handle as unnamed', () => {
    expect(channelBotName(bot('@neil_m4_bot', '@neil_m4_bot', 'Neil M4'))).toBe('Neil M4')
  })

  it('keeps a name copied from the handle when the platform reports no display name', () => {
    expect(channelBotName(bot('@ops_bot', '@ops_bot'))).toBe('@ops_bot')
  })

  it('falls back to the handle, then to nothing', () => {
    expect(channelBotName(bot('', '@neil_m4_bot'))).toBe('@neil_m4_bot')
    expect(channelBotName(bot('', ''))).toBe('')
    expect(channelBotName(null)).toBe('')
  })
})

describe('formatChannelIdentity', () => {
  it('short names the platform and the bot, never the chat user', () => {
    const ctx = { t, state: bot('', '@neil_m4_bot', 'Neil M4'), chat: 'neillu123' }
    expect(formatChannelIdentity(tg, ctx, 'short')).toBe('Telegram · Neil M4')
  })

  it('short falls back to the chat while the bot has no name, then to the platform', () => {
    expect(formatChannelIdentity(tg, { t, state: bot('', ''), chat: 'neillu123' }, 'short')).toBe('Telegram · neillu123')
    expect(formatChannelIdentity(tg, { t }, 'short')).toBe('Telegram')
  })

  it('full keeps every known detail in order', () => {
    const ctx = { t, state: bot('', '@neil_m4_bot', 'Neil M4'), chat: 'neillu123', extra: ['', 'Full'] }
    expect(formatChannelIdentity(tg, ctx, 'full')).toBe('Telegram · Neil M4 · neillu123 · Full')
  })
})

describe('channelBotLabel', () => {
  it('names the bot without repeating the handle shown beside it', () => {
    expect(channelBotLabel(bot('Ops', '@ops_bot', 'Ops Bot'), 'b1', t)).toBe('Ops')
    expect(channelBotLabel(bot('', '@ops_bot', 'Ops Bot'), 'b1', t)).toBe('Ops Bot')
  })

  it("falls back to the slot's own name", () => {
    expect(channelBotLabel(bot('', '@ops_bot'), 'default', t)).toBe('Main bot')
    expect(channelBotLabel(bot('', '@ops_bot'), 'b1', t)).toBe('b1')
    expect(channelBotLabel(null, 'b1', t)).toBe('b1')
  })
})
