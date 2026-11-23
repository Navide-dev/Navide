// Opening the organisation site already signed in, from the app.
//
// Triggered by the `navide://org/login` deep link (the site's "open from the
// Navide app" button) and by "Manage on org.navide.dev" in Settings. Steps:
//   1. a PKCE verifier is made here and never leaves this process except in the
//      exchange below; its S256 challenge goes to the server with
//      `auth.assertion.issue` (aud "org"), which returns a short-lived assertion;
//   2. the assertion and verifier are POSTed to `<site>/api/auth/app-exchange`,
//      which answers with a single-use ticket valid for 60 seconds;
//   3. the system browser opens `<site>/auth/handoff#t=<ticket>`.
// The assertion and the ticket are never logged and never put in a query
// string: the ticket rides in the fragment, which the browser does not send.
import { createHash, randomBytes } from 'crypto'

export const ORG_SITE_DEFAULT = 'https://org.navide.dev'
/** Overrides the site address (the site is not live yet; tests and staging). */
export const ORG_SITE_ENV = 'NAVIDE_ORG_SITE_URL'
export const ORG_EXCHANGE_TIMEOUT_MS = 15_000

/** A site-relative path the site may send the browser on to after sign-in. */
const RETURN_TO = /^\/(?!\/)[A-Za-z0-9/_-]*$/

export type OrgAssertionResult =
  | { ok: true; assertion: string; memberId: string }
  | { ok: false; code: string; message: string }

export type OrgHandoffResult = { ok: true } | { ok: false; code: string; message: string }

export interface OrgHandoffDeps {
  assertion: (challenge: string) => Promise<OrgAssertionResult>
  openExternal: (url: string) => Promise<void>
  fetch?: typeof fetch
  /** The configured site address; defaults to ORG_SITE_DEFAULT. */
  siteUrl?: () => string | undefined
  log?: (message: string) => void
}

function base64Url(bytes: Buffer): string {
  return bytes.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * The site origin to use, or null when the configured value is not one.
 * https anywhere; plain http only on loopback, for local development.
 */
export function resolveOrgSite(configured: string | undefined): string | null {
  const raw = (configured ?? '').trim() || ORG_SITE_DEFAULT
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.username || url.password) return null
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return null
  return url.origin
}

export function createOrgHandoff(deps: OrgHandoffDeps) {
  const doFetch = deps.fetch ?? fetch
  const log = deps.log ?? (() => {})
  let inFlight: Promise<OrgHandoffResult> | null = null

  async function run(returnTo: string | undefined): Promise<OrgHandoffResult> {
    const site = resolveOrgSite(deps.siteUrl?.())
    if (!site) return { ok: false, code: 'ORG_SITE_INVALID', message: 'the organisation site address is not valid' }
    if (returnTo !== undefined && !RETURN_TO.test(returnTo)) {
      return { ok: false, code: 'BAD_RETURN_TO', message: 'return_to must be a site-relative path' }
    }
    const verifier = base64Url(randomBytes(48))
    const challenge = base64Url(createHash('sha256').update(verifier).digest())
    const issued = await deps.assertion(challenge).catch(
      (err): OrgAssertionResult => ({ ok: false, code: 'ASSERTION_UNAVAILABLE', message: String(err) }),
    )
    if (!issued.ok) {
      log(`[org] no assertion: ${issued.code}`)
      return issued
    }
    let ticket: unknown
    try {
      const response = await doFetch(`${site}/api/auth/app-exchange`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          assertion: issued.assertion,
          code_verifier: verifier,
          ...(returnTo !== undefined ? { return_to: returnTo } : {}),
        }),
        redirect: 'error',
        signal: AbortSignal.timeout(ORG_EXCHANGE_TIMEOUT_MS),
      })
      if (!response.ok) {
        log(`[org] app-exchange answered ${response.status}`)
        return { ok: false, code: 'EXCHANGE_FAILED', message: `the organisation site answered ${response.status}` }
      }
      ticket = ((await response.json()) as { ticket?: unknown } | null)?.ticket
    } catch (err) {
      // The error names the request, never its body.
      log(`[org] app-exchange failed: ${err instanceof Error ? err.name : 'error'}`)
      return { ok: false, code: 'EXCHANGE_FAILED', message: 'the organisation site could not be reached' }
    }
    if (typeof ticket !== 'string' || !/^[A-Za-z0-9_-]{16,256}$/.test(ticket)) {
      return { ok: false, code: 'EXCHANGE_FAILED', message: 'the organisation site returned no ticket' }
    }
    const fragment = `t=${ticket}` + (returnTo !== undefined ? `&r=${encodeURIComponent(returnTo)}` : '')
    await deps.openExternal(`${site}/auth/handoff#${fragment}`)
    log('[org] opened the organisation site')
    return { ok: true }
  }

  /** One handoff at a time: a burst of clicks or links opens the site once. */
  function open(returnTo?: string): Promise<OrgHandoffResult> {
    if (!inFlight) inFlight = run(returnTo).finally(() => { inFlight = null })
    return inFlight
  }

  return { open }
}
