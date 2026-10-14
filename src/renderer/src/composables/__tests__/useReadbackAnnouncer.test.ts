import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  READBACK_MERGE_MS,
  isPaneReadback,
  pickReadbackVoice,
  readbackLine,
  readbackVoiceModel,
  voiceQuality,
  setPaneReadback,
  useReadbackAnnouncer,
  type ReadbackItem,
} from '../useVoiceReadback'

// Spoken notices for panes marked 🔊 ("<pane> 完成了" / "<pane> 需要你回答"):
// one queue, events inside the merge window spoken as one line, Esc or the
// dictation hotkey stops it, and the master switch (default off) gates it all.

describe('useReadbackAnnouncer', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  function setup(opts: { enabled?: boolean; marked?: string[]; muted?: string[] } = {}) {
    const enabled = { value: opts.enabled ?? true }
    const marked = new Set(opts.marked ?? ['p1', 'p2', 'p3'])
    const muted = new Set(opts.muted ?? [])
    const spoken: string[] = []
    const ends: Array<() => void> = []
    const cancel = vi.fn()
    const rb = useReadbackAnnouncer({
      enabled: () => enabled.value,
      paneMarked: (id) => marked.has(id),
      paneMuted: (id) => muted.has(id),
      line: (items) => items.map((i) => `${i.paneId}:${i.kind}`).join(','),
      speak: (text, onEnd) => { spoken.push(text); ends.push(onEnd) },
      cancel,
    })
    return { rb, spoken, ends, cancel, enabled }
  }

  it('default off: nothing is queued, spoken, timed or shown', () => {
    const { rb, spoken, cancel } = setup({ enabled: false })
    rb.announce('p1', 'done')
    rb.announce('p2', 'attention')
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(READBACK_MERGE_MS * 4)
    expect(spoken).toEqual([])
    expect(rb.current.value).toBeNull()
    // Nothing playing: Esc is not consumed and the synthesizer is not touched.
    expect(rb.stop()).toBe(false)
    expect(cancel).not.toHaveBeenCalled()
  })

  it('speaks a marked pane after the merge window, and shows it while speaking', () => {
    const { rb, spoken, ends } = setup()
    rb.announce('p1', 'done')
    expect(spoken).toEqual([])
    vi.advanceTimersByTime(READBACK_MERGE_MS)
    expect(spoken).toEqual(['p1:done'])
    expect(rb.current.value).toEqual({ text: 'p1:done', paneIds: ['p1'] })
    ends[0]()
    expect(rb.current.value).toBeNull()
  })

  it('ignores panes not marked 🔊 and panes the user muted', () => {
    const { rb, spoken } = setup({ marked: ['p1', 'p2'], muted: ['p2'] })
    rb.announce('p2', 'done')
    rb.announce('p9', 'attention')
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(READBACK_MERGE_MS)
    expect(spoken).toEqual([])
  })

  it('merges events inside the window into one line; a newer event replaces the same pane', () => {
    const { rb, spoken } = setup()
    rb.announce('p1', 'done')
    rb.announce('p2', 'done')
    rb.announce('p1', 'attention')
    vi.advanceTimersByTime(READBACK_MERGE_MS)
    expect(spoken).toEqual(['p1:attention,p2:done'])
  })

  it('stop cancels speech and anything pending, and reports whether it did', () => {
    const { rb, spoken, cancel } = setup()
    rb.announce('p1', 'done')
    vi.advanceTimersByTime(READBACK_MERGE_MS)
    rb.announce('p2', 'done')
    expect(rb.stop()).toBe(true)
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(rb.current.value).toBeNull()
    vi.advanceTimersByTime(READBACK_MERGE_MS * 2)
    expect(spoken).toEqual(['p1:done'])
    expect(rb.stop()).toBe(false)
  })

  it('a stale end from an interrupted line does not hide the newer one', () => {
    const { rb, ends } = setup()
    rb.announce('p1', 'done')
    vi.advanceTimersByTime(READBACK_MERGE_MS)
    rb.announce('p2', 'done')
    vi.advanceTimersByTime(READBACK_MERGE_MS)
    ends[0]()
    expect(rb.current.value?.paneIds).toEqual(['p2'])
  })

  it('switching off while pending drops the queued line', () => {
    const { rb, spoken, enabled } = setup()
    rb.announce('p1', 'done')
    enabled.value = false
    vi.advanceTimersByTime(READBACK_MERGE_MS)
    expect(spoken).toEqual([])
  })
})

describe('readbackLine', () => {
  const t = (key: string, params?: Record<string, unknown>) => `${key}${params ? JSON.stringify(params) : ''}`
  const label = (id: string) => `L-${id}`
  const line = (items: ReadbackItem[]) => readbackLine(items, label, t)

  it('one pane: names it', () => {
    expect(line([{ paneId: 'a', kind: 'done' }])).toBe('voice.readback.done{"label":"L-a"}')
    expect(line([{ paneId: 'a', kind: 'attention' }])).toBe('voice.readback.attention{"label":"L-a"}')
  })

  it('several panes: counts per kind, joined', () => {
    expect(line([{ paneId: 'a', kind: 'done' }, { paneId: 'b', kind: 'done' }, { paneId: 'c', kind: 'done' }]))
      .toBe('voice.readback.done-many{"n":3}')
    expect(line([{ paneId: 'a', kind: 'done' }, { paneId: 'b', kind: 'attention' }]))
      .toBe('voice.readback.done{"label":"L-a"}voice.readback.separatorvoice.readback.attention{"label":"L-b"}')
  })
})

