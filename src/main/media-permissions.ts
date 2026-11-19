import type { Session, WebContents } from 'electron'

// Microphone access for voice input.
//
// Before this module no code set a permission handler on any session, so
// Electron's default applied: every permission request and check is granted.
// Installing a handler replaces that default wholesale, so both handlers below
// answer `true` for everything except `media` — every other permission keeps
// behaving exactly as it did. `media` is narrowed to what voice input needs:
// audio, and only for a main (workspace) window's own renderer. Plugin
// WebContentsViews hosted inside that window, and every other window, are
// denied — nothing else in the app captures media.
//
// Electron 45 reports screen capture as `display-capture` instead of `media`
// (with no media types). It keeps the rule screen capture had under `media`:
// granted to a main window's own renderer only.

/** Which kind of media a request or check is about. */
export interface MediaAsk {
  /** Request: `details.mediaTypes`. Check: `[details.mediaType]` when known. */
  mediaTypes: readonly string[]
  /** True when the asking webContents is a main window's own renderer. */
  fromMainRenderer: boolean
}

/** The decision for one `media` ask. Audio only, main renderer only. An ask
 *  that names no media type at all (a bare check) is answered for the main
 *  renderer alone, since it cannot be about video there. */
export function decideMediaPermission(ask: MediaAsk): boolean {
  if (!ask.fromMainRenderer) return false
  return ask.mediaTypes.every((t) => t === 'audio')
}

/** Decision for any permission: everything but `media` and
 *  `display-capture` keeps Electron's default (allow). */
export function decidePermission(permission: string, ask: () => MediaAsk): boolean {
  if (permission === 'display-capture') return ask().fromMainRenderer
  if (permission !== 'media') return true
  return decideMediaPermission(ask())
}

/**
 * Install the request and check handlers on `ses`.
 *
 * `isMainRenderer` must return true only for the top-level webContents of a
 * main window (`win.webContents` of a window in `mainWindows`), never for a
 * WebContentsView attached to one.
 */
export function installMediaPermissionHandlers(
  ses: Session,
  isMainRenderer: (wc: WebContents | null) => boolean,
): void {
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    const mediaTypes = (details as { mediaTypes?: string[] }).mediaTypes ?? []
    callback(decidePermission(permission, () => ({ mediaTypes, fromMainRenderer: isMainRenderer(wc) })))
  })
  ses.setPermissionCheckHandler((wc, permission, _origin, details) => {
    const mediaType = (details as { mediaType?: string }).mediaType
    const mediaTypes = mediaType && mediaType !== 'unknown' ? [mediaType] : []
    return decidePermission(permission, () => ({ mediaTypes, fromMainRenderer: isMainRenderer(wc) }))
  })
}
