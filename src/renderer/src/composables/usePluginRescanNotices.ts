import { i18n, useNotify } from '@navide/plugin-ui/foundation'
import { createNoticeCoalescer } from '../lib/noticeCoalescer'

/**
 * Plan B D6/D-f: a Navide Registry rescan of an installed version found new
 * items. The main process compares it during the periodic update check and
 * reports each rescan once; this only notes it, never interrupts, and the
 * same notice within an hour is merged. The data is the Registry's and is
 * labelled unverified. Returns the unsubscribe.
 */
export function usePluginRescanNotices(now: () => number = Date.now): () => void {
  const t = i18n.global.t
  const notify = useNotify()
  const coalescer = createNoticeCoalescer()
  const subscribe = window.agentTeam?.plugins?.onRescanNotices
  if (!subscribe) return () => {}
  return subscribe((notices) => {
    for (const notice of notices) {
      if (!coalescer.shouldShow(`rescan:${notice.id}@${notice.version}`, now())) continue
      notify.toast(
        t('pluginDisclosure.rescanNotice', { name: notice.id, version: notice.version, count: notice.added.length }),
        { type: 'info', duration: 0 }
      )
    }
  })
}
