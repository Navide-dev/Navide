/**
 * The Host side of `marketplace.query` (plan B, B2-a; contract section 4.3).
 *
 * The backend's read-only Marketplace MCP tools ask the Host over its
 * authenticated session. The Host answers from the same functions the
 * Marketplace page uses (`plugins:marketplaceSearch`, `plugins:marketplaceDetail`,
 * `plugins:listInstalled` in pluginIpc.ts); this module only checks the query
 * and maps those answers onto the contract shapes. It decides nothing about
 * trust: install still goes through prepareInstall and the user's consent.
 *
 * The disclosure (risk, summary, card) is reported when the Registry answer
 * carries it under `disclosure` as a DisclosureCard, and as null otherwise:
 * until D-b brings it through the IPC, a listing has none, and nothing here
 * invents one.
 */
import type {
  MarketplaceInstalledItem,
  MarketplaceListingItem,
  MarketplaceQueryResponse,
} from '../../shared/pluginAgentTools'
import type { DisclosureCard, DisclosureRiskLevel } from '../../shared/pluginDisclosure'

/** A ListingItem whose disclosure may be missing (null) until the Registry provides one. */
export type MarketplaceQueryListingItem = Omit<MarketplaceListingItem, 'risk' | 'summary'> & {
  risk: MarketplaceListingItem['risk'] | null
  summary: MarketplaceListingItem['summary'] | null
}

export type MarketplaceQueryResult =
  | { kind: 'search'; items: MarketplaceQueryListingItem[]; nextCursor: string | null }
  | { kind: 'detail'; item: MarketplaceQueryListingItem; versions: string[]; card: DisclosureCard | null }
  | { kind: 'installed'; items: MarketplaceInstalledItem[] }

type ErrorCode = Extract<MarketplaceQueryResponse, { ok: false }>['error_code']

/** `marketplace.query.result` without its request_id. */
export type MarketplaceQueryAnswer =
  | { ok: true; result: MarketplaceQueryResult }
  | { ok: false; error: string; error_code: ErrorCode }

/** Thrown by the Marketplace fetches with the Registry's HTTP status; the message is unchanged. */
export class MarketplaceHttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = 'MarketplaceHttpError'
  }
}

export interface MarketplaceQuerySources {
  search(
    text: string,
    options: { category?: string; offset?: number; limit: number },
  ): Promise<{ items?: Array<Record<string, unknown>>; total?: unknown }>
  detail(namespace: string, name: string): Promise<Record<string, unknown>>
  installed(): Array<{ id: string; packageVersion?: string; disabled?: boolean; hasBackend?: boolean }>
}

const DEFAULT_LIMIT = 20
const RISK_LEVELS: readonly DisclosureRiskLevel[] = ['low', 'medium', 'high', 'highest']

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const text = (value: unknown): string => (typeof value === 'string' ? value : '')

function bad(error: string): MarketplaceQueryAnswer {
  return { ok: false, error, error_code: 'BAD_REQUEST' }
}

/** The Registry's DisclosureCard, when it sent a well-formed one. */
function disclosureCard(value: unknown): DisclosureCard | null {
  if (!isRecord(value) || !isRecord(value.manifest)) return null
  const manifest = value.manifest
  if (!isRecord(manifest.risk) || !RISK_LEVELS.includes(manifest.risk.level as DisclosureRiskLevel)) return null
  if (!isRecord(manifest.summary) || !Array.isArray(manifest.summary.clauses)) return null
  return value as unknown as DisclosureCard
}

function listingItem(
  raw: Record<string, unknown>,
  version: string,
  signed: boolean,
  publisher: string,
): MarketplaceQueryListingItem {
  const card = disclosureCard(raw.disclosure)
  const namespace = text(raw.namespace)
  const name = text(raw.name)
  return {
    id: `${namespace}.${name}`,
    version,
    name: text(raw.display_name) || name,
    description: text(raw.description),
    publisher: { name: publisher, verifiedDomain: card?.registry?.publisher.verifiedDomain ?? null },
    signed,
    downloads: typeof raw.download_count === 'number' ? raw.download_count : 0,
    risk: card ? card.manifest.risk.level : null,
    summary: card ? card.manifest.summary : null,
  }
}

