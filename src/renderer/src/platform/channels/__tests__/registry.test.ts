/**
 * Structural invariants every chat platform spec must hold — the rules
 * `docs/adding-a-chat-channel.md` states in prose.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { CHANNEL_PLATFORM_IDS, CHANNEL_PLATFORM_SPECS, channelPlatform, type ChannelPlatform } from '../index'

// Keep in sync with the backend registry (backend/agent_team_backend/channels/registry.py).
const BACKEND_IDS = ['telegram', 'discord', 'slack', 'feishu', 'dingtalk', 'matrix', 'mattermost', 'imessage']

// Compile-time: a spec annotated `: ChannelPlatformSpec` would widen the union to string.
type IsLiteralUnion<T> = string extends T ? false : true
const PLATFORM_IS_A_LITERAL_UNION: IsLiteralUnion<ChannelPlatform> = true

const LOCALES = ['en-US', 'zh-TW', 'ja-JP'].map((name) => ({
  name,
  messages: JSON.parse(
    readFileSync(resolve(__dirname, `../../../i18n/locales/${name}.json`), 'utf8')
  ) as Record<string, unknown>,
}))

function lookup(messages: Record<string, unknown>, key: string): unknown {
  return key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], messages)
}

describe('chat channel platform registry', () => {
  it('has the same ids, in order, as the backend registry', () => {
    expect(PLATFORM_IS_A_LITERAL_UNION).toBe(true)
    expect([...CHANNEL_PLATFORM_IDS]).toEqual(BACKEND_IDS)
  })

  it('has unique ids and a lookup for each', () => {
    expect(new Set(CHANNEL_PLATFORM_IDS).size).toBe(CHANNEL_PLATFORM_IDS.length)
    for (const id of CHANNEL_PLATFORM_IDS) expect(channelPlatform(id)?.id).toBe(id)
    expect(channelPlatform('nope')).toBeUndefined()
  })

  it.each(CHANNEL_PLATFORM_SPECS.map((s) => [s.id, s] as const))('%s is well formed', (_id, spec) => {
    expect(spec.badge.length).toBeGreaterThan(0)
    expect(spec.link.targets.length).toBeGreaterThan(0)
    expect(spec.link.codeCommand.length).toBeGreaterThan(0)
    // Credential-less platforms must explain themselves.
    if (!spec.fields.length) expect(spec.configNoteKey).toBeTruthy()
    for (const f of spec.fields) expect(f.key.length).toBeGreaterThan(0)
  })

  it('references only i18n keys that exist in every locale', () => {
    const missing: string[] = []
    for (const spec of CHANNEL_PLATFORM_SPECS) {
      const keys = [
        `channels.platform.${spec.id}`,
        `channels.desc.${spec.id}`,
        spec.link.waitingKey,
        spec.link.sendCodeKey('direct'),
        spec.link.sendCodeKey('group'),
        ...spec.link.targets.map((t) => t.label),
        ...spec.fields.map((f) => `channels.field.${f.key}`),
        ...(spec.configNoteKey ? [spec.configNoteKey] : []),
      ]
      for (const { name, messages } of LOCALES) {
        for (const key of keys) {
          if (typeof lookup(messages, key) !== 'string') missing.push(`${name}:${key}`)
        }
      }
    }
    expect(missing).toEqual([])
  })
})
