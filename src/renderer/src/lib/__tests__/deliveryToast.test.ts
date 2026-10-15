import { describe, expect, it } from 'vitest'
import { i18n } from '@navide/plugin-ui/foundation'
import { deliveryToast } from '../deliveryToast'

i18n.global.locale.value = 'en-US'

describe('deliveryToast', () => {
  it('turns a remote-device delivery into one external toast, not a cross-workspace one', () => {
    const toast = deliveryToast(
      { origin: 'remote', from_display: 'MacBook-Air/Agent-Team/lead', cross_workspace: true, from_workspace_path: '/w/Agent-Team' },
      'notify',
    )
    expect(toast).toEqual({
      message: 'Instruction from MacBook-Air/Agent-Team/lead delivered to “notify”',
      opts: { type: 'info', variant: 'external', icon: '⇄', title: 'Remote device · MacBook-Air', duration: 8000 },
    })
  })

  it('turns a chat-channel delivery into a channel toast naming the platform and sender', () => {
    const viaOrigin = deliveryToast({ origin: 'channel', from_display: 'telegram:alice', cross_workspace: true }, 'notify')
    expect(viaOrigin).toEqual({
      message: 'Message from telegram:alice delivered to “notify”',
      opts: { type: 'info', variant: 'channel', icon: '✉', title: 'External channel · Telegram · alice', duration: 8000 },
    })
    // An older backend without `origin` is still recognised by the sender display.
    const viaDisplay = deliveryToast({ from_display: 'telegram:alice', cross_workspace: true }, 'notify')
    expect(viaDisplay?.opts.variant).toBe('channel')
  })

  it('titles a chat-channel delivery without a sender by its platform alone', () => {
    const toast = deliveryToast({ origin: 'channel', from_display: 'discord', cross_workspace: true }, 'notify')
    expect(toast?.opts).toEqual({ type: 'info', variant: 'channel', icon: '✉', title: 'External channel · Discord', duration: 8000 })
  })

  it('uses the localized channel header', () => {
    i18n.global.locale.value = 'zh-TW'
    try {
      const toast = deliveryToast({ origin: 'channel', from_display: 'telegram:alice' }, 'notify')
      expect(toast?.opts.title).toBe('外部頻道 · Telegram · alice')
    } finally {
      i18n.global.locale.value = 'en-US'
    }
  })

  it('keeps a local cross-workspace delivery on its message, as a workspace toast', () => {
    const toast = deliveryToast(
      { from_pane_id: 'p9', from_display: 'navide-web/deploy', from_workspace_path: '/Users/me/navide-web', cross_workspace: true },
      'notify',
    )
    expect(toast).toEqual({
      message: 'Instruction from another workspace: “navide-web/deploy” → “notify”',
      opts: { variant: 'workspace', icon: '⇆', title: 'Other workspace · navide-web' },
    })
  })

  it('shows no toast for a same-workspace delivery', () => {
    expect(deliveryToast({ from_pane_id: 'p1', from_display: 'lead', cross_workspace: false }, 'notify')).toBeNull()
  })

  it('leaves the title off a cross-workspace delivery that names no workspace', () => {
    const toast = deliveryToast({ from_display: 'host', cross_workspace: true }, 'notify')
    expect(toast?.opts).toEqual({ variant: 'workspace', icon: '⇆' })
  })
})
