/**
 * planSecurity.ts
 *
 * Package-local security primitives for navide-plans (`.agent-team/plans/*.html`)
 * document rendering and host-frame event communication.
 *
 * Security guarantees:
 * - Executable scripts are stripped; only the application/json data island is kept.
 * - Nonce-based Content Security Policy restricts script execution to trusted runtime scripts.
 * - Injected trusted scripts are protected against premature script tag closing.
 * - Inbound messages require an active, matching window source (blocking null === null matches)
 *   and enforce todo ID whitelisting against the document's metadata.
 */

const EXECUTABLE_SCRIPT_RE =
  /<script\b(?![^>]*[\t\n\f\r /"']type=["']application\/json["'])[^>]*>[\s\S]*?<\/script\s*>/gi

const CSP_NONCE_RE = /^[0-9a-f]{32}$/

function stripExecutableScripts(content: string): string {
  return content.replace(EXECUTABLE_SCRIPT_RE, '')
}

// Where the tokenizer ends the start tag whose attributes begin at `from`: just
// past its `>`, or -1 when input runs out first. A quoted value may hold `>`,
// so the first `>` is not always the end. Only an `=` after an attribute name
// opens a value; one where a name belongs starts that name instead.
// `seen` marks each (position, afterName) a read has passed. Every read from
// one of them ends the same way, and a read that ran into an earlier one could
// only have failed, so later reads stop there and the whole strip stays linear.
function startTagEnd(html: string, from: number, seen: Uint8Array): number {
  const space = '\t\n\f\r '
  let afterName = false
  let i = from
  while (i < html.length) {
    const state = afterName ? 2 : 1
    if (seen[i] & state) return -1
    seen[i] |= state
    const c = html[i++]
    if (c === '>') return i
    if (c === '/') {
      afterName = false
    } else if (space.includes(c)) {
      // An attribute name still takes a value across whitespace: `a = b`.
    } else if (c === '=' && afterName) {
      while (i < html.length && space.includes(html[i])) i++
      const quote = html[i]
      if (quote === '"' || quote === "'") {
        const close = html.indexOf(quote, i + 1)
        if (close === -1) return -1
        i = close + 1
      } else {
        while (i < html.length && !space.includes(html[i]) && html[i] !== '>') i++
      }
      afterName = false
    } else {
      afterName = true
    }
  }
  return -1
}

