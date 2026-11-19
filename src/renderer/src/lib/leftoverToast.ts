import { i18n, type ToastType } from '@navide/plugin-ui/foundation'

interface ToastButton { label: string; run: () => void }

/** The toast for a prompt Navide cleared out of a pane's input box before
 *  typing a message (lib/claudeComposer.ts, owner 'restored'). It stays until
 *  dismissed: it is the only way back to that text. Restore pastes it into the
 *  box without pressing Enter; Copy puts it on the clipboard. */
export function leftoverToast(
  paneName: string,
  handlers: { restore: () => void; copy: () => void },
): {
  message: string
  opts: { type: ToastType; duration: number; title: string; action: ToastButton; secondaryAction: ToastButton }
} {
  const t = i18n.global.t
  return {
    message: t('msg.leftover-cleared-body'),
    opts: {
      type: 'info',
      duration: 0,
      title: t('msg.leftover-cleared-title', { pane: paneName }),
      action: { label: t('msg.leftover-restore'), run: handlers.restore },
      secondaryAction: { label: t('msg.leftover-copy'), run: handlers.copy },
    },
  }
}
