/**
 * The rich output view's data and rendering: a pane's recent turns, gathered
 * from the `agent.activity` events the backend already broadcasts (its log
 * readers parse each CLI's own conversation log), and their Markdown rendered
 * to sanitized HTML. Nothing here reads the terminal screen.
 *
 *   prompt  agent_active whose detail is a user-prompt detail (<= 500 chars)
 *   reply   turn_complete text: the turn's final assistant message
 *
 * Only turns seen since this window opened are known; the terminal keeps the
 * full history.
 */
import { Marked, type Tokens } from 'marked'
import DOMPurify from 'dompurify'
import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import css from 'highlight.js/lib/languages/css'
import diff from 'highlight.js/lib/languages/diff'
import go from 'highlight.js/lib/languages/go'
import java from 'highlight.js/lib/languages/java'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import markdown from 'highlight.js/lib/languages/markdown'
import python from 'highlight.js/lib/languages/python'
import rust from 'highlight.js/lib/languages/rust'
import sql from 'highlight.js/lib/languages/sql'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'

/** Vendors whose log reader emits turn_complete with the turn's text. */
export const RICH_OUTPUT_VENDORS: ReadonlySet<string> = new Set([
  'aider', 'antigravity', 'claude', 'codex', 'copilot', 'cursor', 'droid', 'goose',
  'grok', 'hermes', 'kimi', 'muse', 'openclaw', 'opencode', 'pi', 'qwen',
])

/** Turns kept per pane; older ones stay in the terminal. */
export const RICH_TURNS_MAX = 50
/** A longer reply is cut here and marked truncated. */
export const RICH_TURN_MAX_CHARS = 100_000
/** Per pane, all kept turns together; the oldest go first past this. */
export const RICH_PANE_MAX_CHARS = 1_500_000
/** Code blocks longer than this are escaped but not highlighted. */
export const RICH_HIGHLIGHT_MAX_CHARS = 20_000

/** Same set as the backend's _USER_PROMPT_DETAILS. */
const USER_PROMPT_DETAILS = new Set(['user', 'prompt', 'user_message'])

export interface RichTurn {
  id: number
  prompt: string
  reply: string
  /** The reply was cut at RICH_TURN_MAX_CHARS; the terminal has all of it. */
  truncated?: boolean
}

export interface ActivityLike {
  pane_id?: unknown
  event_type?: unknown
  detail?: unknown
  text?: unknown
}

let nextTurnId = 1

/** Whether a pane's turns may be kept: only a pane this window holds, and
 *  never a sign-in pane — its replies can quote its sign-in, the same text
 *  cli_get_status withholds (login_panes.is_login_pane on the backend). */
export function acceptsRichTurns(pane: { isLogin?: boolean } | undefined): boolean {
  return !!pane && !pane.isLogin
}

/** Fold one `agent.activity` event into the pane's turn list, in place.
 *  Returns true when the list changed. Events without text (hook events,
 *  tool calls) are ignored. */
export function applyActivity(turns: RichTurn[], ev: ActivityLike): boolean {
  const raw = typeof ev.text === 'string' ? ev.text : ''
  if (!raw.trim()) return false
  const truncated = raw.length > RICH_TURN_MAX_CHARS
  const text = truncated ? raw.slice(0, RICH_TURN_MAX_CHARS) : raw
  const last = turns[turns.length - 1]
  if (ev.event_type === 'agent_active' && USER_PROMPT_DETAILS.has(String(ev.detail ?? ''))) {
    turns.push({ id: nextTurnId++, prompt: text, reply: '' })
  } else if (ev.event_type === 'turn_complete') {
    // The same turn end can be reported twice (e.g. a resumed reader).
    if (last && last.reply === text) return false
    if (last && !last.reply) Object.assign(last, { reply: text, truncated })
    else turns.push({ id: nextTurnId++, prompt: '', reply: text, truncated })
  } else {
    return false
  }
  if (turns.length > RICH_TURNS_MAX) turns.splice(0, turns.length - RICH_TURNS_MAX)
  let total = turns.reduce((n, t) => n + t.prompt.length + t.reply.length, 0)
  while (total > RICH_PANE_MAX_CHARS && turns.length > 1) {
    const dropped = turns.shift()!
    total -= dropped.prompt.length + dropped.reply.length
  }
  return true
}

// ── Markdown ────────────────────────────────────────────────────────────────

