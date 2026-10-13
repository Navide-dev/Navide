/**
 * Masking for what a sync conflict preview shows of an MCP server record.
 * Conservative by design: when a part might be a secret, it is masked.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Record keys whose entries are all secret values (env vars, headers,
 *  envFile); their names stay, their values go. */
const SECRET_CONTAINER = /env|header/i

export const MASK = '••••'
/** A flag or variable name that announces a secret value. Broad on purpose
 *  ('pat' also hits 'path'): a needless mask costs less than a leak. */
const SECRET_NAME =
  /token|key|secret|pass|pwd|auth|bearer|cred|pat|sig|cookie|session|apikey/i

/** Name test on the NFKC form, so full-width letters (ＡＰＩ-ＫＥＹ) count. */
function secretName(name: string): boolean {
  return SECRET_NAME.test(name.normalize('NFKC'))
}
/** Short flags that commonly take a secret (`-k key`, `-p password`, `-u user:pass`). */
const SECRET_SHORT_FLAGS: ReadonlySet<string> = new Set(['-a', '-k', '-p', '-u', '-t'])
/** Flags whose next argument is `NAME VALUE` or `NAME=VALUE` of an environment variable. */
const ENV_FLAGS: ReadonlySet<string> = new Set(['-e', '--env'])
/** Token shapes recognisable without a name: GitHub, OpenAI-style, Slack and
 *  AWS keys, JWTs, and any long hex or base64 run with letters and digits. */
const BARE_TOKEN = new RegExp(
  [
    '\\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{6,}',
    '\\bsk-[A-Za-z0-9_-]{8,}',
    '\\bxox[abprs]-[A-Za-z0-9-]{6,}',
    '\\bAKIA[0-9A-Z]{16}\\b',
    '\\beyJ[A-Za-z0-9_-]{6,}(?:\\.[A-Za-z0-9_-]*){0,2}',
    '\\b[0-9a-fA-F]{32,}\\b',
    '(?=[A-Za-z0-9+_-]*[0-9])(?=[A-Za-z0-9+_-]*[A-Za-z])[A-Za-z0-9+_-]{32,}={0,2}',
  ].join('|'),
  'g',
)
/** Schemes WHATWG parses as "special": any run of '/' and '\\' after the
 *  colon is the authority marker, and '\\' in the rest is a '/'. */
const SPECIAL_SCHEME = /^(https?|wss?|ftp|file):[\\/]+/i
const URL_IN_TEXT = /\b(?:(?:https?|wss?|ftp|file):[\\/]+|[a-z][a-z0-9+.-]*:\/\/)\S+/gi

/** What a WHATWG parser would read: tabs and newlines dropped and, for a
 *  special scheme, '\\' as '/' and the slashes after the colon as '//'. */
function normalizeUrl(url: string): string {
  const clean = url.replace(/[\t\n\r]/g, '').trim()
  const special = SPECIAL_SCHEME.exec(clean)
  if (!special) return clean
  return `${special[1]}://${clean.slice(special[0].length).replace(/\\/g, '/')}`
}

function maskBare(text: string): string {
  return text.replace(BARE_TOKEN, MASK)
}

/** A path segment that reads like a credential rather than a route name. */
function tokenLikeSegment(segment: string): boolean {
  if (!segment || segment === MASK) return false
  if (segment.length >= 24) return true
  return segment.length >= 8 && /[A-Za-z]/.test(segment) && /[0-9]/.test(segment)
}

/** Scheme and host stay; userinfo, query and `;k=v` values, the fragment and
 *  any token-like path segment go. Query and parameter keys stay readable. */
export function maskUrl(raw: string): string {
  const url = normalizeUrl(raw)
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(url)
  if (!scheme) return maskBare(url)
  let rest = url.slice(scheme[0].length)
  let out = scheme[0]
  // Userinfo runs to the last '@' before the query or fragment, so a password
  // holding '@' or '/' is masked whole.
  const head = rest.split(/[?#]/, 1)[0]
  const at = head.lastIndexOf('@')
  if (at >= 0) {
    out += `${MASK}@`
    rest = rest.slice(at + 1)
  }
  let fragment = ''
  const hash = rest.indexOf('#')
  if (hash >= 0) {
    fragment = `#${MASK}`
    rest = rest.slice(0, hash)
  }
  let query = ''
  const q = rest.indexOf('?')
  if (q >= 0) {
    query =
      '?' +
      rest
        .slice(q + 1)
        .split('&')
        .map((part) => {
          const eq = part.indexOf('=')
          return eq >= 0 ? `${part.slice(0, eq + 1)}${MASK}` : part ? MASK : part
        })
        .join('&')
    rest = rest.slice(0, q)
  }
  const slash = rest.indexOf('/')
  const host = slash >= 0 ? rest.slice(0, slash) : rest
  const path = slash >= 0 ? rest.slice(slash) : ''
  // A segment right after a secret-named one (/key/<value>) is its value.
  let afterSecret = false
  const maskedPath = path
    .split('/')
    .map((segment) => {
      const [name, ...params] = segment.split(';')
      const shownName = afterSecret || tokenLikeSegment(name) ? MASK : name
      afterSecret = secretName(name)
      const shownParams = params.map((p) => {
        const eq = p.indexOf('=')
        return eq >= 0 ? `${p.slice(0, eq + 1)}${MASK}` : MASK
      })
      return [shownName, ...shownParams].join(';')
    })
    .join('/')
  return out + host + maskedPath + query + fragment
}

/** A JSON value with every secret-named key's value masked and every other
 *  string run through maskValue. */
function maskJson(value: unknown, secret = false): unknown {
  if (typeof value === 'string') return secret ? MASK : maskValue(value)
  if (Array.isArray(value)) return value.map((v) => maskJson(v, secret))
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, maskJson(v, secret || secretName(k))]),
    )
  }
  return secret && value !== null ? MASK : value
}

