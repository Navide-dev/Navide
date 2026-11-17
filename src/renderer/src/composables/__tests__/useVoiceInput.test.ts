import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  VOICE_ERROR_CODES,
  voiceErrorI18nKey,
  ERROR_VISIBLE_MS,
  MAX_RECORDING_MS,
  HANDS_FREE_MAX_MS,
  RELEASE_TAIL_MS,
  useVoiceInput,
  type VoiceDeps,
  type VoiceTarget,
} from '../useVoiceInput'

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve()
  await nextTick()
}

interface Harness {
  deps: VoiceDeps
  requests: Array<{ type: string; payload: Record<string, unknown> }>
  inserted: Array<{ paneId: string; text: string }>
  /** `submit` of every insert call, taken or not. */
  submits: boolean[]
  /** What the pane reports about a requested Enter (after a microtask);
   *  null: never reports. */
  submitResult: boolean | null
  insertOk: boolean
  onChunk: ((pcm: Int16Array) => void) | null
  onEnded: (() => void) | null
  captureClosed: number
  enabled: boolean
  stopText: string
  targets: Record<string, VoiceTarget>
  logs: string[]
  stopExtra: Record<string, unknown>
}

function harness(): Harness {
  const h: Harness = {
    requests: [],
    inserted: [],
    submits: [],
    submitResult: true,
    insertOk: true,
    onChunk: null,
    onEnded: null,
    captureClosed: 0,
    enabled: true,
    stopText: '幫我跑測試',
    targets: { p1: { ok: true } },
    logs: [],
    stopExtra: {},
    deps: null as unknown as VoiceDeps,
  }
  h.deps = {
    enabled: () => h.enabled,
    request: async (type, payload) => {
      h.requests.push({ type, payload })
      if (type === 'voice.start') return { ok: true, payload: { ok: true, sessionId: 's1' } as never }
      if (type === 'voice.stop') {
        return { ok: true, payload: { ok: true, text: h.stopText, ms: 10, durationMs: 900, peak: 3000, ...h.stopExtra } as never }
      }
      return { ok: true, payload: { ok: true } as never }
    },
    askMicrophone: async () => ({ granted: true, prompted: false }),
    openCapture: async (onChunk, onEnded) => {
      h.onChunk = onChunk
      h.onEnded = onEnded
      return {
        flush: async () => { onChunk(Int16Array.from([7, 8])) },
        close: () => { h.captureClosed++ },
      }
    },
    resolveTarget: (paneId) => h.targets[paneId] ?? { ok: false, reason: 'not-cli' },
    insert: (paneId, text, opts) => {
      h.submits.push(opts.submit)
      const result = h.submitResult
      if (h.insertOk && opts.submit && result !== null) queueMicrotask(() => opts.onSubmit?.(result))
      if (h.insertOk) h.inserted.push({ paneId, text })
      return h.insertOk
    },
    log: (line) => h.logs.push(line),
  }
  return h
}

const types = (h: Harness): string[] => h.requests.map((r) => r.type)

/** Let go of the key and let the release tail run out. */
async function releaseAndStop(v: ReturnType<typeof useVoiceInput>, reason?: string): Promise<void> {
  v.release(reason)
  vi.advanceTimersByTime(RELEASE_TAIL_MS)
  await settle()
}

