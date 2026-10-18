// @vitest-environment happy-dom
// With the Mini-IDE disabled, "Open" in the preview panel is Mini-IDE-only
// when the Mini-IDE is the default editor: shown disabled with the reason.
// An external default editor still opens the file.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { flushPromises, shallowMount } from '@vue/test-utils'
import { ref } from 'vue'
import { settingsSet } from '@navide/plugin-ui/shared'
import PreviewPanel from '../PreviewPanel.vue'
import { usePreview } from '../usePreview'
import { DEFAULT_EDITOR_SETTING_KEY } from '../../lib/defaultEditor'

const backend = {
  httpUrl: ref('http://127.0.0.1:1234'),
  status: ref('connected'),
  send: async () => ({ ok: true, payload: { entries: [] } }),
  on: () => () => {},
}

async function mountWith(disabled: string[]) {
  ;(window as unknown as Record<string, unknown>).agentTeam = {
    plugins: { disabledBuiltins: vi.fn(async () => disabled), onContributionsChanged: () => () => undefined },
  }
  usePreview().show({ kind: 'file', workspacePath: '/ws', relPath: 'a.ts' })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = shallowMount(PreviewPanel as any, {
    props: { backend, workspacePath: '/ws' },
    global: { mocks: { $t: (key: string) => key } },
  })
  await flushPromises()
  return w
}

describe('PreviewPanel – disabled Mini-IDE', () => {
  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).agentTeam
    settingsSet(DEFAULT_EDITOR_SETTING_KEY, 'mini-ide')
  })

  it('shows Open disabled with the reason, and enabled again for an external default editor', async () => {
    settingsSet(DEFAULT_EDITOR_SETTING_KEY, 'mini-ide')
    const w = await mountWith(['navide.mini-ide'])
    let open = w.findAll('.pv-btn').find((b) => b.text() === 'preview.open')!
    expect(open.attributes('disabled')).toBeDefined()
    expect(open.attributes('title')).toBe('settings.extensions.builtinDisabledTooltip')

    settingsSet(DEFAULT_EDITOR_SETTING_KEY, 'system')
    usePreview().show({ kind: 'file', workspacePath: '/ws', relPath: 'b.ts' })
    await flushPromises()
    open = w.findAll('.pv-btn').find((b) => b.text() === 'preview.open')!
    expect(open.attributes('disabled')).toBeUndefined()
    w.unmount()
  })
})