/** JSON inside an argument. Text that does not parse still loses the value
 *  of every `"secret-name": value` pair it can find. */
function maskJsonText(text: string): string {
  try {
    return JSON.stringify(maskJson(JSON.parse(text)))
  } catch {
    return maskBare(
      text.replace(/("([^"\\]|\\.)*"\s*:\s*)("([^"\\]|\\.)*"?|[^,}\]\s]+)/g, (match, key: string) =>
        secretName(key) ? `${key}"${MASK}"` : match,
      ),
    )
  }
}

/** One argument that is not a flag: URLs, `Name: value` headers, `KEY=value`
 *  pairs, Bearer/Basic credentials and bare token shapes. */
function maskValue(value: string): string {
  const trimmed = value.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return maskJsonText(value)
  if (URL_IN_TEXT.test(value)) {
    URL_IN_TEXT.lastIndex = 0
    return maskBare(value.replace(URL_IN_TEXT, (url) => maskUrl(url)))
  }
  // A header (`X-API-Key: v`, `Cookie: session=v`): the whole value goes. A
  // colon followed by '//' is a URL, handled above.
  const header = /^\s*([A-Za-z][A-Za-z0-9_-]*)\s*:(?!\/\/)\s*(\S[\s\S]*)$/.exec(value)
  if (header) return `${header[1]}: ${MASK}`
  // A header written with a space (`apikey v`, `Bearer v`, `token v`).
  const spaced = /^\s*([A-Za-z][A-Za-z0-9_-]*)\s+\S/.exec(value)
  if (spaced && (secretName(spaced[1]) || /^basic$/i.test(spaced[1]))) return `${spaced[1]} ${MASK}`
  // Before KEY=value: base64 padding would otherwise read as an empty pair.
  const bare = maskBare(value)
  if (bare !== value) return bare
  const pair = /^([A-Za-z_][A-Za-z0-9_.-]*)=([\s\S]*)$/.exec(value)
  if (pair) return `${pair[1]}=${secretName(pair[1]) ? MASK : maskValue(pair[2])}`
  return maskBare(value.replace(/\b(bearer|basic|token)\s+\S+/gi, `$1 ${MASK}`))
}

/** Command-line arguments with their secrets masked. Covers secret-named and
 *  short secret flags (`--api-key v`, `--token=v`, `-k v`), `--env NAME VALUE`,
 *  a bare header name followed by its value, and whatever maskValue covers.
 *  After a secret flag the next argument is masked even when it looks like a
 *  flag, and the one after it too, since a value cannot be told from a flag. */
export function maskArgs(args: unknown[]): unknown[] {
  let maskNext = false
  let envName = false
  return args.map((raw) => {
    if (typeof raw !== 'string') return raw
    if (maskNext) {
      maskNext = raw.startsWith('-')
      return MASK
    }
    if (envName) {
      envName = false
      const eq = raw.indexOf('=')
      if (eq > 0) return `${raw.slice(0, eq + 1)}${MASK}`
      maskNext = true
      return raw
    }
    // A short flag with its value glued on: -pS, -uadmin:S, -HX-Api-Key:S.
    const glued = /^-([A-Za-z])(.+)$/.exec(raw)
    if (glued) {
      const flag = `-${glued[1]}`
      if (SECRET_SHORT_FLAGS.has(flag) || ENV_FLAGS.has(flag)) return `${flag}${MASK}`
      return `${flag}${maskValue(glued[2])}`
    }
    if (raw.startsWith('-')) {
      const eq = raw.indexOf('=')
      if (eq > 0) {
        const flag = raw.slice(0, eq)
        return `${flag}=${secretName(flag) ? MASK : maskValue(raw.slice(eq + 1))}`
      }
      if (ENV_FLAGS.has(raw)) envName = true
      else if (SECRET_SHORT_FLAGS.has(raw) || secretName(raw)) maskNext = true
      return raw
    }
    // A header name on its own (`Authorization`, `X-Api-Key`) carries its
    // value in the next argument.
    if (/^[A-Za-z][A-Za-z0-9_-]*$/.test(raw) && secretName(raw) && maskBare(raw) === raw) {
      maskNext = true
      return raw
    }
    return maskValue(raw)
  })
}

/** Every leaf under a secret container or name: keys stay, values go. */
function maskLeaves(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskLeaves)
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, maskLeaves(v)]))
  return value === null || value === undefined ? value : MASK
}

/** One field of a record, by its key: url and args by their own rules, env
 *  and header containers and secret-named keys masked leaf by leaf, nested
 *  objects walked, and any other string through maskValue. */
function maskField(key: string, value: unknown): unknown {
  if (key === 'url' && typeof value === 'string') return maskUrl(value)
  if (key === 'args' && Array.isArray(value)) return maskArgs(value)
  if (SECRET_CONTAINER.test(key) || secretName(key)) return maskLeaves(value)
  if (typeof value === 'string') return maskValue(value)
  if (Array.isArray(value)) return value.map((v) => maskField('', v))
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, maskField(k, v)]))
  return value
}

/** An MCP server record as a sync conflict may show it. Every field is
 *  walked, nested ones included: the names in env and headers stay, so a
 *  person can tell the two sides apart, but no secret value does. */
export function maskMcpRecord(value: unknown): unknown {
  if (!isRecord(value)) return value
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, maskField(k, v)]))
}
