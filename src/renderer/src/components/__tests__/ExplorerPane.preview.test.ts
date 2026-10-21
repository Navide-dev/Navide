// @vitest-environment happy-dom
// The Explorer's user-facing entry into the right-rail preview panel. A plain
// click already opens the editor window, so preview lives on the context menu
// instead — these tests pin that the entries exist, carry the right target,
// and stay out of the editor window where no rail exists.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import ExplorerPane from '../ExplorerPane.vue'
import { i18n } from '@navide/plugin-ui/foundation'
import { createMockBackend } from '../../composables/__tests__/mockBackend'
import { usePreview } from '../../preview/usePreview'
import type { BackendStatus } from '../../composables/useBackend'

vi.mock('../../composables/useNotify', () => ({
  useNotify: () => ({ toast: vi.fn(), alert: vi.fn(), confirm: vi.fn() }),
}))

const FILE_ENTRY = {
  name: 'readme.md',
  rel_path: 'docs/readme.md',
  is_dir: false,
  is_hidden: false,
  is_noise: false,
}

const DIR_ENTRY = {
  name: 'src',
  rel_path: 'src',
  is_dir: true,
  is_hidden: false,
  is_noise: false,
}

async function mountPane(props: Record<string, unknown> = {}, entries = [FILE_ENTRY]) {
  const { backend, setResponse } = createMockBackend('connected' as BackendStatus)
  setResponse('fs.list_dir', { ok: true, entries })
  const w = mount(ExplorerPane, {
    props: { workspacePath: '/ws', backend: backend as never, ...props },
    global: { plugins: [i18n] },
  })
  await flushPromises()
  return w
}

function previewItems(w: ReturnType<typeof mount>) {
  return w.findAll('.exp-ctx-item').filter((b) => {
    const t = b.text()
    return t.includes('Show in Preview') || t.includes('Show Diff in Preview')
  })
}

describe('ExplorerPane preview entries', () => {
  beforeEach(() => {
    usePreview().reset()
  })

  it('offers both preview entries when right-clicking a file', async () => {
    const w = await mountPane()
    await w.find('.exp-row').trigger('contextmenu')
    expect(previewItems(w)).toHaveLength(2)
    w.unmount()
  })

  it('sends the file to the preview panel', async () => {
    const w = await mountPane()
    await w.find('.exp-row').trigger('contextmenu')
    await previewItems(w)[0].trigger('click')
    expect(usePreview().current.value).toEqual({
      kind: 'file',
      workspacePath: '/ws',
      relPath: 'docs/readme.md',
      source: 'user',
    })
    w.unmount()
  })

  it('sends the diff of the same file as a diff target', async () => {
    const w = await mountPane()
    await w.find('.exp-row').trigger('contextmenu')
    await previewItems(w)[1].trigger('click')
    expect(usePreview().current.value).toMatchObject({
      kind: 'diff',
      relPath: 'docs/readme.md',
      staged: false,
    })
    w.unmount()
  })

  it('surfaces the panel — these are explicit user actions, not selection', async () => {
    const w = await mountPane()
    const before = usePreview().focusRequest.value
    await w.find('.exp-row').trigger('contextmenu')
    await previewItems(w)[0].trigger('click')
    expect(usePreview().focusRequest.value).toBe(before + 1)
    w.unmount()
  })

  it('offers no preview entry for a directory', async () => {
    const w = await mountPane({}, [DIR_ENTRY])
    await w.find('.exp-row').trigger('contextmenu')
    expect(previewItems(w)).toHaveLength(0)
    w.unmount()
  })

  it('hides the entries when embedded in the editor window', async () => {
    // The editor window has no right rail, so a preview push there would go
    // somewhere the user cannot see.
    const w = await mountPane({ embedded: true })
    await w.find('.exp-row').trigger('contextmenu')
    expect(previewItems(w)).toHaveLength(0)
    w.unmount()
  })
})
