import { ref } from 'vue'

/**
 * Spoken readback for voice-driven panes.
 *
 * When a pane that took a voice message in the last READBACK_WINDOW_MS ends a
 * turn, a short local summary of the turn's text is spoken with the platform
 * speech synthesizer. Nothing leaves the machine and no model is involved: the
 * summary is a heuristic (see summarizeForSpeech). Off by default, and panes
 * the user never spoke to are never read out.
 */

export const READBACK_WINDOW_MS = 10 * 60_000
export const READBACK_MAX_CHARS = 200
const MAX_SENTENCES = 2

/** The first `n` sentences of `text`. A sentence ends at CJK/ASCII ! ? 。 or at
 *  a '.' followed by whitespace — so "v1.2" and "file.ts" stay whole. */
function firstSentences(text: string, n: number): string {
  let count = 0
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    const ends = '。！？!?'.includes(c) || (c === '.' && (i + 1 === text.length || /\s/.test(text[i + 1])))
    if (!ends) continue
    // A run of terminators ("?!", "。。") closes one sentence.
    while (i + 1 < text.length && '。！？!?.'.includes(text[i + 1])) i++
    if (++count === n) return text.slice(0, i + 1).trim()
  }
  return text.trim()
}

/**
 * Plain-speech summary of an agent's turn: code, markup and inter-CLI message
 * blocks removed, then the first two sentences, capped at READBACK_MAX_CHARS.
 * Empty when nothing speakable is left.
 */
export function summarizeForSpeech(text: string): string {
  const plain = text
    // Inter-CLI message blocks are addressed to another pane, not the user.
    .replace(/^---MSG-START---[\s\S]*?^---MSG-END---\s*$/gm, ' ')
    // Fenced code blocks, closed or left open at the end of the turn.
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/~~~[\s\S]*?(~~~|$)/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/<[^>\n]+>/g, ' ')
    // Images vanish, links keep their label.
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    // Line-level markup: headings, quotes, list bullets, table rules.
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*(?:[-*+•]|\d+[.)])\s+/gm, '')
    .replace(/^\s*\|?[\s:|-]+\|[\s:|-]*$/gm, ' ')
    .replace(/\|/g, ' ')
    .replace(/^\s*(?:[-*_]\s*){3,}$/gm, ' ')
    // Emphasis markers.
    .replace(/(\*\*|__|\*|_|~~)(?=\S)([\s\S]*?\S)\1/g, '$2')
    .replace(/\s+/g, ' ')
    .trim()
  if (!plain) return ''
  let out = firstSentences(plain, MAX_SENTENCES)
  if (out.length > READBACK_MAX_CHARS) out = `${out.slice(0, READBACK_MAX_CHARS - 1).trimEnd()}…`
  return out
}

export interface ReadbackDeps {
  enabled: () => boolean
  /** Speak `text`, cutting off anything still being spoken. */
  speak: (text: string) => void
  /** Fallback line when a turn leaves nothing to summarize. */
  doneLine: (paneId: string) => string
  now?: () => number
}

export function useVoiceReadback(deps: ReadbackDeps) {
  const now = deps.now ?? (() => Date.now())
  /** paneId → when a voice message last reached it. */
  const voicedAt = new Map<string, number>()

  function noteVoiceDelivered(paneId: string): void {
    voicedAt.set(paneId, now())
  }

  /**
   * A pane ended a turn. `eventMs` is the event's own clock when it has one
   * (NaN otherwise); a replayed event from before the voice message is skipped.
   */
  function onTurnComplete(paneId: string, text: string, eventMs: number = Number.NaN): void {
    if (!deps.enabled()) return
    const at = voicedAt.get(paneId)
    if (at === undefined) return
    const t = now()
    if (t - at > READBACK_WINDOW_MS) {
      voicedAt.delete(paneId)
      return
    }
    if (!Number.isNaN(eventMs) && eventMs < at) return
    deps.speak(summarizeForSpeech(text) || deps.doneLine(paneId))
  }

  return { noteVoiceDelivered, onTurnComplete }
}