describe('useVoiceInput — capsule state machine', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('engineLoading holds from the mic opening until voice.start answers (a cold sidecar), audio buffered meanwhile', async () => {
    const h = harness()
    let answer: ((r: { ok: boolean; payload: never }) => void) | null = null
    const base = h.deps.request
    h.deps.request = (type, payload, timeoutMs) =>
      type === 'voice.start'
        ? new Promise((resolve) => { h.requests.push({ type, payload }); answer = resolve })
        : base(type, payload, timeoutMs)
    const v = useVoiceInput(h.deps)
    v.press('p1')
    await settle()
    expect(v.state.phase).toBe('recording')
    expect(v.state.engineLoading).toBe(true)
    h.onChunk!(Int16Array.from([1, 2]))
    expect(types(h)).toEqual(['voice.start'])
    answer!({ ok: true, payload: { ok: true, sessionId: 's1' } as never })
    await settle()
    expect(v.state.engineLoading).toBe(false)
    expect(types(h)).toEqual(['voice.start', 'voice.chunk'])
    v.cancel()
    await settle()
    expect(v.state.engineLoading).toBe(false)
  })

  it('press → recording → release → transcribing → text inserted at once, no countdown', async () => {
    const h = harness()
    const v = useVoiceInput(h.deps)
    expect(v.press('p1')).toBe(true)
    expect(v.state.phase).toBe('starting')
    expect(v.state.paneId).toBe('p1')
    await settle()
    expect(v.state.phase).toBe('recording')

    h.onChunk!(Int16Array.from([1, 2, 3]))
    v.release()
    // The tail keeps recording for a moment after the key is let go.
    expect(v.state.phase).toBe('recording')
    vi.advanceTimersByTime(RELEASE_TAIL_MS - 1)
    expect(v.state.phase).toBe('recording')
    vi.advanceTimersByTime(1)
    expect(v.state.phase).toBe('transcribing')
    await settle()
    expect(h.inserted).toEqual([{ paneId: 'p1', text: '幫我跑測試' }])
    expect(v.state.phase).toBe('idle')
    expect(v.visible.value).toBe(false)
    expect(h.captureClosed).toBe(1)

    const chunks = h.requests.filter((r) => r.type === 'voice.chunk')
    expect(chunks.map((c) => c.payload.seq)).toEqual([0, 1])
    expect(chunks.every((c) => c.payload.sessionId === 's1' && typeof c.payload.pcm === 'string')).toBe(true)
    // The flushed tail went out before voice.stop.
    expect(types(h).indexOf('voice.stop')).toBeGreaterThan(types(h).lastIndexOf('voice.chunk'))
    expect(h.requests.find((r) => r.type === 'voice.stop')!.payload).toEqual({ sessionId: 's1', language: 'zh' })
  })

  it('a microphone unplugged mid-take ends it with an error, not a silent listen', async () => {
    const h = harness()
    const v = useVoiceInput(h.deps)
    v.press('p1', { handsFree: true })
    await settle()
    expect(v.state.phase).toBe('recording')
    h.onEnded?.()
    expect(v.state.phase).toBe('error')
    expect(v.state.error?.key).toBe('mic-disconnected')
    expect(h.captureClosed).toBe(1)
    expect(h.requests.at(-1)).toEqual({ type: 'voice.cancel', payload: { sessionId: 's1' } })
  })

  it('a transcript with line breaks is inserted as one line: never a CR that would submit', async () => {
    const h = harness()
    h.stopText = ' 第一句\n第二句\r\n第三句 \n'
    const v = useVoiceInput(h.deps)
    v.press('p1')
    await settle()
    await releaseAndStop(v)
    expect(h.inserted).toEqual([{ paneId: 'p1', text: '第一句 第二句 第三句' }])
    expect(h.inserted[0].text).not.toMatch(/[\r\n]/)
  })

  it('shows partials: committed text grows, the tentative tail is replaced, stale or foreign events are ignored', async () => {
    const h = harness()
    const v = useVoiceInput(h.deps)
    v.press('p1')
    // Before the session exists nothing is taken.
    v.partial({ sessionId: 's1', seq: 0, committed: 'x', tentative: '' })
    await settle()
    expect(v.state.committed).toBe('')

    v.partial({ sessionId: 's1', seq: 0, committed: '', tentative: '幫我' })
    expect(v.state.committed).toBe('')
    expect(v.state.tentative).toBe('幫我')
    v.partial({ sessionId: 's1', seq: 1, committed: '幫我跑', tentative: '側' })
    expect(v.state.committed).toBe('幫我跑')
    expect(v.state.tentative).toBe('側')
    // Older seq: ignored.
    v.partial({ sessionId: 's1', seq: 1, committed: '幫我跑', tentative: '別的' })
    v.partial({ sessionId: 's1', seq: 0, committed: '', tentative: '舊' })
    expect(v.state.tentative).toBe('側')
    // Another session: ignored.
    v.partial({ sessionId: 's9', seq: 5, committed: '幫我跑測試了', tentative: '' })
    expect(v.state.committed).toBe('幫我跑')
    // Committed text is never rewritten.
    v.partial({ sessionId: 's1', seq: 2, committed: '幫你跑', tentative: '' })
    expect(v.state.committed).toBe('幫我跑')
    expect(v.state.tentative).toBe('側')
    v.partial({ sessionId: 's1', seq: 3, committed: '幫我跑測試', tentative: '' })
    expect(v.state.committed).toBe('幫我跑測試')
    expect(v.state.tentative).toBe('')

    // Still shown while transcribing; cleared once the final text is inserted.
    await releaseAndStop(v)
    expect(v.state.committed).toBe('')
    expect(h.inserted).toEqual([{ paneId: 'p1', text: '幫我跑測試' }])
  })

  it('a take with no partials at all still inserts the final text', async () => {
    const h = harness()
    const v = useVoiceInput(h.deps)
    v.press('p1')
    await settle()
    await releaseAndStop(v)
    expect(h.inserted).toEqual([{ paneId: 'p1', text: '幫我跑測試' }])
  })

  it('Esc while recording cancels the backend session and frees the mic', async () => {
    const h = harness()
    const v = useVoiceInput(h.deps)
    v.press('p1')
    await settle()
    v.partial({ sessionId: 's1', seq: 0, committed: '幫我', tentative: '' })
    expect(v.cancel()).toBe(true)
    expect(v.state.phase).toBe('idle')
    expect(v.state.committed).toBe('')
    expect(h.captureClosed).toBe(1)
    expect(h.requests.at(-1)).toEqual({ type: 'voice.cancel', payload: { sessionId: 's1' } })
    // A late release does nothing.
    await releaseAndStop(v)
    expect(types(h)).not.toContain('voice.stop')
    expect(h.inserted).toEqual([])
  })

  it('Esc while transcribing discards the result when it lands', async () => {
    const h = harness()
    let answer!: (v: unknown) => void
    const base = h.deps.request
    h.deps.request = (type, payload, t) =>
      type === 'voice.stop'
        ? new Promise((r) => { answer = r as never; h.requests.push({ type, payload }) })
        : base(type, payload, t)
    const v = useVoiceInput(h.deps)
    v.press('p1')
    await settle()
    await releaseAndStop(v)
    expect(v.state.phase).toBe('transcribing')
    expect(v.cancel()).toBe(true)
    answer({ ok: true, payload: { ok: true, text: 'late' } })
    await settle()
    expect(v.state.phase).toBe('idle')
    expect(h.inserted).toEqual([])
  })

  it('a pane that could not take the text (preparing, exited) keeps it on screen until dismissed', async () => {
    const h = harness()
    h.insertOk = false
    const v = useVoiceInput(h.deps)
    v.press('p1')
    await settle()
    await releaseAndStop(v)
    expect(v.state.phase).toBe('error')
    expect(v.state.error).toEqual({ key: 'insert-failed', params: undefined, text: '幫我跑測試' })
    expect(h.logs.at(-1)).toContain('outcome=insert-failed')
    // Not timed out: the transcript exists nowhere else.
    vi.advanceTimersByTime(ERROR_VISIBLE_MS * 10)
    expect(v.state.error?.text).toBe('幫我跑測試')
    v.dismiss()
    expect(v.state.phase).toBe('idle')
  })

  it('a pane reclaimed during the take also keeps the transcript', async () => {
    const h = harness()
    const v = useVoiceInput(h.deps)
    v.press('p1')
    await settle()
    h.targets.p1 = { ok: false, reason: 'asleep' }
    await releaseAndStop(v)
    expect(v.state.error?.key).toBe('pane-asleep')
    expect(v.state.error?.text).toBe('幫我跑測試')
    expect(h.inserted).toEqual([])
  })

  it('Esc is not taken by an error capsule or by no capsule; the close button and the timeout clear it', async () => {
    const h = harness()
    h.targets.p1 = { ok: false, reason: 'asleep' }
    const v = useVoiceInput(h.deps)
    expect(v.cancel()).toBe(false)
    v.press('p1')
    expect(v.state.phase).toBe('error')
    expect(v.cancel()).toBe(false)
    expect(v.state.phase).toBe('error')
    v.dismiss()
    expect(v.state.phase).toBe('idle')
    v.press('p1')
    vi.advanceTimersByTime(ERROR_VISIBLE_MS)
    expect(v.state.phase).toBe('idle')
  })

  it('refuses a sleeping (placeholder) pane without touching the mic or backend', async () => {
    const h = harness()
    h.targets.p2 = { ok: false, reason: 'asleep' }
    let micAsked = false
    h.deps.askMicrophone = async () => { micAsked = true; return { granted: true, prompted: false } }
    const v = useVoiceInput(h.deps)
    expect(v.press('p2')).toBe(true)
    await settle()
    expect(v.state.phase).toBe('error')
    expect(v.state.paneId).toBe('p2')
    expect(v.state.error?.key).toBe('pane-asleep')
    expect(micAsked).toBe(false)
    expect(h.requests).toEqual([])
  })

  it('re-checks the target before inserting: a pane reclaimed during the take is refused', async () => {
    const h = harness()
    const v = useVoiceInput(h.deps)
    v.press('p1')
    await settle()
    h.targets.p1 = { ok: false, reason: 'asleep' }
    await releaseAndStop(v)
    expect(h.inserted).toEqual([])
    expect(v.state.error?.key).toBe('pane-asleep')
  })

  it('release before the mic is open still ends the take once it opens (after the tail)', async () => {
    const h = harness()
    const v = useVoiceInput(h.deps)
    v.press('p1')
    await releaseAndStop(v)
    expect(v.state.phase).toBe('recording')
    expect(types(h)).not.toContain('voice.stop')
    vi.advanceTimersByTime(RELEASE_TAIL_MS)
    await settle()
    expect(types(h)).toContain('voice.stop')
    expect(h.inserted).toHaveLength(1)
  })

  it('key repeat is swallowed', async () => {
    const h = harness()
    const v = useVoiceInput(h.deps)
    v.press('p1')
    await settle()
    expect(v.press('p1')).toBe(true)
    expect(types(h).filter((t) => t === 'voice.start')).toHaveLength(1)
  })

  it('empty transcript and backend refusals end in an error, not a delivery', async () => {
    const h = harness()
    h.stopText = '   '
    const v = useVoiceInput(h.deps)
    v.press('p1')
    await settle()
    await releaseAndStop(v)
    expect(v.state.error?.key).toBe('no-speech')

    const h2 = harness()
    h2.deps.request = async (type) =>
      ({ ok: true, payload: type === 'voice.start' ? { ok: false, reason: 'model-missing' } : { ok: true } }) as never
    const v2 = useVoiceInput(h2.deps)
    v2.press('p1')
    await settle()
    expect(v2.state.error?.key).toBe('start-model-missing')
  })

  it('voice.start carries the chosen Chinese script, and nothing without one', async () => {
    const h = harness()
    const v = useVoiceInput({ ...h.deps, script: () => 'hans' })
    v.press('p1')
    await settle()
    expect(h.requests.find((r) => r.type === 'voice.start')?.payload).toEqual({ script: 'hans' })
    const bare = harness()
    useVoiceInput(bare.deps).press('p1')
    await settle()
    expect(bare.requests.find((r) => r.type === 'voice.start')?.payload).toEqual({})
  })

  it('mic denial stops before voice.start', async () => {
    const h = harness()
    h.deps.askMicrophone = async () => ({ granted: false, prompted: false })
    const v = useVoiceInput(h.deps)
    v.press('p1')
    await settle()
    expect(v.state.error?.key).toBe('mic-denied')
    expect(types(h)).not.toContain('voice.start')
  })

  it('stops by itself at the 60 s cap', async () => {
    const h = harness()
    const v = useVoiceInput(h.deps)
    v.press('p1')
    await settle()
    vi.advanceTimersByTime(MAX_RECORDING_MS)
    await settle()
    expect(types(h)).toContain('voice.stop')
    expect(h.inserted).toHaveLength(1)
  })

  it('disable() drops a running take', async () => {
    const h = harness()
    const v = useVoiceInput(h.deps)
    v.press('p1')
    await settle()
    v.disable()
    expect(v.state.phase).toBe('idle')
    expect(h.captureClosed).toBe(1)
    expect(types(h)).toContain('voice.cancel')
  })

  it('setting OFF: press declines and nothing runs', async () => {
    const h = harness()
    h.enabled = false
    let captured = false
    h.deps.openCapture = async () => { captured = true; throw new Error('no') }
    const v = useVoiceInput(h.deps)
    expect(v.press('p1')).toBe(false)
    await settle()
    expect(v.state.phase).toBe('idle')
    expect(h.requests).toEqual([])
    expect(captured).toBe(false)
  })
})

