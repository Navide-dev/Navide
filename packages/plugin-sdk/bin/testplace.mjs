// `navide-plugin testplace ...`: manage invite-only test builds on a Registry
// (marketplace/registry/registry/testplace_api.py). Publishing a test build is
// `navide-plugin publish <file> --channel testplace`.

import { assertSecureTransport, registryUrl, storedCredentials, TOKEN_ENV } from './registry-client.mjs'

const USAGE = [
  'Usage:',
  '  navide-plugin testplace invite add <namespace.name> <label>... [options]',
  '  navide-plugin testplace invite list <namespace.name> [options]',
  '  navide-plugin testplace invite revoke <namespace.name> <invite-id> [options]',
  '  navide-plugin testplace code create <namespace.name> --max-testers <n> [options]',
  '  navide-plugin testplace code list <namespace.name> [options]',
  '  navide-plugin testplace code revoke <namespace.name> <code-id> [options]',
  '  navide-plugin testplace versions <namespace.name> [options]',
  '  navide-plugin testplace revoke <namespace.name> <version> [--reason <text>] [options]',
  '  navide-plugin testplace promote <namespace.name> <version> [options]',
  '',
  'Options: --registry <url>  --token <token>  --insecure-http',
  `The token is read from --token, then ${TOKEN_ENV}, then \`navide-plugin login\`.`,
  'A label names the invitee for you (for example their email address); it is never shown to the tester.',
].join('\n')

const VALUE_OPTIONS = new Set(['--registry', '--token', '--max-testers', '--reason'])
const FLAGS = new Set(['--insecure-http'])

export class TestplaceUsageError extends Error {
  constructor(message = USAGE) {
    super(message)
  }
}

export function parseTestplaceArgs(argv) {
  const positional = []
  const options = new Map()
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (!value.startsWith('--')) {
      positional.push(value)
    } else if (options.has(value)) {
      throw new TestplaceUsageError()
    } else if (FLAGS.has(value)) {
      options.set(value, true)
    } else if (VALUE_OPTIONS.has(value) && argv[index + 1] !== undefined) {
      options.set(value, argv[index + 1])
      index += 1
    } else {
      throw new TestplaceUsageError()
    }
  }
  return { positional, options }
}

function extensionPath(id) {
  const match = /^([a-z0-9][a-z0-9-]*)\.([a-z0-9][a-z0-9-]*)$/.exec(id ?? '')
  if (!match) throw new TestplaceUsageError(`expected <namespace.name>, got '${id ?? ''}'\n\n${USAGE}`)
  return `/api/testplace/${match[1]}/${match[2]}`
}

function message(body) {
  const detail = body?.detail
  if (detail && typeof detail === 'object') return `${detail.code ?? 'ERROR'}: ${detail.message ?? ''}`
  if (typeof detail === 'string') return detail
  return JSON.stringify(body)
}

async function call(registry, token, method, path, json) {
  const response = await fetch(`${registry}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(json === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: json === undefined ? undefined : JSON.stringify(json),
  })
  const text = await response.text()
  let body
  try {
    body = text ? JSON.parse(text) : {}
  } catch {
    body = { detail: text }
  }
  if (!response.ok) throw new Error(`${response.status} ${message(body)}`)
  return body
}

function printInvites(invites, log) {
  if (!invites.length) log('No invites.')
  for (const invite of invites) {
    log(`#${invite.id}  ${invite.state.padEnd(8)}  ${invite.source.padEnd(6)}  ${invite.label || '-'}`)
  }
}

function printCodes(codes, log) {
  if (!codes.length) log('No test codes.')
  for (const code of codes) {
    log(`#${code.id}  ${code.state.padEnd(9)}  ${code.testers}/${code.max_testers} testers${code.review_reason ? `  (${code.review_reason})` : ''}`)
  }
}