/** The platform synthesizer, interrupting whatever it was saying. */
export function speakWithSynthesis(text: string, lang?: string): void {
  const synth = globalThis.speechSynthesis
  if (!synth || typeof SpeechSynthesisUtterance === 'undefined') return
  synth.cancel()
  const u = new SpeechSynthesisUtterance(text)
  if (lang) u.lang = lang
  synth.speak(u)
}

// ── Spoken notices for panes marked 🔊 ─────────────────────────────────────────
// "<pane> 完成了" / "<pane> 需要你回答", fired from the same done / attention
// notifications as the desktop notification. Off by default (Settings → Voice
// → Read aloud); with it off announce() returns before queueing anything.

export type ReadbackKind = 'done' | 'attention'
export interface ReadbackItem { paneId: string; kind: ReadbackKind }
export interface ReadbackLine { text: string; paneIds: string[] }

/** Events this close together are spoken as one line. */
export const READBACK_MERGE_MS = 1500

// Panes the user marked 🔊. Renderer memory only: a restart or rebuild gives a
// pane a new id, so marks are set again per session.
const readbackPanes = ref(new Set<string>())

export function isPaneReadback(paneId: string): boolean {
  return readbackPanes.value.has(paneId)
}

export function setPaneReadback(paneId: string, on: boolean): void {
  if (readbackPanes.value.has(paneId) === on) return
  const next = new Set(readbackPanes.value)
  if (on) next.add(paneId)
  else next.delete(paneId)
  readbackPanes.value = next
}

type Translate = (key: string, params?: Record<string, unknown>) => string

/** The sentence for a batch: one pane is named, several are counted per kind. */
export function readbackLine(items: ReadbackItem[], label: (paneId: string) => string, t: Translate): string {
  const parts: string[] = []
  for (const kind of ['done', 'attention'] as const) {
    const of = items.filter((i) => i.kind === kind)
    if (of.length === 1) parts.push(t(`voice.readback.${kind}`, { label: label(of[0].paneId) }))
    else if (of.length > 1) parts.push(t(`voice.readback.${kind}-many`, { n: of.length }))
  }
  return parts.join(t('voice.readback.separator'))
}

export interface ReadbackAnnouncerDeps {
  enabled: () => boolean
  paneMarked: (paneId: string) => boolean
  paneMuted: (paneId: string) => boolean
  line: (items: ReadbackItem[]) => string
  /** Speak `text`, cutting off anything still being spoken; `onEnd` when it stops. */
  speak: (text: string, onEnd: () => void) => void
  cancel: () => void
}

export function useReadbackAnnouncer(deps: ReadbackAnnouncerDeps) {
  /** The line being spoken, for the capsule and the pane's 🔊 label. */
  const current = ref<ReadbackLine | null>(null)
  const pending = new Map<string, ReadbackKind>()
  let timer: ReturnType<typeof setTimeout> | null = null
  let token = 0

  function flush(): void {
    timer = null
    const items = [...pending].map(([paneId, kind]) => ({ paneId, kind }))
    pending.clear()
    if (!deps.enabled() || items.length === 0) return
    const text = deps.line(items)
    if (!text) return
    const mine = ++token
    current.value = { text, paneIds: items.map((i) => i.paneId) }
    deps.speak(text, () => {
      if (token === mine) current.value = null
    })
  }

  function announce(paneId: string, kind: ReadbackKind): void {
    if (!deps.enabled() || !deps.paneMarked(paneId) || deps.paneMuted(paneId)) return
    // A newer event replaces the pane's older one (Map order keeps the first slot).
    pending.set(paneId, kind)
    if (timer === null) timer = setTimeout(flush, READBACK_MERGE_MS)
  }

  /** Stop speech and drop anything queued. True when something was playing or queued. */
  function stop(): boolean {
    const active = current.value !== null || timer !== null
    if (!active) return false
    if (timer !== null) clearTimeout(timer)
    timer = null
    pending.clear()
    token++
    current.value = null
    deps.cancel()
    return true
  }

  return { current, announce, stop }
}

export interface VoiceLike { voiceURI: string; name: string; lang: string; localService?: boolean }

function langParts(lang: string): [string, string] {
  const [base = '', region = ''] = lang.replace('_', '-').toLowerCase().split('-')
  return [base, region]
}