describe('useVoiceInput — capture during start-up, endings and diagnostics', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  const samples = (b64: unknown): number[] => {
    const buf = Buffer.from(String(b64), 'base64')
    return Array.from({ length: buf.length / 2 }, (_, i) => buf.readInt16LE(i * 2))
  }

  /** voice.start answers only when `answer` is called. */
  function slowStart(h: Harness): (reply?: Record<string, unknown>) => void {
    let answer!: (v: unknown) => void
    const base = h.deps.request
    h.deps.request = (type, payload, t) => {
      if (type !== 'voice.start') return base(type, payload, t)
      h.requests.push({ type, payload })
      return new Promise((r) => { answer = r as never })
    }
    return (reply = { ok: true, sessionId: 's1' }) => answer({ ok: true, payload: reply })
  }

  it('opens the mic before voice.start answers and flushes the early chunks in order', async () => {
    const h = harness()
    const answer = slowStart(h)
    const v = useVoiceInput(h.deps)
    v.press('p1')
    await settle()
    // Recording while the sidecar is still loading.
    expect(v.state.phase).toBe('recording')
    h.onChunk!(Int16Array.from([1, 1]))
    h.onChunk!(Int16Array.from([2, 2]))
    expect(types(h)).toEqual(['voice.start'])
    answer()
    await settle()
    h.onChunk!(Int16Array.from([3, 3]))
    const chunks = h.requests.filter((r) => r.type === 'voice.chunk')
    expect(chunks.map((c) => c.payload.seq)).toEqual([0, 1, 2])
    expect(chunks.map((c) => samples(c.payload.pcm))).toEqual([[1, 1], [2, 2], [3, 3]])
    expect(chunks.every((c) => c.payload.sessionId === 's1')).toBe(true)
  })

  it('a release while the sidecar is still loading sends the buffered audio and the tail, then stops', async () => {
    const h = harness()
    const answer = slowStart(h)
    const v = useVoiceInput(h.deps)
    v.press('p1')
    await settle()
    h.onChunk!(Int16Array.from([5]))
    await releaseAndStop(v)
    expect(v.state.phase).toBe('transcribing')
    expect(types(h)).toEqual(['voice.start'])
    answer()
    await settle()
    // Early chunk, the flushed tail, then stop.
    expect(types(h)).toEqual(['voice.start', 'voice.chunk', 'voice.chunk', 'voice.stop'])
    expect(h.inserted).toHaveLength(1)
  })

  it('a failed voice.start after the mic opened frees the mic', async () => {
    const h = harness()
    const answer = slowStart(h)
    const v = useVoiceInput(h.deps)
    v.press('p1')
    await settle()
    answer({ ok: false, reason: 'sidecar-failed' })
    await settle()
    expect(v.state.error?.key).toBe('start-sidecar-failed')
    expect(h.captureClosed).toBe(1)
  })

  it('an abandoned start is cancelled once it answers', async () => {
    const h = harness()
    const answer = slowStart(h)
    const v = useVoiceInput(h.deps)
    v.press('p1')
    await settle()
    expect(v.cancel()).toBe(true)
    answer()
    await settle()
    expect(h.requests.at(-1)).toEqual({ type: 'voice.cancel', payload: { sessionId: 's1' } })
  })

  it('silent input, no words and a slip of the key end three different ways', async () => {
    const silent = harness()
    silent.stopText = ''
    silent.stopExtra = { durationMs: 1500, peak: 0 }
    const v1 = useVoiceInput(silent.deps)
    v1.press('p1')
    await settle()
    await releaseAndStop(v1)
    expect(v1.state.error?.key).toBe('mic-silent')

    const quiet = harness()
    quiet.stopText = ''
    quiet.stopExtra = { durationMs: 1500, peak: 900 }
    const v2 = useVoiceInput(quiet.deps)
    v2.press('p1')
    await settle()
    await releaseAndStop(v2)
    expect(v2.state.error?.key).toBe('no-speech')

    const short = harness()
    short.stopText = ''
    short.stopExtra = { durationMs: 120, peak: 0 }
    const v3 = useVoiceInput(short.deps)
    v3.press('p1')
    await settle()
    await releaseAndStop(v3)
    expect(v3.state.phase).toBe('idle')
    expect(v3.state.error).toBeNull()
    expect(short.logs.at(-1)).toContain('outcome=too-short')
  })

  it('the press that showed the first-time mic dialog only authorises', async () => {
    const h = harness()
    h.deps.askMicrophone = async () => ({ granted: true, prompted: true })
    let opened = false
    h.deps.openCapture = async () => { opened = true; throw new Error('no') }
    const v = useVoiceInput(h.deps)
    v.press('p1')
    await settle()
    expect(v.state.phase).toBe('error')
    expect(v.state.error?.key).toBe('mic-authorized')
    expect(h.requests).toEqual([])
    expect(opened).toBe(false)
  })

  it('lock() turns a held take hands-free with the long cap; release then ends it', async () => {
    const h = harness()
    const v = useVoiceInput(h.deps)
    v.press('p1')
    await settle()
    expect(v.lock()).toBe(true)
    expect(v.state.handsFree).toBe(true)
    vi.advanceTimersByTime(MAX_RECORDING_MS + 1_000)
    await settle()
    expect(v.state.phase).toBe('recording')
    await releaseAndStop(v, 'toggle')
    expect(h.inserted).toHaveLength(1)
    expect(h.logs.at(-1)).toContain('end=toggle')
    expect(h.logs.at(-1)).toContain('mode=hands-free')
  })

  it('a hands-free take stops by itself at the 5 minute cap', async () => {
    const h = harness()
    const v = useVoiceInput(h.deps)
    v.press('p1', { handsFree: true })
    await settle()
    expect(v.state.capEndsAt - Date.now()).toBe(HANDS_FREE_MAX_MS)
    vi.advanceTimersByTime(HANDS_FREE_MAX_MS - 1)
    await settle()
    expect(v.state.phase).toBe('recording')
    vi.advanceTimersByTime(1)
    await settle()
    expect(h.inserted).toHaveLength(1)
    expect(h.logs.at(-1)).toContain('end=cap')
  })

  it('a capped hands-free take is inserted like any other: nothing waits to be sent', async () => {
    const h = harness()
    const v = useVoiceInput(h.deps)
    v.press('p1', { handsFree: true })
    await settle()
    vi.advanceTimersByTime(HANDS_FREE_MAX_MS)
    await settle()
    expect(h.inserted).toEqual([{ paneId: 'p1', text: '幫我跑測試' }])
    expect(v.state.phase).toBe('idle')
    // The next press starts a new take rather than acting on the old one.
    expect(v.press('p1')).toBe(true)
    expect(v.state.phase).toBe('starting')
  })

  it('says so while the system default stands in for a missing chosen microphone', async () => {
    const h = harness()
    h.deps.openCapture = async () => ({ flush: async () => {}, close: () => {}, fellBack: true })
    const v = useVoiceInput(h.deps)
    v.press('p1')
    await settle()
    expect(v.state.phase).toBe('recording')
    expect(v.state.deviceFallback).toBe(true)
    v.cancel()
    expect(v.state.deviceFallback).toBe(false)
  })

  it('names the recording microphone in the silent and disconnected errors', async () => {
    const withLabel = (h: Harness, deviceLabel: string, fellBack = false): void => {
      const open = h.deps.openCapture
      h.deps.openCapture = async (onChunk, onEnded) => ({ ...(await open(onChunk, onEnded)), deviceLabel, fellBack })
    }
    const silent = harness()
    silent.stopText = ''
    silent.stopExtra = { durationMs: 1500, peak: 0 }
    withLabel(silent, 'Neil’s AirPods 4')
    const v1 = useVoiceInput(silent.deps)
    v1.press('p1')
    await settle()
    expect(v1.state.deviceLabel).toBe('Neil’s AirPods 4')
    await releaseAndStop(v1)
    expect(v1.state.error).toEqual({ key: 'mic-silent-device', params: { device: 'Neil’s AirPods 4' } })

    const unplugged = harness()
    withLabel(unplugged, 'USB Mic')
    const v2 = useVoiceInput(unplugged.deps)
    v2.press('p1', { handsFree: true })
    await settle()
    unplugged.onEnded?.()
    expect(v2.state.error).toEqual({ key: 'mic-disconnected-device', params: { device: 'USB Mic' } })
  })

  it('falls back to the saved device label, never for a fallback capture, and keeps the plain sentence when unnamed', async () => {
    const saved = harness()
    saved.stopText = ''
    saved.stopExtra = { durationMs: 1500, peak: 0 }
    saved.deps.savedDeviceLabel = () => 'Studio Mic'
    const v1 = useVoiceInput(saved.deps)
    v1.press('p1')
    await settle()
    await releaseAndStop(v1)
    expect(v1.state.error).toEqual({ key: 'mic-silent-device', params: { device: 'Studio Mic' } })

    const fellBack = harness()
    fellBack.deps.savedDeviceLabel = () => 'Studio Mic'
    const open = fellBack.deps.openCapture
    fellBack.deps.openCapture = async (onChunk, onEnded) => ({ ...(await open(onChunk, onEnded)), fellBack: true })
    const v2 = useVoiceInput(fellBack.deps)
    v2.press('p1')
    await settle()
    expect(v2.state.deviceLabel).toBe('')
    fellBack.onEnded?.()
    expect(v2.state.error).toEqual({ key: 'mic-disconnected', params: undefined })
  })

  it('logs one line per take with timings, end reason, audio length and peak', async () => {
    const h = harness()
    const v = useVoiceInput(h.deps)
    v.press('p1')
    await settle()
    h.onChunk!(Int16Array.from({ length: 1600 }, (_, i) => (i === 3 ? -1234 : 10)))
    await releaseAndStop(v, 'keyup:KeyM')
    expect(h.logs).toHaveLength(1)
    const line = h.logs[0]
    expect(line).toMatch(/^\[voice\] outcome=text end=keyup:KeyM mode=hold mic=\d+ms capture=\d+ms session=\d+ms release=\d+ms stop=\d+ms /)
    // 1600 samples + the 2-sample flush at 16 kHz.
    expect(line).toContain('audio=100ms')
    expect(line).toContain('peak=1234')
    vi.advanceTimersByTime(ERROR_VISIBLE_MS)
    expect(h.logs).toHaveLength(1)
  })

  it('shows the input level while recording', async () => {
    const h = harness()
    const v = useVoiceInput(h.deps)
    v.press('p1')
    await settle()
    expect(v.state.level).toBe(0)
    h.onChunk!(Int16Array.from({ length: 400 }, () => 8000))
    expect(v.state.level).toBeGreaterThan(0.5)
    h.onChunk!(Int16Array.from({ length: 400 }, () => 0))
    expect(v.state.level).toBe(0)
  })
})

