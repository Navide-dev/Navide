// `developer:*` IPC and the Host's answers to the developer status tools
// (plan mcp-navide-0-2-27, W3). Settings > Navide Marketplace > Developer and
// the forms an agent opens or fills call these; the MCP status tools reach the
// same functions through `marketplace.developer.request`.
//
// What crosses to the renderer or the backend is states, Registry bodies and
// the user's own application, never a token or the signing key: those stay in
// DeveloperVault and are used only inside DeveloperAccount.
//
// A package to publish is read once into a stage (like K3's installFromFile):
// the form shows that copy's id, version, digest and disclosure, and Submit
// signs and uploads exactly those bytes, whatever happens to the file later.
// Stages are files under Navide's data folder (PackageStagingStore, review
// MED-5 / S8 Q3), re-read and digest-checked at Submit; there is no count
// limit, and a stage goes once it is published or STAGE_TTL_MS after it was
// made.
import { readFileSync, statSync } from 'node:fs'
import { basename, isAbsolute } from 'node:path'
import type { IpcMainInvokeEvent } from 'electron'
import { computeDisclosure } from '../../shared/pluginDisclosure'
import type { MarketplaceDeveloperQuery } from '../../shared/pluginAgentTools'
import { redactDeveloperSecrets, registryError, type DeveloperAccount, type DeveloperSignInScope } from './developerAccount'
import type { DeveloperCallResult, DeveloperPublicState, StagedPackage } from '../../shared/marketplaceDeveloper'
import { isManifestV2 } from './pluginManifest'
import { PackageStagingStore } from './pluginStagingStore'

export type DeveloperQueryAnswer =
  | { ok: true; result: Record<string, unknown> & { kind: string } }
  | { ok: false; error: string; error_code: string }

export interface InspectedPackage {
  id: string
  version: string
  publisher: string
  digest: string
  manifest: unknown
}

