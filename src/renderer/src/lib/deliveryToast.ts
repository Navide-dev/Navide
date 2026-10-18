import { i18n, type ToastType, type ToastVariant } from '@navide/plugin-ui/foundation'
import { isExternalDelivery } from './agentMessaging'

/** The fields of an accepted `agent_msg.deliver` event that decide its toast. */
export interface DeliveryToastEvent {
  origin?: string
  from_pane_id?: string
  from_display?: string
  from_workspace_path?: string
  cross_workspace?: boolean
}

export interface DeliveryToast {
  message: string
  opts: { type?: ToastType; duration?: number; variant?: ToastVariant; title?: string; icon?: string }
}

/** Last segment of a workspace path, either separator. */
function workspaceName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? ''
}

/**
 * The toast an accepted delivery earns, or null for none. Content from another
 * machine gets the external toast and a chat channel the channel toast — either
 * replaces the cross-workspace one, which the backend also flags it as. Another local
 * workspace keeps its existing message with the workspace emphasis; a delivery
 * from this workspace stays silent, as before.
 */
export function deliveryToast(ev: DeliveryToastEvent, targetName: string): DeliveryToast | null {
  const t = i18n.global.t
  const from = ev.from_display || t('msg.cross-workspace-unknown-sender')
  if (isExternalDelivery(ev)) {
    if (ev.origin === 'remote') {
      return {
        message: t('msg.external-toast-remote-body', { from, target: targetName }),
        opts: {
          type: 'info',
          variant: 'external',
          icon: '⇄',
          title: t('msg.external-toast-remote-title', { device: from.split('/')[0] }),
          duration: 8000,
        },
      }
    }
    const sep = from.indexOf(':')
    const platform = sep > 0 ? from.slice(0, sep) : from
    const sender = sep > 0 ? from.slice(sep + 1) : ''
    const platformKey = `channels.platform.${platform}`
    const platformLabel = i18n.global.te(platformKey) ? t(platformKey) : platform
    return {
      message: t('msg.external-toast-channel-body', { from, target: targetName }),
      opts: {
        type: 'info',
        variant: 'channel',
        icon: '✉',
        title: sender
          ? t('msg.external-toast-channel-title', { platform: platformLabel, sender })
          : t('msg.external-toast-channel-platform-title', { platform: platformLabel }),
        duration: 8000,
      },
    }
  }
  if (!ev.cross_workspace) return null
  const name = workspaceName(ev.from_workspace_path ?? '')
  return {
    message: t('msg.cross-workspace-toast', { from, target: targetName }),
    opts: {
      variant: 'workspace',
      icon: '⇆',
      ...(name ? { title: t('msg.workspace-toast-title', { name }) } : {}),
    },
  }
}
