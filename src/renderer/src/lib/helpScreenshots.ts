// Settings → Help screenshots, served from S3 behind dl.navide.dev.
//
// Every help figure draws a code-built mock first; a real screenshot only
// replaces it once the image has actually loaded. The manifest
// (helpScreenshots.json, written by scripts/upload-help-screenshots.mjs) maps a
// figure id and locale to the file name of an uploaded picture. A figure with
// no entry, a machine that is offline, or an image that fails to load all keep
// the mock and its caption, so the help never shows a broken image.
//
// Object keys carry the picture's content hash, `help/<id>/<locale>/<hash>.<ext>`,
// so a new screenshot is a new URL: nothing can serve a stale copy, and the
// CDN may cache every object forever.
import manifest from './helpScreenshots.json'

/** The only origin and path help images may load from. */
export const HELP_SCREENSHOT_BASE = 'https://dl.navide.dev/help/'

const SHOT_ID = /^[A-Za-z0-9][A-Za-z0-9.-]*$/
const LOCALE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/
const FILE = /^[0-9a-f]{12}\.(png|webp)$/

type Manifest = { schemaVersion: number; shots: Record<string, Record<string, string>> }

/** True only for an https URL on dl.navide.dev whose path stays under /help/. */
export function isHelpScreenshotUrl(raw: string): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (url.protocol !== 'https:' || url.host !== 'dl.navide.dev') return false
  if (url.username || url.password || url.search || url.hash) return false
  // URL() already folds `/help/../releases`; refuse encoded separators too,
  // which a server might decode back into a path outside help/.
  if (/%2f|%5c|%2e/i.test(url.pathname)) return false
  return url.pathname.startsWith('/help/') && url.href.startsWith(HELP_SCREENSHOT_BASE)
}

/** The URL of the screenshot for figure `id` in `locale`, or null when none was uploaded. */
export function helpScreenshotUrl(id: string, locale: string, source: Manifest = manifest): string | null {
  if (!SHOT_ID.test(id) || !LOCALE.test(locale)) return null
  const file = source.shots[id]?.[locale]
  if (!file || !FILE.test(file)) return null
  const url = `${HELP_SCREENSHOT_BASE}${id}/${locale}/${file}`
  return isHelpScreenshotUrl(url) ? url : null
}
