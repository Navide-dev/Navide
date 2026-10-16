import { describe, expect, it, vi } from 'vitest'
import { answerMarketplaceQuery, MarketplaceHttpError, type MarketplaceQuerySources } from './marketplaceQuery'

const card = {
  manifest: {
    schemaVersion: 1,
    plugin: { id: 'nerdtechnic.devmap', version: '0.2.0', publisher: 'nerdtechnic' },
    summary: { template: 'plugin-disclosure.summary.v1', clauses: [{ key: 'nativeBackend', params: {} }] },
    risk: { level: 'high', reasons: [{ key: 'nativeBackend', level: 'high' }] },
  },
  registry: { publisher: { name: 'Nerdtechnic', verifiedDomain: 'nerdtechnic.com', domainVerifiedAt: null } },
}

const row = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  namespace: 'nerdtechnic',
  name: 'devmap',
  display_name: 'Dev map',
  description: 'Draws the dev map.',
  latest_version: '0.2.0',
  download_count: 7,
  trust_tier: 'signed-verified',
  ...extra,
})

function sources(overrides: Partial<MarketplaceQuerySources> = {}): MarketplaceQuerySources {
  return {
    search: vi.fn(async () => ({ items: [row()], total: 1 })),
    detail: vi.fn(async () => ({
      ...row(),
      publisher: 'nerdtechnic',
      versions: [
        { version: '0.2.0', yanked: false, trust_tier: 'signed-verified' },
        { version: '0.2.0', yanked: false, trust_tier: 'signed-verified' },
        { version: '0.1.1', yanked: true, trust_tier: 'signed-verified' },
        { version: '0.1.0', yanked: false, trust_tier: 'unsigned' },
      ],
    })),
    installed: vi.fn(() => []),
    ...overrides,
  }
}

describe('answerMarketplaceQuery: search', () => {
  it('runs the Marketplace search and maps each row to a listing item without a disclosure', async () => {
    const src = sources()
    const answer = await answerMarketplaceQuery({ kind: 'search', text: 'dev map', category: 'productivity', limit: 20 }, src)

    expect(src.search).toHaveBeenCalledWith('dev map', { category: 'productivity', limit: 20 })
    expect(answer).toEqual({
      ok: true,
      result: {
        kind: 'search',
        nextCursor: null,
        items: [{
          id: 'nerdtechnic.devmap',
          version: '0.2.0',
          name: 'Dev map',
          description: 'Draws the dev map.',
          publisher: { name: 'nerdtechnic', verifiedDomain: null },
          signed: true,
          downloads: 7,
          risk: null,
          summary: null,
        }],
      },
    })
  })

  it('pages with the cursor as an offset and reports the next one while rows remain', async () => {
    const src = sources({ search: vi.fn(async () => ({ items: [row(), row({ name: 'other' })], total: 5 })) })
    const answer = await answerMarketplaceQuery({ kind: 'search', text: '', cursor: '2', limit: 2 }, src)
    expect(src.search).toHaveBeenCalledWith('', { offset: 2, limit: 2 })
    expect(answer.ok && answer.result.kind === 'search' && answer.result.nextCursor).toBe('4')
  })

  it('carries the disclosure card risk and summary when the Registry sends one', async () => {
    const src = sources({ search: vi.fn(async () => ({ items: [row({ disclosure: card, trust_tier: 'unsigned' })] })) })
    const answer = await answerMarketplaceQuery({ kind: 'search', text: 'x' }, src)
    if (!answer.ok || answer.result.kind !== 'search') throw new Error('expected a search result')
    const [item] = answer.result.items
    expect(item.risk).toBe('high')
    expect(item.summary).toEqual(card.manifest.summary)
    expect(item.signed).toBe(false)
    expect(item.publisher.verifiedDomain).toBe('nerdtechnic.com')
  })

  it.each([
    [{ kind: 'search' }],
    [{ kind: 'search', text: 'x', limit: 0 }],
    [{ kind: 'search', text: 'x', limit: 101 }],
    [{ kind: 'search', text: 'x', cursor: '-1' }],
    [{ kind: 'search', text: 'x', cursor: 'abc' }],
    [{ kind: 'search', text: 'x', sort: 'downloads' }],
    [{ kind: 'nope' }],
    [null],
  ])('refuses %j as BAD_REQUEST without fetching', async (query) => {
    const src = sources()
    const answer = await answerMarketplaceQuery(query, src)
    expect(answer).toEqual(expect.objectContaining({ ok: false, error_code: 'BAD_REQUEST' }))
    expect(src.search).not.toHaveBeenCalled()
  })

  it('reports a failed Registry fetch as REGISTRY_UNAVAILABLE', async () => {
    const src = sources({ search: vi.fn(async () => { throw new MarketplaceHttpError('marketplace search failed: HTTP 503', 503) }) })
    expect(await answerMarketplaceQuery({ kind: 'search', text: 'x' }, src)).toEqual({
      ok: false, error: 'marketplace search failed: HTTP 503', error_code: 'REGISTRY_UNAVAILABLE',
    })
  })
})

