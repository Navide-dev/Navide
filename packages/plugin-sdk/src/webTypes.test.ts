import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import { capabilitiesV1, type JsonValue, type Params, type Payload, type PublicMethod, type Result, type WebViewSummary } from '@navide/plugin-contracts'
import { createPluginCapabilityClient } from './index'

// Compile-time: `tsc -p packages/plugin-sdk/tsconfig.json` (pnpm typecheck:public) checks this file.
// The same list as WEB_METHODS in src/main/plugins/webCapability.ts; the test below holds it to the catalog.
const WEB_METHODS = [
  'web.list', 'web.create', 'web.attach', 'web.detach', 'web.navigate', 'web.setOwner',
  'web.takeControl', 'web.returnControl', 'web.close', 'web.capture', 'web.clearData', 'web.cdp',
] as const
expectTypeOf<(typeof WEB_METHODS)[number]>().toExtend<PublicMethod>()

expectTypeOf<Params<'web.cdp'>>().toEqualTypeOf<{ viewId: string; method: string; params?: { [key: string]: JsonValue } }>()
expectTypeOf<Result<'web.cdp'>>().toEqualTypeOf<{ result: JsonValue }>()
expectTypeOf<Params<'web.create'>>().toEqualTypeOf<{ space: string; url?: string }>()
expectTypeOf<Result<'web.create'>>().toEqualTypeOf<{ viewId: string }>()
expectTypeOf<Params<'web.setOwner'>['owner']>().toEqualTypeOf<'agent' | 'user'>()
expectTypeOf<Result<'web.list'>>().toEqualTypeOf<{ views: WebViewSummary[] }>()
expectTypeOf<Payload<'web.changed'>>().toEqualTypeOf<{ views: WebViewSummary[] }>()

function navigateParamsAreExclusive(): void {
  const url: Params<'web.navigate'> = { viewId: 'v', url: 'https://example.com' }
  const action: Params<'web.navigate'> = { viewId: 'v', action: 'reload' }
  // @ts-expect-error url and action are mutually exclusive
  const both: Params<'web.navigate'> = { viewId: 'v', url: 'https://example.com', action: 'reload' }
  // @ts-expect-error web.cdp needs a method
  const noMethod: Params<'web.cdp'> = { viewId: 'v' }
  void [url, action, both, noMethod]
}
void navigateParamsAreExclusive

describe('web.* public methods', () => {
  afterEach(() => {
    delete (globalThis as { nav?: unknown }).nav
  })

  it('types every public web.* method of the capability catalog', () => {
    const catalog = (capabilitiesV1 as unknown as { methods: Array<{ address: string; visibility: string }> }).methods
      .filter((method) => method.address.startsWith('web.') && method.visibility === 'public')
      .map((method) => method.address)
    expect([...catalog].sort()).toEqual([...WEB_METHODS].sort())
  })

  it('routes web.cdp through the capability bridge with its typed result', async () => {
    const callCapability = vi.fn(() => Promise.resolve({ reqId: 'cap-web', ok: true, result: { result: { frameId: 'f1' } } }))
    ;(globalThis as unknown as { nav: unknown }).nav = { callCapability, on: vi.fn() }

    const response = await createPluginCapabilityClient().capabilities.invoke('web.cdp', {
      viewId: 'view-1',
      method: 'Page.navigate',
      params: { url: 'https://example.com' },
    })

    expectTypeOf(response).toEqualTypeOf<{ result: JsonValue }>()
    expect(response).toEqual({ result: { frameId: 'f1' } })
    expect(callCapability).toHaveBeenCalledWith('web', 'cdp', {
      viewId: 'view-1',
      method: 'Page.navigate',
      params: { url: 'https://example.com' },
    })
  })
})
