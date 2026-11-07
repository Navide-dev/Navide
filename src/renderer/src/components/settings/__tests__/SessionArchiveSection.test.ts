// @vitest-environment happy-dom
// Settings → General → Session log archive. Pinned: everything shows off as the
// backend reports it, the S3 fields appear only once uploading is on, there is
// no field for an AWS key, and each change is one archive.settings.set.
import { describe, expect, it } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

import { i18n } from '@navide/plugin-ui/foundation'

import SessionArchiveSection from '../SessionArchiveSection.vue'
import { createMockBackend } from '../../../composables/__tests__/mockBackend'

const OFF = {
  compress_enabled: false,
  idle_days: 7,
  remove_originals: false,
  upload_enabled: false,
  upload_after_days: 30,
  s3_bucket: '',
  s3_prefix: 'navide-sessions/',
  s3_region: '',
}

async function mountSection(settings = OFF) {
  const mock = createMockBackend()
  mock.setResponse('archive.settings.get', settings)
  mock.setResponse('archive.settings.set', settings)
  const w = mount(SessionArchiveSection, { props: { backend: mock.backend }, global: { plugins: [i18n] } })
  await flushPromises()
  return { w, mock }
}

describe('Session log archive', () => {
  it('reads the settings and shows every switch off, with no S3 fields yet', async () => {
    const { w, mock } = await mountSection()
    expect(mock.sent.map((m) => m.type)).toEqual(['archive.settings.get'])
    expect(w.get('[data-testid="archive-compress-toggle"]').attributes('aria-checked')).toBe('false')
    expect(w.get('[data-testid="archive-upload-toggle"]').attributes('aria-checked')).toBe('false')
    expect(w.find('[data-testid="archive-idle-days"]').exists()).toBe(false)
    expect(w.find('[data-testid="archive-bucket"]').exists()).toBe(false)
  })

  it('turning compression on is one set call', async () => {
    const { w, mock } = await mountSection()
    mock.setResponse('archive.settings.set', { ...OFF, compress_enabled: true })
    await w.get('[data-testid="archive-compress-toggle"]').trigger('click')
    await flushPromises()
    expect(mock.sent.at(-1)).toMatchObject({ type: 'archive.settings.set', payload: { compress_enabled: true } })
    expect(w.find('[data-testid="archive-idle-days"]').exists()).toBe(true)
    expect(w.get('[data-testid="archive-remove-originals-toggle"]').attributes('aria-checked')).toBe('false')
  })

  it('with uploading on, saves bucket, prefix and region and offers no key field', async () => {
    const { w, mock } = await mountSection({ ...OFF, upload_enabled: true })
    const bucket = w.get('[data-testid="archive-bucket"]')
    await bucket.setValue('  nt-archive ')
    await bucket.trigger('change')
    expect(mock.sent.at(-1)).toMatchObject({ type: 'archive.settings.set', payload: { s3_bucket: 'nt-archive' } })
    expect(w.find('[data-testid="archive-prefix"]').exists()).toBe(true)
    expect(w.find('[data-testid="archive-region"]').exists()).toBe(true)
    expect(w.findAll('input').some((i) => /key|secret/i.test(i.attributes('data-testid') ?? ''))).toBe(false)
    expect(w.text()).toContain('AWS')
  })

  it('a day count is saved as a whole number of days', async () => {
    const { w, mock } = await mountSection({ ...OFF, compress_enabled: true })
    const days = w.get('[data-testid="archive-idle-days"]')
    await days.setValue('14')
    await days.trigger('change')
    expect(mock.sent.filter((m) => m.type === 'archive.settings.set').at(-1)?.payload).toEqual({ idle_days: 14 })
  })

  it('a failed save says so', async () => {
    const { w, mock } = await mountSection()
    mock.setResponse('archive.settings.set', null, { ok: false, error: { code: 'x', message: 'disk full' } })
    await w.get('[data-testid="archive-upload-toggle"]').trigger('click')
    await flushPromises()
    expect(w.get('[data-testid="archive-error"]').text()).toBe('disk full')
  })
})
