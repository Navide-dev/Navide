// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import OfficePreview from '../OfficePreview.vue'
import { i18n } from '@navide/plugin-ui/foundation'

i18n.global.locale.value = 'en-US'

function makeBackend(resp: unknown) {
  return {
    httpUrl: ref('http://127.0.0.1:8123'),
    status: ref('connected'),
    send: vi.fn(async () => ({ payload: resp })),
  }
}

async function mountOffice(resp: unknown, relPath = 'docs/report.docx') {
  const backend = makeBackend(resp)
  const wrapper = mount(OfficePreview, {
    props: {
      workspacePath: '/ws',
      relPath,
      name: relPath.split('/').pop()!,
      backend: backend as never,
    },
    global: { plugins: [i18n] },
  })
  await flushPromises()
  return { wrapper, backend }
}

describe('OfficePreview – docx', () => {
  it('requests fs.convert_office and renders the HTML in a fully sandboxed iframe', async () => {
    const { wrapper, backend } = await mountOffice({
      ok: true,
      kind: 'docx',
      html: '<h1>Report</h1><p>body</p>',
    })
    expect(backend.send).toHaveBeenCalledWith('fs.convert_office', {
      workspace_path: '/ws',
      rel_path: 'docs/report.docx',
    })
    const frame = wrapper.find('iframe.offp-frame')
    expect(frame.exists()).toBe(true)
    expect(frame.attributes('srcdoc')).toBe('<h1>Report</h1><p>body</p>')
    // Empty sandbox attribute = no allow-* tokens (scripts/forms blocked).
    expect(frame.attributes('sandbox')).toBe('')
    // The converted HTML must never render into the app origin (no v-html).
    expect(wrapper.find('h1').exists()).toBe(false)
  })
})

describe('OfficePreview – xlsx', () => {
  const sheetsResp = {
    ok: true,
    kind: 'xlsx',
    sheets: [
      { name: 'Summary', rows: [['a', 'b'], ['1', '2']], truncated: false },
      { name: 'Data', rows: [['x']], truncated: true },
    ],
  }

  it('renders one tab per sheet and the active sheet table', async () => {
    const { wrapper } = await mountOffice(sheetsResp, 'docs/data.xlsx')
    const tabs = wrapper.findAll('.offp-tab')
    expect(tabs.map((t) => t.text())).toEqual(['Summary', 'Data'])
    expect(tabs[0].classes()).toContain('offp-tab--active')
    expect(wrapper.findAll('tbody tr')).toHaveLength(2)
    expect(wrapper.findAll('td.offp-td')[0].text()).toBe('a')
  })

  it('switches sheets on tab click and shows the truncated notice', async () => {
    const { wrapper } = await mountOffice(sheetsResp, 'docs/data.xlsx')
    expect(wrapper.text()).not.toContain('sheet data truncated')
    await wrapper.findAll('.offp-tab')[1].trigger('click')
    expect(wrapper.findAll('tbody tr')).toHaveLength(1)
    expect(wrapper.find('td.offp-td').text()).toBe('x')
    expect(wrapper.text()).toContain('sheet data truncated')
  })
})

describe('OfficePreview – errors', () => {
  it('shows the error card when the backend reports a failure', async () => {
    const { wrapper } = await mountOffice({ ok: false, error: 'file too large (max 10 MB)' })
    const err = wrapper.find('.offp-card-error')
    expect(err.text()).toContain('Failed to convert the document.')
    expect(err.text()).toContain('file too large (max 10 MB)')
    expect(wrapper.find('iframe').exists()).toBe(false)
  })

  it('shows the error card for an unexpected response shape', async () => {
    const { wrapper } = await mountOffice({ ok: true })
    expect(wrapper.find('.offp-card-error').text()).toContain('unexpected response')
  })
})