describe('voice error sentences', () => {
  const locales = ['en-US', 'ja-JP', 'zh-TW'].map((l) => ({
    l,
    data: JSON.parse(
      readFileSync(join(process.cwd(), `src/renderer/src/i18n/locales/${l}.json`), 'utf-8'),
    ) as { voice: { error: Record<string, string> } },
  }))

  // Reasons each handler can answer with, read from the backend source so a
  // new reason there fails here instead of showing a bare code to the user.
  function backendReasons(fn: string): string[] {
    const src = readFileSync(join(process.cwd(), 'backend/agent_team_backend/voice_handlers.py'), 'utf-8')
    const start = src.indexOf(`async def ${fn}(`)
    const end = src.indexOf('\nasync def ', start + 1)
    const body = src.slice(start, end === -1 ? undefined : end)
    return [...body.matchAll(/"([a-z]+(?:-[a-z]+)*)"/g)]
      .map((m) => m[1])
      .filter((r) => body.includes(`"reason": "${r}"`) || body.includes(`"${r}" if`) || body.includes(`else "${r}"`))
  }

  it('covers every reason voice.start and voice.stop can return', () => {
    const start = backendReasons('voice_start')
    const stop = backendReasons('voice_stop')
    expect(start).toEqual(expect.arrayContaining(['sidecar-missing', 'model-missing', 'busy', 'sidecar-failed']))
    expect(stop).toEqual(expect.arrayContaining(['no-session', 'sidecar-failed', 'transcribe-failed']))
    for (const r of start) expect(voiceErrorI18nKey(`start-${r}`)).toBe(`voice.error.start-${r}`)
    for (const r of stop) expect(voiceErrorI18nKey(`stop-${r}`)).toBe(`voice.error.stop-${r}`)
  })

  it('has a sentence in every locale for every known code, plus the generic fallback', () => {
    for (const { l, data } of locales) {
      for (const code of [...VOICE_ERROR_CODES, 'generic']) {
        expect(data.voice.error[code], `${l}: voice.error.${code}`).toBeTruthy()
      }
      expect(data.voice.error.generic).toContain('{code}')
    }
  })

  it('an unknown reason falls back to the generic sentence', () => {
    expect(voiceErrorI18nKey('stop-something-new')).toBe('voice.error.generic')
  })
})