export interface DeveloperIpcDeps {
  handle: (channel: string, listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => void
  authorize: (event: IpcMainInvokeEvent) => boolean
  account: DeveloperAccount
  /** The same checks a local install runs (zip, manifest, backend executable, takedowns). */
  inspectPackage: (bytes: Uint8Array) => InspectedPackage
  /** A file dialog over the asking main window; null when cancelled. */
  pickPackageFile: (event: IpcMainInvokeEvent) => Promise<string | null>
  hostTarget: () => string
  /** Folder for staged packages, under Navide's data folder. */
  stagingRoot: string
}

const TARGET = /^[a-z0-9][a-z0-9-]{0,63}$/
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const NAME_PART = /^[a-z0-9][a-z0-9-]*$/
/** How long a staged package waits for Submit; after that the form says it
 * expired and the package is chosen again. */
const STAGE_TTL_MS = 60 * 60 * 1000

function callResult(res: { status: number; body: unknown }, ok: (status: number) => boolean): DeveloperCallResult {
  if (ok(res.status)) return { ok: true, status: res.status, body: res.body }
  const { code, message } = registryError(res.body)
  return { ok: false, status: res.status, code, message }
}

function errorCodeFor(res: DeveloperCallResult & { ok: false }): string {
  if (res.status === 401) return 'NOT_SIGNED_IN'
  if (res.code === 'QUALIFICATION_REQUIRED') return 'QUALIFICATION_REQUIRED'
  if (res.status === 404) return 'NOT_FOUND'
  return 'REGISTRY_UNAVAILABLE'
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

/** The application as the status tool and the form read it (the Registry's own field names). */
export function applicationView(body: unknown): Record<string, unknown> | null {
  const record = asRecord(body)
  if (typeof record.status !== 'string') return null
  return {
    status: record.status,
    fields: asRecord(record.fields),
    field_sources: asRecord(record.field_sources),
    source: typeof record.source === 'string' ? record.source : null,
    reason: typeof record.reason === 'string' ? record.reason : null,
    submitted_at: record.submitted_at ?? null,
    decided_at: record.decided_at ?? null,
  }
}

/** One version row of /api/publisher/me/versions, without the scan reports. */
export function versionView(item: unknown): Record<string, unknown> {
  const row = asRecord(item)
  return {
    namespace: row.namespace ?? null,
    name: row.name ?? null,
    version: row.version ?? null,
    channel: row.channel ?? null,
    targets: Array.isArray(row.targets) ? row.targets : [],
    status: row.status ?? null,
    yanked: row.yanked === true,
    reason: typeof row.reason === 'string' ? row.reason : null,
    submitted_at: row.submitted_at ?? null,
    reviewed_at: row.reviewed_at ?? null,
  }
}

/** Whether `url` is a Registry on this computer (O3): the host name is exactly
 *  localhost, ::1 or an IPv4 address in 127.0.0.0/8, after the WHATWG URL
 *  parser normalised it. Anything else, or anything unparsable, is the
 *  Navide Marketplace proper: fail closed. */
export function isLoopbackRegistryUrl(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
  const host = parsed.hostname.toLowerCase()
  if (host === 'localhost' || host === '[::1]') return true
  const octets = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  return octets !== null && octets.slice(1).every((part) => Number(part) <= 255)
}

/** O3: publish straight from a path, used only for a loopback Registry. */
export type PublishFromPath = (path: string, target: string) => Promise<
  { staged: StagedPackage; result: DeveloperCallResult & { digest?: string } }
>

export function createDeveloperQueryHandler(
  account: DeveloperAccount,
  publishFromPath?: PublishFromPath,
  registryUrl?: () => string,
): (query: unknown) => Promise<DeveloperQueryAnswer> {
  return async (raw) => {
    const query = asRecord(raw) as Partial<MarketplaceDeveloperQuery> & Record<string, unknown>
    if (query.kind === 'publish-direct') {
      // Only the Host decides whether the Registry is this computer's; the agent cannot say so.
      const url = registryUrl?.() ?? ''
      if (!publishFromPath || !isLoopbackRegistryUrl(url)) {
        return { ok: true, result: { kind: 'publish-direct', loopback: false } }
      }
      const path = typeof query.path === 'string' ? query.path : ''
      const target = typeof query.target === 'string' ? query.target : ''
      try {
        const { staged, result } = await publishFromPath(path, target)
        return {
          ok: true,
          result: {
            kind: 'publish-direct', loopback: true, published: result.ok, id: staged.id, version: staged.version,
            digest: staged.digest, status: result.status,
            ...(result.ok ? {} : { error_code: result.code, error: result.message }),
          },
        }
      } catch (error) {
        return {
          ok: true,
          result: {
            kind: 'publish-direct', loopback: true, published: false,
            error: redactDeveloperSecrets(error instanceof Error ? error.message : String(error)),
          },
        }
      }
    }
    const state = account.state()
    if (query.kind === 'developer-status') {
      if (!state.signedIn.account && !state.signedIn.publisher) {
        return { ok: false, error: 'the user has not signed in as a developer in Navide', error_code: 'NOT_SIGNED_IN' }
      }
      const res = callResult(await account.application(), (s) => s === 200)
      if (!res.ok) return { ok: false, error: res.message || `the Registry answered ${res.status}`, error_code: errorCodeFor(res) }
      return {
        ok: true,
        result: {
          kind: 'developer-status',
          signed_in: { account: state.signedIn.account, publisher: state.signedIn.publisher },
          namespace: state.namespace,
          key_registered: state.keyRegistered,
          application: applicationView(res.body),
        },
      }
    }
    if (query.kind === 'publish-status') {
      const id = typeof query.id === 'string' ? query.id : ''
      const res = callResult(await account.versions(), (s) => s === 200)
      if (!res.ok) return { ok: false, error: res.message || `the Registry answered ${res.status}`, error_code: errorCodeFor(res) }
      const body = asRecord(res.body)
      const items = (Array.isArray(body.items) ? body.items : [])
        .map(versionView)
        .filter((row) => !id || `${row.namespace}.${row.name}` === id)
      return { ok: true, result: { kind: 'publish-status', namespace: body.namespace ?? state.namespace, items } }
    }
    return { ok: false, error: 'developer query is malformed', error_code: 'BAD_REQUEST' }
  }
}

export function registerDeveloperIpc(deps: DeveloperIpcDeps): {
  stages: PackageStagingStore<StagedPackage>
  publishFromPath: PublishFromPath
} {
  const { account } = deps
  const stages = new PackageStagingStore<StagedPackage>(deps.stagingRoot, STAGE_TTL_MS, 'PUBLISH_STAGE_EXPIRED')
  const guard = (event: IpcMainInvokeEvent): void => {
    if (!deps.authorize(event)) throw new Error('unauthorized developer request')
  }
  const on = (channel: string, listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown): void =>
    deps.handle(channel, (event, ...args) => {
      guard(event)
      return listener(event, ...args)
    })

  on('developer:state', (): DeveloperPublicState => account.state())
  on('developer:signIn', (_event, scope): Promise<DeveloperPublicState> => {
    if (scope !== 'account' && scope !== 'publish') throw new Error('scope must be account or publish')
    return account.signIn(scope as DeveloperSignInScope)
  })
  on('developer:signOut', (): DeveloperPublicState => account.signOut())
  on('developer:registerKey', (): Promise<DeveloperPublicState> => account.registerKey())
  on('developer:application', async (): Promise<DeveloperCallResult> =>
    callResult(await account.application(), (s) => s === 200))
  on('developer:submitApplication', async (_event, raw): Promise<DeveloperCallResult> => {
    const input = asRecord(raw)
    const fields: Record<string, string | boolean> = {}
    for (const [key, value] of Object.entries(asRecord(input.fields))) {
      if (typeof value === 'string' || typeof value === 'boolean') fields[key] = value
    }
    const sources: Record<string, 'user' | 'agent-draft'> = {}
    for (const [key, value] of Object.entries(asRecord(input.fieldSources))) {
      if (key in fields) sources[key] = value === 'agent-draft' ? 'agent-draft' : 'user'
    }
    return callResult(await account.submitApplication(fields, sources), (s) => s === 201)
  })
  on('developer:versions', async (): Promise<DeveloperCallResult> => {
    const res = callResult(await account.versions(), (s) => s === 200)
    if (!res.ok) return res
    const body = asRecord(res.body)
    return { ...res, body: { namespace: body.namespace ?? null, items: (Array.isArray(body.items) ? body.items : []).map(versionView) } }
  })
  const stagePath = (path: string): StagedPackage => {
    if (!isAbsolute(path) || !path.toLowerCase().endsWith('.vsix')) throw new Error('choose a .vsix package')
    // Only a regular file is read (never a FIFO or a device), once.
    if (!statSync(path).isFile()) throw new Error('the package path is not a regular file')
    const bytes = new Uint8Array(readFileSync(path))
    const inspected = deps.inspectPackage(bytes)
    const manifest = inspected.manifest as { backend?: unknown }
    const hasBackend = !!manifest?.backend
    const staged: StagedPackage = {
      stageId: '',
      path,
      fileName: basename(path),
      id: inspected.id,
      version: inspected.version,
      publisher: inspected.publisher,
      digest: inspected.digest,
      size: bytes.byteLength,
      defaultTarget: hasBackend ? deps.hostTarget() : 'universal',
      hasBackend,
      disclosure: isManifestV2(manifest as never) ? computeDisclosure(manifest as never) : null,
    }
    staged.stageId = stages.stage(bytes, staged).id
    return staged
  }
  const view = (staged: StagedPackage): StagedPackage => ({ ...staged })
  /** Read a package once into a stage; `path` from a form (an agent's draft or a link), else a file dialog. */
  on('developer:stagePackage', async (event, rawPath): Promise<StagedPackage | null> => {
    let path = typeof rawPath === 'string' && rawPath ? rawPath : null
    if (path === null) path = await deps.pickPackageFile(event)
    if (path === null) return null
    return view(stagePath(path))
  })
  const publishStaged = async (stageId: string, rawTarget: unknown): Promise<DeveloperCallResult & { digest?: string }> => {
    // Re-read from disk and digest-checked; an expired stage throws PUBLISH_STAGE_EXPIRED.
    const entry = stages.take(stageId)
    if (!entry || !entry.bytes) throw new Error('the package is no longer staged; choose it again')
    const staged = entry.meta
    const target = typeof rawTarget === 'string' && rawTarget ? rawTarget : staged.defaultTarget
    if (!TARGET.test(target)) throw new Error('target must be a platform target such as darwin-arm64')
    const res = await account.publish(entry.bytes, staged.fileName, target)
    const result = callResult(res, (s) => s === 201)
    if (result.ok) stages.discard(stageId)
    return { ...result, digest: res.digest }
  }
  on('developer:publish', async (_event, raw): Promise<DeveloperCallResult & { digest?: string }> => {
    const input = asRecord(raw)
    if (typeof input.stageId !== 'string') throw new Error('the package is no longer staged; choose it again')
    return publishStaged(input.stageId, input.target)
  })
  on('developer:yank', async (_event, raw): Promise<DeveloperCallResult> => {
    const input = asRecord(raw)
    const { namespace, name, version } = input
    if (typeof namespace !== 'string' || !NAME_PART.test(namespace) || typeof name !== 'string' || !name ||
      typeof version !== 'string' || !SEMVER.test(version)) {
      throw new Error('a yank needs a Navide plugin id and a version')
    }
    return callResult(await account.yank(namespace, name, version), (s) => s === 200)
  })
  const publishFromPath: PublishFromPath = async (path, target) => {
    const staged = stagePath(path)
    return { staged: view(staged), result: await publishStaged(staged.stageId, target) }
  }
  return { stages, publishFromPath }
}