/** Run one `testplace` subcommand. `log` receives every output line. */
export async function runTestplace(argv, { log = console.log } = {}) {
  const { positional, options } = parseTestplaceArgs(argv)
  const registry = registryUrl(options.get('--registry'))
  assertSecureTransport(registry, { insecureHttp: options.get('--insecure-http') === true })
  if (options.has('--token')) {
    console.error('navide-plugin: warning: --token is visible in the process list and shell history; set NAVIDE_PLUGIN_TOKEN or run `navide-plugin login` instead')
  }
  const token = options.get('--token') || process.env[TOKEN_ENV] || storedCredentials(registry)?.token
  const [group, action, ...rest] = positional
  const auth = () => {
    if (!token) throw new Error(`testplace needs ${TOKEN_ENV} or \`navide-plugin login --registry ${registry}\``)
    return token
  }

  if (group === 'invite' && action === 'add' && rest.length >= 2) {
    const [id, ...labels] = rest
    const { invites } = await call(registry, auth(), 'POST', `${extensionPath(id)}/invites`, { labels })
    log(`Created ${invites.length} invite(s) for ${id}. Each join token works once and is shown only now:`)
    for (const invite of invites) log(`#${invite.id}  ${invite.label || '-'}  ${invite.join_token}`)
    log('The tester pastes it in Navide → Extensions → Testplace → Join while signed in to Navide Cloud.')
    return
  }
  if (group === 'invite' && action === 'list' && rest.length === 1) {
    const body = await call(registry, auth(), 'GET', `${extensionPath(rest[0])}/invites`)
    printInvites(body.invites, log)
    log(`${body.invites.filter((i) => i.state !== 'revoked' && i.source === 'invite').length} invites in use.`)
    return
  }
  if (group === 'invite' && action === 'revoke' && rest.length === 2) {
    const invite = await call(registry, auth(), 'POST', `${extensionPath(rest[0])}/invites/${encodeURIComponent(rest[1])}/revoke`)
    log(`Invite #${invite.id} is ${invite.state}.`)
    return
  }
  if (group === 'code' && action === 'create' && rest.length === 1) {
    const maxTesters = Number(options.get('--max-testers'))
    if (!Number.isInteger(maxTesters)) throw new TestplaceUsageError(`--max-testers <n> is required\n\n${USAGE}`)
    const code = await call(registry, auth(), 'POST', `${extensionPath(rest[0])}/codes`, { max_testers: maxTesters })
    log(`Test code #${code.id} (${code.state}, up to ${code.max_testers} testers), shown only now: ${code.code}`)
    if (code.state === 'in-review') log("This is the Navide plugin's first test code: it opens after a light review by Navide.")
    return
  }
  if (group === 'code' && action === 'list' && rest.length === 1) {
    const body = await call(registry, auth(), 'GET', `${extensionPath(rest[0])}/codes`)
    printCodes(body.codes, log)
    return
  }
  if (group === 'code' && action === 'revoke' && rest.length === 2) {
    const code = await call(registry, auth(), 'POST', `${extensionPath(rest[0])}/codes/${encodeURIComponent(rest[1])}/revoke`)
    log(`Test code #${code.id} is ${code.state}; testers who already joined keep their access.`)
    return
  }
  if (group === 'versions' && action !== undefined && rest.length === 0) {
    const body = await call(registry, auth(), 'GET', `${extensionPath(action)}/versions`)
    if (!body.versions.length) log('No testplace versions.')
    for (const v of body.versions) {
      const state = v.yanked ? 'revoked' : v.channel === 'testplace' ? `expires ${v.expires_at}` : v.channel
      log(`${v.version}  ${v.target}  ${state}${v.promotion_status ? `  promotion ${v.promotion_status}` : ''}${v.promotion_reason ? ` (${v.promotion_reason})` : ''}`)
    }
    return
  }
  if (group === 'revoke' && action !== undefined && rest.length === 1) {
    const reason = options.get('--reason')
    const body = await call(registry, auth(), 'POST', `${extensionPath(action)}/versions/${encodeURIComponent(rest[0])}/revoke`, reason ? { reason } : {})
    log(`Revoked ${action}@${body.version} (${body.targets.join(', ')}). Each tester's Navide turns it off the next time it checks in while signed in to Navide Cloud.`)
    return
  }
  if (group === 'promote' && action !== undefined && rest.length === 1) {
    const body = await call(registry, auth(), 'POST', `${extensionPath(action)}/versions/${encodeURIComponent(rest[0])}/promote`)
    log(`Sent ${action}@${body.version} for Marketplace review. The same package is reviewed; testers do not reinstall when it is approved.`)
    return
  }
  throw new TestplaceUsageError()
}