describe('answerMarketplaceQuery: detail', () => {
  it('maps the Marketplace detail, lists published versions once each and has no card yet', async () => {
    const src = sources()
    const answer = await answerMarketplaceQuery({ kind: 'detail', id: 'nerdtechnic.devmap' }, src)
    expect(src.detail).toHaveBeenCalledWith('nerdtechnic', 'devmap')
    expect(answer).toEqual({
      ok: true,
      result: expect.objectContaining({ kind: 'detail', versions: ['0.2.0', '0.1.0'], card: null }),
    })
    if (answer.ok && answer.result.kind === 'detail') {
      expect(answer.result.item).toEqual(expect.objectContaining({ id: 'nerdtechnic.devmap', version: '0.2.0', signed: true }))
    }
  })

  it('selects a requested version, and refuses one that is not published', async () => {
    const picked = await answerMarketplaceQuery({ kind: 'detail', id: 'nerdtechnic.devmap', version: '0.1.0' }, sources())
    expect(picked.ok && picked.result.kind === 'detail' && picked.result.item).toEqual(
      expect.objectContaining({ version: '0.1.0', signed: false }),
    )
    expect(await answerMarketplaceQuery({ kind: 'detail', id: 'nerdtechnic.devmap', version: '0.1.1' }, sources())).toEqual(
      expect.objectContaining({ ok: false, error_code: 'NOT_FOUND' }),
    )
  })

  it('maps a Registry 404 to NOT_FOUND and other failures to REGISTRY_UNAVAILABLE', async () => {
    const missing = sources({ detail: vi.fn(async () => { throw new MarketplaceHttpError('marketplace detail failed: HTTP 404', 404) }) })
    expect(await answerMarketplaceQuery({ kind: 'detail', id: 'acme.none' }, missing)).toEqual(
      expect.objectContaining({ ok: false, error_code: 'NOT_FOUND' }),
    )
    const down = sources({ detail: vi.fn(async () => { throw new TypeError('fetch failed') }) })
    expect(await answerMarketplaceQuery({ kind: 'detail', id: 'acme.none' }, down)).toEqual({
      ok: false, error: 'fetch failed', error_code: 'REGISTRY_UNAVAILABLE',
    })
  })

  it.each(['nodot', '.lead', 'trail.', 7])('refuses the id %j as BAD_REQUEST', async (id) => {
    const src = sources()
    expect(await answerMarketplaceQuery({ kind: 'detail', id }, src)).toEqual(
      expect.objectContaining({ ok: false, error_code: 'BAD_REQUEST' }),
    )
    expect(src.detail).not.toHaveBeenCalled()
  })
})

describe('answerMarketplaceQuery: installed', () => {
  it('projects the inventory onto ids and states', async () => {
    const src = sources({
      installed: vi.fn(() => [
        { id: 'navide.plans', packageVersion: '1.0.0', hasBackend: true },
        { id: 'nerdtechnic.devmap', packageVersion: '0.1.0', disabled: true },
        { id: 'acme.legacy' },
      ]),
    })
    expect(await answerMarketplaceQuery({ kind: 'installed' }, src)).toEqual({
      ok: true,
      result: {
        kind: 'installed',
        items: [
          { id: 'navide.plans', version: '1.0.0', enabled: true, quarantined: false, hasBackend: true, agentTools: [] },
          { id: 'nerdtechnic.devmap', version: '0.1.0', enabled: false, quarantined: false, hasBackend: false, agentTools: [] },
          { id: 'acme.legacy', version: '', enabled: true, quarantined: false, hasBackend: false, agentTools: [] },
        ],
      },
    })
  })

  it('refuses an installed query with fields', async () => {
    expect(await answerMarketplaceQuery({ kind: 'installed', id: 'x' }, sources())).toEqual(
      expect.objectContaining({ ok: false, error_code: 'BAD_REQUEST' }),
    )
  })
})