describe('useVoiceInput — Enter ends the take and sends it', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('Enter while recording: one insert that submits, after the tail', async () => {
    const h = harness()
    const v = useVoiceInput(h.deps)
    v.press('p1', { handsFree: true })
    await settle()
    expect(v.submit()).toBe(true)
    // Key repeat of the Enter changes nothing.
    expect(v.submit()).toBe(true)
    expect(v.state.phase).toBe('recording')
    vi.advanceTimersByTime(RELEASE_TAIL_MS)
    await settle()
    expect(h.inserted).toEqual([{ paneId: 'p1', text: '幫我跑測試' }])
    expect(h.submits).toEqual([true])
    expect(v.state.phase).toBe('idle')
    expect(h.logs.at(-1)).toContain('outcome=sent end=enter')
  })

  it('Enter while transcribing sends the text once it lands', async () => {
    const h = harness()
    let answer!: (v: unknown) => void
    const base = h.deps.request
    h.deps.request = (type, payload, t) =>
      type === 'voice.stop'
        ? new Promise((r) => { answer = r as never; h.requests.push({ type, payload }) })
        : base(type, payload, t)
    const v = useVoiceInput(h.deps)
    v.press('p1')
    await settle()
    await releaseAndStop(v)
    expect(v.state.phase).toBe('transcribing')
    expect(v.submit()).toBe(true)
    answer({ ok: true, payload: { ok: true, text: '跑測試' } })
    await settle()
    expect(h.inserted).toEqual([{ paneId: 'p1', text: '跑測試' }])
    expect(h.submits).toEqual([true])
  })

  it('Enter while still starting ends the take with what the mic buffered, then sends it', async () => {
    const h = harness()
    // voice.start still loading the sidecar.
    let answer!: () => void
    const base = h.deps.request
    h.deps.request = (type, payload, t) => {
      if (type !== 'voice.start') return base(type, payload, t)
      h.requests.push({ type, payload })
      return new Promise((r) => { answer = () => r({ ok: true, payload: { ok: true, sessionId: 's1' } as never }) })
    }
    const v = useVoiceInput(h.deps)
    v.press('p1', { handsFree: true })
    expect(v.state.phase).toBe('starting')
    expect(v.submit()).toBe(true)
    await settle()
    vi.advanceTimersByTime(RELEASE_TAIL_MS)
    await settle()
    answer()
    await settle()
    expect(types(h)).toEqual(['voice.start', 'voice.chunk', 'voice.stop'])
    expect(h.submits).toEqual([true])
    expect(h.inserted).toHaveLength(1)
  })

  it('a take ended by the shortcut, or by the cap, is inserted without sending', async () => {
    const h = harness()
    const v = useVoiceInput(h.deps)
    v.press('p1')
    await settle()
    await releaseAndStop(v)
    v.press('p1')
    await settle()
    vi.advanceTimersByTime(MAX_RECORDING_MS)
    await settle()
    expect(h.submits).toEqual([false, false])
    // An Enter from an earlier take does not carry over.
    v.press('p1', { handsFree: true })
    await settle()
    v.submit()
    vi.advanceTimersByTime(RELEASE_TAIL_MS)
    await settle()
    v.press('p1')
    await settle()
    await releaseAndStop(v)
    expect(h.submits).toEqual([false, false, true, false])
  })

  it('no text, silence or a slip of the key sends nothing', async () => {
    for (const extra of [{ durationMs: 1500, peak: 0 }, { durationMs: 1500, peak: 900 }, { durationMs: 120, peak: 0 }]) {
      const h = harness()
      h.stopText = ''
      h.stopExtra = extra
      const v = useVoiceInput(h.deps)
      v.press('p1')
      await settle()
      v.submit()
      vi.advanceTimersByTime(RELEASE_TAIL_MS)
      await settle()
      expect(h.submits).toEqual([])
    }
  })

  it('a pane that does not take the text keeps it, and nothing is sent', async () => {
    const h = harness()
    h.insertOk = false
    const v = useVoiceInput(h.deps)
    v.press('p1')
    await settle()
    v.submit()
    vi.advanceTimersByTime(RELEASE_TAIL_MS)
    await settle()
    expect(v.state.error).toEqual({ key: 'insert-failed', params: undefined, text: '幫我跑測試' })
    expect(h.inserted).toEqual([])
  })

  it('is not taken with no take, or by an error capsule', async () => {
    const h = harness()
    const v = useVoiceInput(h.deps)
    expect(v.submit()).toBe(false)
    h.targets = {}
    v.press('p1')
    expect(v.state.phase).toBe('error')
    expect(v.submit()).toBe(false)
  })

  it('an Enter the pane could not press is said out loud and logged as not sent; the text stays in the box', async () => {
    const h = harness()
    h.submitResult = null
    let report!: (sent: boolean) => void
    const insert = h.deps.insert
    h.deps.insert = (paneId, text, opts) => {
      report = opts.onSubmit!
      return insert(paneId, text, opts)
    }
    const v = useVoiceInput(h.deps)
    v.press('p1', { handsFree: true })
    await settle()
    v.submit()
    vi.advanceTimersByTime(RELEASE_TAIL_MS)
    await settle()
    // Typed in; whether it went is not known yet, so nothing is logged.
    expect(h.inserted).toEqual([{ paneId: 'p1', text: '幫我跑測試' }])
    expect(v.state.phase).toBe('idle')
    expect(h.logs.some((l) => l.includes('outcome='))).toBe(false)
    report(false)
    expect(h.logs.at(-1)).toContain('outcome=inserted-not-sent end=enter')
    expect(v.state.phase).toBe('error')
    expect(v.state.paneId).toBe('p1')
    // A notice, not a kept transcript: the text is already in the input box.
    expect(v.state.error).toEqual({ key: 'not-sent', params: undefined })
    expect(h.inserted).toHaveLength(1)
    vi.advanceTimersByTime(ERROR_VISIBLE_MS)
    expect(v.state.phase).toBe('idle')
  })

  it('an Enter that went is logged as sent, with no message', async () => {
    const h = harness()
    const v = useVoiceInput(h.deps)
    v.press('p1', { handsFree: true })
    await settle()
    v.submit()
    vi.advanceTimersByTime(RELEASE_TAIL_MS)
    await settle()
    expect(h.logs.at(-1)).toContain('outcome=sent end=enter')
    expect(v.state.phase).toBe('idle')
  })

  it('a late "not sent" does not cover a newer take', async () => {
    const h = harness()
    h.submitResult = null
    let report!: (sent: boolean) => void
    const insert = h.deps.insert
    h.deps.insert = (paneId, text, opts) => {
      if (opts.onSubmit) report = opts.onSubmit
      return insert(paneId, text, opts)
    }
    const v = useVoiceInput(h.deps)
    v.press('p1', { handsFree: true })
    await settle()
    v.submit()
    vi.advanceTimersByTime(RELEASE_TAIL_MS)
    await settle()
    v.press('p1')
    await settle()
    expect(v.state.phase).toBe('recording')
    report(false)
    expect(v.state.phase).toBe('recording')
    expect(h.logs.at(-1)).toContain('outcome=inserted-not-sent')
  })

  it('Esc after Enter still cancels: nothing is typed in', async () => {
    const h = harness()
    const v = useVoiceInput(h.deps)
    v.press('p1', { handsFree: true })
    await settle()
    v.submit()
    expect(v.cancel()).toBe(true)
    vi.advanceTimersByTime(RELEASE_TAIL_MS)
    await settle()
    expect(h.submits).toEqual([])
  })
})