describe('pickReadbackVoice', () => {
  const v = (name: string, lang: string, voiceURI = name) => ({ name, lang, voiceURI, localService: true })
  const voices = [
    v('Samantha', 'en-US'),
    v('Tingting', 'zh-CN'),
    v('Meijia', 'zh-TW'),
    v('Meijia (Premium)', 'zh-TW'),
    v('Kyoko', 'ja-JP'),
    v('Sinji', 'zh-HK'),
  ]

  it('follows the UI language and prefers the Premium voice of that region', () => {
    expect(pickReadbackVoice(voices, 'zh-TW', '')?.name).toBe('Meijia (Premium)')
    expect(pickReadbackVoice(voices, 'ja-JP', '')?.name).toBe('Kyoko')
    expect(pickReadbackVoice(voices, 'en-US', '')?.name).toBe('Samantha')
  })

  it('falls back to another region of the same language', () => {
    expect(pickReadbackVoice([v('Tingting', 'zh-CN')], 'zh-TW', '')?.name).toBe('Tingting')
    expect(pickReadbackVoice([v('Kyoko', 'ja_JP')], 'ja-JP', '')?.name).toBe('Kyoko')
  })

  it('a chosen voice wins when present; a missing one falls back to auto', () => {
    expect(pickReadbackVoice(voices, 'zh-TW', 'Samantha')?.name).toBe('Samantha')
    expect(pickReadbackVoice(voices, 'zh-TW', 'gone')?.name).toBe('Meijia (Premium)')
  })

  it('no voice for the language: none (the platform default is used)', () => {
    expect(pickReadbackVoice([v('Samantha', 'en-US')], 'ja-JP', '')).toBeNull()
    expect(pickReadbackVoice([], 'zh-TW', '')).toBeNull()
  })
})

describe('pane 🔊 marks', () => {
  it('are off by default and toggle per pane', () => {
    expect(isPaneReadback('x')).toBe(false)
    setPaneReadback('x', true)
    expect(isPaneReadback('x')).toBe(true)
    expect(isPaneReadback('y')).toBe(false)
    setPaneReadback('x', false)
    expect(isPaneReadback('x')).toBe(false)
  })
})

describe('voiceQuality', () => {
  const v = (name: string, voiceURI = name) => ({ name, lang: 'zh-TW', voiceURI })
  it('reads the macOS voice identifier first, then the name', () => {
    expect(voiceQuality(v('Meijia', 'com.apple.voice.premium.zh-TW.Meijia'))).toBe('premium')
    expect(voiceQuality(v('Meijia', 'com.apple.voice.enhanced.zh-TW.Meijia'))).toBe('enhanced')
    expect(voiceQuality(v('Meijia', 'com.apple.voice.compact.zh-TW.Meijia'))).toBe('compact')
    expect(voiceQuality(v('Ava (Premium)'))).toBe('premium')
    expect(voiceQuality(v('Kyoko (Enhanced)'))).toBe('enhanced')
    expect(voiceQuality(v('美佳（高音質）'))).toBe('premium')
    expect(voiceQuality(v('Samantha'))).toBe('compact')
  })

  it('ranks a Premium voice found only by its identifier first', () => {
    const voices = [
      { name: 'Meijia', lang: 'zh-TW', voiceURI: 'com.apple.voice.compact.zh-TW.Meijia' },
      { name: 'Meijia', lang: 'zh-TW', voiceURI: 'com.apple.voice.premium.zh-TW.Meijia' },
    ]
    expect(pickReadbackVoice(voices, 'zh-TW', '')?.voiceURI).toBe('com.apple.voice.premium.zh-TW.Meijia')
  })
})

describe('readbackVoiceModel', () => {
  const v = (name: string, lang: string, voiceURI = name) => ({ name, lang, voiceURI })

  it('zh-TW: 美佳 Premium installed is ready', () => {
    const m = readbackVoiceModel([v('Meijia', 'zh-TW'), v('Meijia (Premium)', 'zh-TW')], 'zh-TW')
    expect(m).toMatchObject({ preferred: '美佳（Premium）', ready: true })
    expect(m.using?.name).toBe('Meijia (Premium)')
  })

  it('zh-TW: only compact 美佳 → not installed, still reads with compact 美佳', () => {
    const m = readbackVoiceModel([v('Tingting', 'zh-CN'), v('Meijia', 'zh-TW', 'com.apple.voice.compact.zh-TW.Meijia')], 'zh-TW')
    expect(m.ready).toBe(false)
    expect(m.using?.name).toBe('Meijia')
  })

  it('en-US prefers Ava, ja-JP prefers Kyoko (Enhanced counts as ready)', () => {
    expect(readbackVoiceModel([v('Ava (Premium)', 'en-US')], 'en-US')).toMatchObject({ preferred: 'Ava (Premium)', ready: true })
    expect(readbackVoiceModel([v('Samantha', 'en-US')], 'en-US')).toMatchObject({ ready: false })
    expect(readbackVoiceModel([v('Kyoko (Enhanced)', 'ja-JP')], 'ja-JP')).toMatchObject({ preferred: 'Kyoko (Enhanced)', ready: true })
  })

  it('a Premium voice of another name is not the preferred one', () => {
    expect(readbackVoiceModel([v('Zoe (Premium)', 'en-US')], 'en-US').ready).toBe(false)
  })

  it('no voices at all: not installed and nothing to read with', () => {
    expect(readbackVoiceModel([], 'zh-TW')).toMatchObject({ ready: false, using: null })
  })
})
