import { BUILTIN_THEMES, DEFAULT_THEME } from '@navide/plugin-ui/foundation'
import { seedSettings } from '@navide/plugin-ui/shared'

/** The settings key the Host uses for the app theme (JSON-string encoded). */
export const BROWSER_THEME_KEY = 'agent-team:theme'

const VALID_THEME_IDS = new Set(BUILTIN_THEMES.map((entry) => entry.id))

/** Accept the bare id (entry query) and the JSON-string encoding the Host
 *  broadcasts on `ui.settings_changed`. */
export function resolveBrowserTheme(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const raw = value.trim()
  if (VALID_THEME_IDS.has(raw)) return raw
  try {
    const decoded: unknown = JSON.parse(raw)
    return typeof decoded === 'string' && VALID_THEME_IDS.has(decoded) ? decoded : null
  } catch {
    return null
  }
}

function extractThemeFromSettingsEvent(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null
  const record = payload as Record<string, unknown>
  if (record.source !== 'host') return null
  const settings = record.settings
  if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) return null
  return resolveBrowserTheme((settings as Record<string, unknown>)[BROWSER_THEME_KEY])
}

function applyBrowserTheme(theme: string): void {
  if (typeof document === 'undefined') return
  document.documentElement.setAttribute('data-theme', theme)
}

/** Stamp the Host's `?theme=` before mount so the view never flashes. */
export function bootstrapBrowserTheme(queryOrSearch: string): string {
  const search = queryOrSearch.startsWith('?') ? queryOrSearch : `?${queryOrSearch}`
  const theme = resolveBrowserTheme(new URLSearchParams(search).get('theme')) ?? DEFAULT_THEME
  applyBrowserTheme(theme)
  seedSettings({ [BROWSER_THEME_KEY]: JSON.stringify(theme) })
  return theme
}

export function bindBrowserTheme(
  subscribeEvent: (type: string, listener: (payload: unknown) => void) => () => void,
): () => void {
  return subscribeEvent('ui.settings_changed', (payload) => {
    const next = extractThemeFromSettingsEvent(payload)
    if (next) applyBrowserTheme(next)
  })
}