function isRefreshMeta(tag: string): boolean {
  for (const [, value] of tag.matchAll(/[\t\n\f\r /"']http-equiv[\t\n\f\r ]*=[\t\n\f\r ]*("[^"]*"|'[^']*'|[^\t\n\f\r >]*)/gi)) {
    const decoded = value.replace(/&#(x[0-9a-f]+|\d+);?/gi, (_, code: string) => {
      const point = code[0] === 'x' || code[0] === 'X' ? parseInt(code.slice(1), 16) : parseInt(code, 10)
      return point <= 0x10ffff ? String.fromCodePoint(point) : '\ufffd'
    })
    if (/refresh/i.test(decoded)) return true
  }
  return false
}

// A meta refresh navigates the frame to a page the injected CSP never reaches.
// Each one becomes a bare `<meta>` rather than nothing: the text on either
// side then cannot join into a new tag, so one pass is enough.
function stripMetaRefresh(html: string): string {
  const meta = /<meta(?=[\t\n\f\r />])/gi
  let seen: Uint8Array | undefined
  let out = ''
  let kept = 0
  for (let m = meta.exec(html); m; m = meta.exec(html)) {
    seen ??= new Uint8Array(html.length)
    const end = startTagEnd(html, m.index + 5, seen)
    // A `<meta` that never ends may be only text (a comment, an attribute
    // value): leave it and read on from the next one.
    if (end === -1) continue
    if (isRefreshMeta(html.slice(m.index, end))) {
      out += html.slice(kept, m.index) + '<meta>'
      kept = end
    }
    meta.lastIndex = end
  }
  return out + html.slice(kept)
}

function randomHexToken(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

function buildPlanCspMeta(nonce: string): string {
  return (
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; ' +
    `style-src 'unsafe-inline'; img-src data:; font-src data:; script-src 'nonce-${nonce}'">`
  )
}

export interface PreparePlanDocHtmlOptions {
  /**
   * Factory returning the host or plugin's trusted script source code to execute inside
   * the preview frame given the bound documentToken. Must not contain `</script>` tag breaks.
   */
  buildTrustedRuntimeScript: (context: { documentToken: string }) => string
  /**
   * Optional custom nonce. If omitted, a cryptographically strong 32-character hex nonce
   * will be generated.
   */
  nonce?: string
}

export interface PreparedPlanDocHtml {
  html: string
  nonce: string
  documentToken: string
}

/**
 * Prepares raw plan HTML for safe iframe preview:
 * 1. Generates a unique documentToken.
 * 2. Generates trusted runtime script via builder and validates no tag-breaking.
 * 3. Prepends strict nonce-based Content-Security-Policy meta tag.
 * 4. Strips untrusted executable scripts and meta refreshes while preserving JSON metadata.
 * 5. Injects the trusted runtime script with matching nonce before `</body>`.
 */
export function preparePlanDocHtml(
  content: string,
  options: PreparePlanDocHtmlOptions,
): PreparedPlanDocHtml {
  let nonce: string
  if (options.nonce !== undefined) {
    if (!CSP_NONCE_RE.test(options.nonce)) {
      throw new Error('nonce must be a 32-character hexadecimal string')
    }
    nonce = options.nonce
  } else {
    nonce = randomHexToken()
  }

  const documentToken = randomHexToken()
  const trustedRuntimeScript = options.buildTrustedRuntimeScript({ documentToken })

  if (trustedRuntimeScript.toLowerCase().includes('</script')) {
    throw new Error('trustedRuntimeScript cannot contain closing script tag')
  }

  const cspMeta = buildPlanCspMeta(nonce)
  const stripped = stripMetaRefresh(stripExecutableScripts(content))
  // A doctype must stay the first thing in the document or the frame renders
  // in quirks mode; the CSP meta goes right after it. Only HTML whitespace may
  // lead: JS `\s` also matches U+00A0, U+2028 and the like, which the parser
  // treats as text that opens <body>, where a CSP meta is ignored.
  const doctype = /^[\t\n\f\r ]*<!doctype[^>]*>/i.exec(stripped)
  const sanitizedContent = doctype
    ? stripped.slice(0, doctype[0].length) + cspMeta + stripped.slice(doctype[0].length)
    : cspMeta + stripped
  const runtimeTag = `<script nonce="${nonce}">${trustedRuntimeScript}</scr` + 'ipt>'

  const bodyClose = sanitizedContent.search(/<\/body>/i)
  const html =
    bodyClose === -1
      ? sanitizedContent + runtimeTag
      : sanitizedContent.slice(0, bodyClose) + runtimeTag + sanitizedContent.slice(bodyClose)

  return { html, nonce, documentToken }
}

export interface PlanMessageValidationOptions {
  /** Function returning the preview iframe's contentWindow. Messages from any other source are rejected. */
  getSourceWindow: () => Window | null | undefined
  /** Expected document generation token. Messages missing or with mismatched token are rejected. */
  getDocumentToken: () => string
}

/**
 * Validates inbound MessageEvent against origin window source and active document generation token.
 * Returns the parsed payload record if valid, or null if invalid or untrusted.
 *
 * Protocol rule:
 * - Strictly accepts `event.data.documentToken`.
 * - Unknown aliases (e.g. `token`), missing fields, or empty strings are rejected.
 */
export function validatePlanMessageEvent(
  event: MessageEvent,
  options: PlanMessageValidationOptions,
): Record<string, unknown> | null {
  const source = options.getSourceWindow()
  if (!source || event.source !== source) return null

  const data: unknown = event.data
  if (typeof data !== 'object' || data === null) return null

  const msg = data as Record<string, unknown>

  // Strictly reject messages carrying the legacy 'token' field, even if documentToken is also present
  if (Object.prototype.hasOwnProperty.call(msg, 'token')) return null

  const expectedToken = options.getDocumentToken()
  if (!expectedToken || typeof expectedToken !== 'string') return null

  if (typeof msg.documentToken !== 'string' || !msg.documentToken) return null
  if (msg.documentToken !== expectedToken) return null

  return msg
}

export interface SafeTodoClickHandlerOptions extends PlanMessageValidationOptions {
  /** List of valid todo IDs from parsed plan metadata. Unknown IDs are rejected. */
  getValidTodoIds: () => readonly string[]
  /** Callback invoked when a validated todo click message is received. */
  onTodoClicked: (todoId: string, alt: boolean) => void
}

/**
 * Creates a message event handler that safely validates todo-clicked messages from a preview iframe.
 *
 * Rejection criteria:
 * - Window source is null/undefined or does not match event.source (including null === null).
 * - Document token is missing or does not match current expected generation token.
 * - Payload is not an object or is null.
 * - Message type is not 'todo-clicked'.
 * - Todo ID is not a string or not present in the valid todo IDs whitelist.
 *
 * Returns `true` if the event was a valid todo-clicked message that was handled, or `false` otherwise.
 */
export function createSafeTodoClickHandler(
  options: SafeTodoClickHandlerOptions,
): (event: MessageEvent) => boolean {
  return (event: MessageEvent): boolean => {
    const msg = validatePlanMessageEvent(event, options)
    if (!msg) return false

    if (msg.type !== 'todo-clicked') return false

    const todoId = msg.todoId
    if (typeof todoId !== 'string' || !options.getValidTodoIds().includes(todoId)) {
      return false
    }

    options.onTodoClicked(todoId, msg.alt === true)
    return true
  }
}