function registryFailure(error: unknown, notFound: boolean): MarketplaceQueryAnswer {
  const message = error instanceof Error ? error.message : String(error)
  if (notFound && error instanceof MarketplaceHttpError && error.status === 404) {
    return { ok: false, error: message, error_code: 'NOT_FOUND' }
  }
  return { ok: false, error: message, error_code: 'REGISTRY_UNAVAILABLE' }
}

/** Answer one `marketplace.query` from the Marketplace page's own functions. */
export async function answerMarketplaceQuery(
  query: unknown,
  sources: MarketplaceQuerySources,
): Promise<MarketplaceQueryAnswer> {
  if (!isRecord(query)) return bad('query must be an object')
  if (query.kind === 'installed') {
    if (Object.keys(query).length !== 1) return bad('an installed query has no fields')
    const items = sources.installed().map((summary): MarketplaceInstalledItem => ({
      id: summary.id,
      version: summary.packageVersion ?? '',
      enabled: summary.disabled !== true,
      // A package that fails trust verification is unloaded from the
      // inventory, so a listed package is never in quarantine.
      quarantined: false,
      hasBackend: summary.hasBackend === true,
      // No package can declare agent tools before B1 accepts the field.
      agentTools: [],
    }))
    return { ok: true, result: { kind: 'installed', items } }
  }
  if (query.kind === 'search') {
    const allowed = new Set(['kind', 'text', 'category', 'cursor', 'limit'])
    if (Object.keys(query).some((key) => !allowed.has(key))) return bad('unknown search field')
    if (typeof query.text !== 'string') return bad('text must be a string')
    if (query.category !== undefined && query.category !== null && typeof query.category !== 'string') {
      return bad('category must be a string')
    }
    let offset = 0
    if (query.cursor !== undefined && query.cursor !== null) {
      if (typeof query.cursor !== 'string' || !/^(0|[1-9][0-9]{0,8})$/.test(query.cursor)) {
        return bad('cursor must be a nextCursor of a previous page')
      }
      offset = Number(query.cursor)
    }
    const limit = query.limit ?? DEFAULT_LIMIT
    if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 100) {
      return bad('limit must be an integer from 1 to 100')
    }
    let body: Awaited<ReturnType<MarketplaceQuerySources['search']>>
    try {
      body = await sources.search(query.text, {
        ...(typeof query.category === 'string' && query.category ? { category: query.category } : {}),
        ...(offset > 0 ? { offset } : {}),
        limit: limit as number,
      })
    } catch (error) {
      return registryFailure(error, false)
    }
    const rows = (body.items ?? []).filter(isRecord)
    const items = rows.map((row) =>
      listingItem(row, text(row.latest_version), row.trust_tier === 'signed-verified', text(row.publisher) || text(row.namespace)))
    const next = offset + rows.length
    const nextCursor = typeof body.total === 'number' && rows.length > 0 && next < body.total ? String(next) : null
    return { ok: true, result: { kind: 'search', items, nextCursor } }
  }
  if (query.kind === 'detail') {
    if (Object.keys(query).some((key) => !['kind', 'id', 'version'].includes(key))) return bad('unknown detail field')
    const id = query.id
    const dot = typeof id === 'string' ? id.indexOf('.') : -1
    if (typeof id !== 'string' || dot <= 0 || dot === id.length - 1) return bad('id must be <namespace>.<name>')
    if (query.version !== undefined && query.version !== null && typeof query.version !== 'string') {
      return bad('version must be a string')
    }
    let detail: Record<string, unknown>
    try {
      detail = await sources.detail(id.slice(0, dot), id.slice(dot + 1))
    } catch (error) {
      return registryFailure(error, true)
    }
    const rows = (Array.isArray(detail.versions) ? detail.versions : []).filter(isRecord)
    const published = rows.filter((row) => row.yanked !== true && typeof row.version === 'string')
    const versions = [...new Set(published.map((row) => row.version as string))]
    const wanted = typeof query.version === 'string' && query.version ? query.version : text(detail.latest_version)
    if (typeof query.version === 'string' && query.version && !versions.includes(wanted)) {
      return { ok: false, error: `${id} has no published version ${wanted}`, error_code: 'NOT_FOUND' }
    }
    const signed = published.some((row) => row.version === wanted && row.trust_tier === 'signed-verified')
    const item = listingItem(detail, wanted, signed, text(detail.publisher) || text(detail.namespace))
    return { ok: true, result: { kind: 'detail', item, versions, card: disclosureCard(detail.disclosure) } }
  }
  return bad('query.kind must be search, detail or installed')
}
