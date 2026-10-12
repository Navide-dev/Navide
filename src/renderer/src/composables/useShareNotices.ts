/**
 * useShareNotices.ts
 *
 * Turns the backend's share-link events into announcements: `share.created`
 * (by the user or an agent's pane, with how many secrets were masked) and
 * `share.opened` for the first open or a new viewer, and `share.feedback` for
 * an approval or note from the phone applied — or refused because the plan
 * changed since it was shared. None of these carries a URL. Without Navide Cloud no such event is ever sent, so nothing changes.
 */
import type { useBackend } from './useBackend'
import { useAnnouncements } from './useAnnouncements'

type Backend = Pick<ReturnType<typeof useBackend>, 'on'>

const str = (value: unknown): string => (typeof value === 'string' ? value : '')

export function useShareNotices(backend: Backend): () => void {
  const announcements = useAnnouncements()
  const offs: Array<() => void> = []

  const offCreated = backend.on('share.created', (raw) => {
    const ev = (raw ?? {}) as Record<string, unknown>
    const linkId = str(ev.linkId)
    if (!linkId) return
    announcements.noteShareNotice({
      kind: 'created',
      linkId,
      createdBy: ev.createdBy === 'agent' ? 'agent' : 'user',
      pane: str(ev.pane),
      agent: str(ev.agent),
      maskedTotal: Array.isArray(ev.masked) ? ev.masked.length : 0,
    })
  })
  if (typeof offCreated === 'function') offs.push(offCreated)

  const offOpened = backend.on('share.opened', (raw) => {
    const ev = (raw ?? {}) as Record<string, unknown>
    const linkId = str(ev.linkId)
    const openCount = typeof ev.openCount === 'number' ? ev.openCount : 0
    const newViewer = ev.newViewer === true
    if (!linkId || !(openCount === 1 || newViewer)) return
    announcements.noteShareNotice({ kind: 'opened', linkId, openCount, newViewer: newViewer && openCount !== 1 })
  })
  if (typeof offOpened === 'function') offs.push(offOpened)

  // Approvals and notes left from a phone on a shared plan, applied or refused
  // on this device (share_feedback).
  const offFeedback = backend.on('share.feedback', (raw) => {
    const ev = (raw ?? {}) as Record<string, unknown>
    const linkId = str(ev.linkId)
    if (!linkId) return
    announcements.noteShareNotice({
      kind: 'feedback',
      linkId,
      title: str(ev.title),
      result: str(ev.result),
      reason: str(ev.reason),
    })
  })
  if (typeof offFeedback === 'function') offs.push(offFeedback)

  return () => offs.splice(0).forEach((off) => off())
}
