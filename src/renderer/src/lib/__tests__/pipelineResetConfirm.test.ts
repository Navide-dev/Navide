// Reset closes every pane in the window, manual ones included, so the user's
// Reset asks first and names each pane that will close.
import { describe, expect, it } from 'vitest'
import { i18n } from '@navide/plugin-ui/foundation'
import { resetConfirmDialog } from '../pipelineResetConfirm'

i18n.global.locale.value = 'en-US'
const t = i18n.global.t

describe('resetConfirmDialog', () => {
  it('lists every pane that will close, marking the ones the user opened', () => {
    const d = resetConfirmDialog(t, [
      { name: 'Planner', manual: false },
      { name: 'my shell', manual: true },
    ])
    expect(d.danger).toBe(true)
    expect(d.title).toBe(t('pipelineEditor.run.reset-title'))
    expect(d.confirmText).toBe(t('pipelineEditor.run.reset-confirm'))
    expect(d.message).toBe(t('pipelineEditor.run.reset-message', { count: 2 }, 2))
    expect(d.message).toContain('2 panes')
    expect(d.detail).toBe(`• Planner\n• my shell (${t('pipelineEditor.run.reset-manual-mark')})`)
  })

  it('says nothing will close when no pane is open', () => {
    const d = resetConfirmDialog(t, [])
    expect(d.message).toBe(t('pipelineEditor.run.reset-message-none'))
    expect(d.detail).toBeUndefined()
  })
})