/** Voices that speak the UI language (any region of it). */
export function voicesForLanguage<V extends VoiceLike>(voices: readonly V[], uiLang: string): V[] {
  const [base] = langParts(uiLang)
  return voices.filter((v) => langParts(v.lang)[0] === base)
}

/**
 * The voice to read with: the chosen one when it is installed, otherwise the
 * best voice for the UI language — its own region first (zh-TW over zh-CN),
 * then a Premium / Enhanced download over the compact default. Null leaves it
 * to the platform.
 */
export function pickReadbackVoice<V extends VoiceLike>(voices: readonly V[], uiLang: string, preferredURI: string): V | null {
  if (preferredURI) {
    const chosen = voices.find((v) => v.voiceURI === preferredURI)
    if (chosen) return chosen
  }
  const [, region] = langParts(uiLang)
  const score = (v: V): number =>
    (langParts(v.lang)[1] === region ? 4 : 0) +
    ({ premium: 2, enhanced: 1, compact: 0 })[voiceQuality(v)] +
    (v.localService ? 0.5 : 0)
  let best: V | null = null
  for (const v of voicesForLanguage(voices, uiLang)) if (!best || score(v) > score(best)) best = v
  return best
}

export type VoiceQuality = 'premium' | 'enhanced' | 'compact'

/**
 * A voice's download tier. The Web Speech API has no quality field, so it is
 * read from the macOS voice identifier (com.apple.voice.premium.zh-TW.Meijia)
 * and, failing that, from the name Chromium shows ("Ava (Premium)").
 */
export function voiceQuality(v: VoiceLike): VoiceQuality {
  if (/\.premium\./i.test(v.voiceURI) || /premium|高音質|高品質|プレミアム/i.test(v.name)) return 'premium'
  if (/\.enhanced\./i.test(v.voiceURI) || /enhanced|增強|強化|拡張/i.test(v.name)) return 'enhanced'
  return 'compact'
}

// The voice Settings recommends per UI language, and the names it goes by.
const PREFERRED_VOICES: Record<string, { display: string; names: string[] }> = {
  zh: { display: '美佳（Premium）', names: ['meijia', 'mei-jia', '美佳'] },
  en: { display: 'Ava (Premium)', names: ['ava'] },
  ja: { display: 'Kyoko (Enhanced)', names: ['kyoko', '恭子'] },
}

/** The voice name without its "(Premium)" style suffix, lower-cased. */
function baseVoiceName(name: string): string {
  return name.replace(/\s*[(（].*$/, '').trim().toLowerCase()
}

/**
 * The recommended voice for the UI language and whether its Premium/Enhanced
 * download is installed. `using` is what readback speaks with either way —
 * the best voice available — so a missing download never stops readback.
 */
export function readbackVoiceModel<V extends VoiceLike>(voices: readonly V[], uiLang: string): { preferred: string; ready: boolean; using: V | null } {
  const pref = PREFERRED_VOICES[langParts(uiLang)[0]] ?? PREFERRED_VOICES.en
  const ready = voicesForLanguage(voices, uiLang).some((v) => pref.names.includes(baseVoiceName(v.name)) && voiceQuality(v) !== 'compact')
  return { preferred: pref.display, ready, using: pickReadbackVoice(voices, uiLang, '') }
}

export function readbackSupported(): boolean {
  return !!globalThis.speechSynthesis && typeof SpeechSynthesisUtterance !== 'undefined'
}

/** Speak one readback line with the platform synthesizer, replacing what it was saying. */
export function speakReadback(
  text: string,
  opts: { uiLang: string; voiceURI: string; rate: number },
  onEnd: () => void = () => {},
): void {
  if (!readbackSupported()) {
    onEnd()
    return
  }
  const synth = globalThis.speechSynthesis
  synth.cancel()
  const u = new SpeechSynthesisUtterance(text)
  const voice = pickReadbackVoice(synth.getVoices(), opts.uiLang, opts.voiceURI)
  if (voice) {
    u.voice = voice
    u.lang = voice.lang
  } else {
    u.lang = opts.uiLang
  }
  u.rate = opts.rate
  u.onend = () => onEnd()
  u.onerror = () => onEnd()
  synth.speak(u)
}

export function cancelReadback(): void {
  globalThis.speechSynthesis?.cancel()
}