const LANGUAGES: Record<string, Parameters<typeof hljs.registerLanguage>[1]> = {
  bash, css, diff, go, java, javascript, json, markdown, python, rust, sql, typescript, xml, yaml,
}
for (const [name, lang] of Object.entries(LANGUAGES)) hljs.registerLanguage(name, lang)
hljs.registerAliases(['sh', 'shell', 'zsh', 'console'], { languageName: 'bash' })
hljs.registerAliases(['js', 'jsx', 'mjs', 'cjs'], { languageName: 'javascript' })
hljs.registerAliases(['ts', 'tsx'], { languageName: 'typescript' })
hljs.registerAliases(['py'], { languageName: 'python' })
hljs.registerAliases(['html', 'vue', 'svg'], { languageName: 'xml' })
hljs.registerAliases(['yml'], { languageName: 'yaml' })
hljs.registerAliases(['md'], { languageName: 'markdown' })
hljs.registerAliases(['rs'], { languageName: 'rust' })
hljs.registerAliases(['patch'], { languageName: 'diff' })

/** Only these open (externally); anything else renders as plain text. */
export function isSafeLinkHref(href: string): boolean {
  return /^https?:\/\/[^\s]+$/i.test(href.trim())
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export interface RenderedMarkdown {
  html: string
  /** Raw text of each code block, indexed by the copy button's data-code. */
  codes: string[]
}

export interface RenderLabels {
  copy: string
}

/** Markdown to HTML. The renderer itself is the first line of defense: raw
 *  HTML is escaped, only http(s) links survive, images load nothing. */
export function markdownToHtml(src: string, labels: RenderLabels): RenderedMarkdown {
  const codes: string[] = []
  const md = new Marked({ gfm: true, breaks: false, async: false })
  md.use({
    renderer: {
      // Raw HTML in agent output is shown as text, never passed through.
      html({ text }: Tokens.HTML | Tokens.Tag): string {
        return escapeHtml(text)
      },
      code({ text, lang }: Tokens.Code): string {
        const language = (lang ?? '').trim().split(/\s+/)[0]?.toLowerCase() ?? ''
        const known = language && text.length <= RICH_HIGHLIGHT_MAX_CHARS && hljs.getLanguage(language)
        const body = known
          ? hljs.highlight(text, { language, ignoreIllegals: true }).value
          : escapeHtml(text)
        const index = codes.push(text) - 1
        return (
          `<div class="rich-code"><div class="rich-code-bar">` +
          `<span class="rich-code-lang">${escapeHtml(language)}</span>` +
          `<button type="button" class="rich-copy" data-code="${index}">${escapeHtml(labels.copy)}</button>` +
          `</div><pre><code class="hljs">${body}</code></pre></div>`
        )
      },
      link({ href, title, tokens }: Tokens.Link): string {
        const inner = this.parser.parseInline(tokens)
        if (!isSafeLinkHref(href)) return inner
        const t = title ? ` title="${escapeHtml(title)}"` : ''
        return `<a href="${escapeHtml(href)}"${t} rel="noopener noreferrer">${inner}</a>`
      },
      // No remote loads from agent output: an image becomes a link to it.
      image({ href, text }: Tokens.Image): string {
        const label = escapeHtml(text || href)
        return isSafeLinkHref(href) ? `<a href="${escapeHtml(href)}" rel="noopener noreferrer">${label}</a>` : label
      },
    },
  })
  return { html: md.parse(src) as string, codes }
}

/** Second line of defense over markdownToHtml's output. */
export function sanitizeRichHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    ALLOWED_URI_REGEXP: /^https?:\/\//i,
    FORBID_TAGS: ['style', 'img', 'form', 'input', 'iframe', 'object', 'embed'],
    FORBID_ATTR: ['style'],
  })
}

const PURIFY_PROBE = '<p onclick="x()">a</p><script>x()</script>'

let sanitizerProbe: boolean | null = null

/** Whether DOMPurify actually sanitizes in this DOM, probed once per window.
 *  `isSupported` is not enough: under happy-dom it is true and markup passes
 *  through unchanged. */
export function sanitizerWorks(): boolean {
  if (sanitizerProbe === null) {
    try {
      sanitizerProbe = sanitizeRichHtml(PURIFY_PROBE) === '<p>a</p>'
    } catch {
      sanitizerProbe = false
    }
  }
  return sanitizerProbe
}

/** Tests only: forget the probe result so a stubbed sanitizer is re-probed. */
export function resetSanitizerProbe(): void {
  sanitizerProbe = null
}

export function renderMarkdown(src: string, labels: RenderLabels): RenderedMarkdown {
  // Fail closed: without a working sanitizer the reply is shown as plain text.
  if (!sanitizerWorks()) return { html: `<p class="rich-plain">${escapeHtml(src)}</p>`, codes: [] }
  const out = markdownToHtml(src, labels)
  return { html: sanitizeRichHtml(out.html), codes: out.codes }
}
