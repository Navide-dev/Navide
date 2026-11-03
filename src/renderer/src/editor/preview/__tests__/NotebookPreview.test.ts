// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import NotebookPreview from '../NotebookPreview.vue'
import { i18n } from '@navide/plugin-ui/foundation'

i18n.global.locale.value = 'en-US'

function makeBackend(resp: unknown) {
  return {
    httpUrl: ref('http://127.0.0.1:8123'),
    status: ref('connected'),
    send: vi.fn(async () => ({ payload: resp })),
  }
}

function nb(cells: unknown[]): string {
  return JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells })
}

async function mountNb(content: string | null) {
  const backend = makeBackend(
    content === null ? { ok: false, error: 'no such file' } : { ok: true, content },
  )
  const wrapper = mount(NotebookPreview, {
    props: {
      workspacePath: '/ws',
      relPath: 'nb/demo.ipynb',
      name: 'demo.ipynb',
      backend: backend as never,
    },
    global: { plugins: [i18n] },
  })
  await flushPromises()
  return { wrapper, backend }
}

describe('NotebookPreview – cells', () => {
  it('requests the file over fs.read_file and renders markdown cells', async () => {
    const { wrapper, backend } = await mountNb(
      nb([{ cell_type: 'markdown', source: ['# Title\n', '- item one\n'] }]),
    )
    expect(backend.send).toHaveBeenCalledWith('fs.read_file', {
      workspace_path: '/ws',
      rel_path: 'nb/demo.ipynb',
    })
    expect(wrapper.find('.nbp-line--heading').text()).toBe('Title')
    expect(wrapper.find('.nbp-line--bullet').text()).toBe('item one')
  })

  it('renders code cells as monospace blocks with the execution count', async () => {
    const { wrapper } = await mountNb(
      nb([{ cell_type: 'code', execution_count: 3, source: 'print(1)\nprint(2)', outputs: [] }]),
    )
    expect(wrapper.find('.nbp-exec').text()).toBe('In [3]:')
    expect(wrapper.find('pre.nbp-code').text()).toBe('print(1)\nprint(2)')
  })
})

describe('NotebookPreview – outputs', () => {
  it('renders stream outputs as plain text', async () => {
    const { wrapper } = await mountNb(
      nb([
        {
          cell_type: 'code',
          execution_count: 1,
          source: 'x',
          outputs: [{ output_type: 'stream', name: 'stdout', text: ['hello\n', 'world\n'] }],
        },
      ]),
    )
    expect(wrapper.find('pre.nbp-out-text').text()).toBe('hello\nworld')
  })

  it('renders base64 image/png outputs as data: URIs (whitespace stripped)', async () => {
    const { wrapper } = await mountNb(
      nb([
        {
          cell_type: 'code',
          execution_count: 1,
          source: 'plot()',
          outputs: [
            { output_type: 'display_data', data: { 'image/png': 'iVBORw0K\nGgoAAAA=\n' } },
          ],
        },
      ]),
    )
    const img = wrapper.find('img.nbp-out-img')
    expect(img.exists()).toBe(true)
    expect(img.attributes('src')).toBe('data:image/png;base64,iVBORw0KGgoAAAA=')
  })

  it('renders text/html outputs inside a fully sandboxed iframe via srcdoc', async () => {
    const { wrapper } = await mountNb(
      nb([
        {
          cell_type: 'code',
          execution_count: 2,
          source: 'df',
          outputs: [
            {
              output_type: 'execute_result',
              data: { 'text/html': ['<table><tr><td>1</td></tr></table>'] },
            },
          ],
        },
      ]),
    )
    const frame = wrapper.find('iframe.nbp-out-frame')
    expect(frame.exists()).toBe(true)
    expect(frame.attributes('srcdoc')).toContain('<table><tr><td>1</td></tr></table>')
    // Empty sandbox attribute = no allow-* tokens (scripts/forms blocked).
    expect(frame.attributes('sandbox')).toBe('')
    // The HTML must never render into the app origin.
    expect(wrapper.find('table').exists()).toBe(false)
  })

  it('renders error outputs with ANSI escape codes stripped', async () => {
    const { wrapper } = await mountNb(
      nb([
        {
          cell_type: 'code',
          execution_count: 1,
          source: 'boom()',
          outputs: [
            {
              output_type: 'error',
              ename: 'ValueError',
              evalue: 'bad',
              traceback: ['\u001b[0;31mValueError\u001b[0m: bad'],
            },
          ],
        },
      ]),
    )
    const err = wrapper.find('pre.nbp-out-error')
    expect(err.text()).toBe('ValueError: bad')
    expect(err.text()).not.toContain('\u001b')
  })
})

describe('NotebookPreview – errors and caps', () => {
  it('shows the invalid card for malformed JSON', async () => {
    const { wrapper } = await mountNb('this is not json')
    expect(wrapper.find('.nbp-card-error').text()).toContain('Not a valid notebook file.')
    expect(wrapper.find('.nbp-cell').exists()).toBe(false)
  })

  it('shows the invalid card for JSON without a cells array', async () => {
    const { wrapper } = await mountNb(JSON.stringify({ nbformat: 4 }))
    expect(wrapper.find('.nbp-card-error').text()).toContain('Not a valid notebook file.')
  })

  it('shows the error card when the read fails', async () => {
    const { wrapper } = await mountNb(null)
    expect(wrapper.find('.nbp-card-error').text()).toContain('Failed to load the notebook.')
    expect(wrapper.find('.nbp-card-error').text()).toContain('no such file')
  })

  it('caps rendering at 500 cells with a truncation notice', async () => {
    const cells = Array.from({ length: 501 }, (_, i) => ({
      cell_type: 'markdown',
      source: `cell ${i}`,
    }))
    const { wrapper } = await mountNb(nb(cells))
    expect(wrapper.findAll('.nbp-cell')).toHaveLength(500)
    expect(wrapper.text()).toContain('Showing the first 500 cells.')
  })

  it('shows no truncation notice at exactly the cap', async () => {
    const cells = Array.from({ length: 500 }, (_, i) => ({
      cell_type: 'markdown',
      source: `cell ${i}`,
    }))
    const { wrapper } = await mountNb(nb(cells))
    expect(wrapper.findAll('.nbp-cell')).toHaveLength(500)
    expect(wrapper.text()).not.toContain('Showing the first')
  })
})
