// @vitest-environment happy-dom
// ShippedLogPanel: every request names the workspace the panel was opened
// for; the window buttons re-read the report; a detected command can be
// confirmed (an entry plus its detection id) or dismissed; an item's line can
// be rewritten; a setting is registered by name and place; the digest saves
// its settings and refuses a bad time before sending anything.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { ref } from 'vue'
import { i18n } from '@navide/plugin-ui/foundation'
import type { useBackend } from '../../composables/useBackend'
import {
  __resetShippedLogForTest,
  openShippedLogPanel,
  type ShipItem,
  type ShipReport,
} from '../../composables/useShippedLog'
import ShippedLogPanel from '../ShippedLogPanel.vue'

const WS = '/Users/me/dealpilot'

const item = (over: Partial<ShipItem>): ShipItem => ({
  key: 'k', at: 1_900_000_000, summary: 's', kind: 'recorded', bases: ['agent'], source_kind: 'other',
  hash: '', short_hash: '', tags: [], sensitive: false, ...over,
})

const report = (): ShipReport => ({
  since: '2026-11-20T00:00:00+08:00', until: null, branch: 'main', count: 2, omitted: 0, pending_detections: 1,
  warnings: [],
  items: [
    item({ key: 'commit:abc', kind: 'added', summary: 'invoice export', bases: ['branch'], source_kind: 'commit',
           hash: 'abc', short_hash: 'abc1234' }),
    item({ key: 'r1', summary: 'Sender moved', source_kind: 'config', sensitive: true, config_label: 'Sender address' }),
    item({ key: 'detect:7', kind: 'detected', summary: 'npm publish', bases: ['hook'], detection_id: 7,
           rule: 'package-publish' }),
  ],
})

const calls: { type: string; payload: Record<string, unknown> }[] = []

function fakeBackend(): ReturnType<typeof useBackend> {
  return {
    status: ref('connected'),
    send: vi.fn(async (type: string, payload: Record<string, unknown> = {}) => {
      calls.push({ type, payload })
      let body: unknown = { ok: true }
      if (type === 'ship_log.report') body = { ok: true, ...report() }
      else if (type === 'ship_log.configs') body = { ok: true, configs: [] }
      else if (type === 'ship_log.digest_get') {
        body = { ok: true, job_id: 'j', next_run_at: null, last_run_at: null, last_status: null, last_skip_reason: null,
                 settings: { digest_enabled: false, digest_at: '09:00', digest_tz: '', digest_skip_empty: true } }
      } else if (type === 'ship_log.config_set' && String(payload.location).includes('=')) {
        body = { ok: false, error: 'refused: this looks like it carries a value' }
      }
      return { id: 'r', type, ok: true, payload: body, error: null, timestamp: '' }
    }),
    on: () => () => {},
  } as unknown as ReturnType<typeof useBackend>
}

const sent = (type: string) => calls.filter((c) => c.type === type).map((c) => c.payload)

describe('ShippedLogPanel', () => {
  let wrapper: VueWrapper | undefined

  beforeEach(async () => {
    i18n.global.locale.value = 'zh-TW'
    calls.length = 0
    __resetShippedLogForTest()
    wrapper = mount(ShippedLogPanel, { props: { backend: fakeBackend() }, global: { plugins: [i18n] }, attachTo: document.body })
    openShippedLogPanel(WS)
    await flushPromises()
  })
  afterEach(() => {
    wrapper?.unmount()
    __resetShippedLogForTest()
  })

  const q = (sel: string) => document.body.querySelector(sel) as HTMLElement | null
  const click = async (sel: string) => {
    q(sel)!.click()
    await flushPromises()
  }
  const type = async (sel: string, value: string) => {
    const el = q(sel) as HTMLInputElement
    el.value = value
    el.dispatchEvent(new Event('input'))
    await flushPromises()
  }

  it('reads everything for the workspace it was opened for and lists the items', () => {
    expect(calls.map((c) => c.type).sort()).toEqual(['ship_log.configs', 'ship_log.digest_get', 'ship_log.report'])
    expect(calls.every((c) => c.payload.workspace === WS)).toBe(true)
    expect(q('[data-test="summary"]')!.textContent).toContain('上線 2 筆')
    expect(q('[data-test="summary"]')!.textContent).toContain('待確認的部署指令 1 筆')
    expect(q('[data-test="item-commit:abc"]')!.textContent).toContain('新增 invoice export')
    expect(q('[data-test="item-r1"]')!.textContent).toContain('Sender address')
    expect(q('[data-test="item-r1"]')!.textContent).toContain('敏感')
  })

  it('re-reads the report for another window', async () => {
    await click('[data-test="window-7d"]')
    expect(sent('ship_log.report').at(-1)).toEqual({ workspace: WS, since: '7d' })
  })

  it('confirms a detected command as an entry carrying its detection id, or dismisses it', async () => {
    await click('[data-test="item-detect:7"] [data-test="confirm"]')
    await type('[data-test="confirm-form"] input', 'Published 2.0')
    await click('[data-test="confirm-save"]')
    expect(sent('ship_log.record')).toEqual([{ workspace: WS, summary: 'Published 2.0', source_kind: 'other',
                                               at: new Date(1_900_000_000 * 1000).toISOString(), detection_id: 7 }])
    await click('[data-test="item-detect:7"] [data-test="dismiss"]')
    expect(sent('ship_log.detection')).toEqual([{ workspace: WS, id: 7, status: 'dismissed' }])
  })

  it('rewrites an item line through an override', async () => {
    await click('[data-test="item-commit:abc"] [data-test="edit"]')
    await type('[data-test="edit-form"] input', 'Invoices export as CSV')
    await click('[data-test="edit-save"]')
    expect(sent('ship_log.override')).toEqual([{ workspace: WS, item_key: 'commit:abc', summary: 'Invoices export as CSV',
                                                 sensitive: false }])
  })

  it('shows the backend refusal of a setting that carries a value', async () => {
    await type('[data-field="cfg-key"]', 'mail.sender')
    await type('[data-field="cfg-location"]', 'MAIL_FROM=x')
    await click('[data-test="config-save"]')
    expect(sent('ship_log.config_set')[0]).toMatchObject({ workspace: WS, key: 'mail.sender', location: 'MAIL_FROM=x' })
    expect(q('[data-test="op-error"]')!.textContent).toContain('value')
  })

  it('saves digest settings and refuses a bad time before sending', async () => {
    await type('[data-field="digest-at"]', '8pm')
    expect(q('[data-test="digest-error"]')).not.toBeNull()
    expect((q('[data-test="digest-save"]') as HTMLButtonElement).disabled).toBe(true)
    await type('[data-field="digest-at"]', '18:30')
    ;(q('[data-field="digest-enabled"]') as HTMLInputElement).click()
    await flushPromises()
    await click('[data-test="digest-save"]')
    expect(sent('ship_log.digest_set')).toEqual([{ workspace: WS, settings: { digest_enabled: true, digest_at: '18:30',
                                                                            digest_tz: '', digest_skip_empty: true } }])
  })

  it('closes', async () => {
    await click('[data-test="close"]')
    expect(q('[data-test="shipped-log-panel"]')).toBeNull()
  })
})
