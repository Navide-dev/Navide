import { BUILTIN_THEMES, DEFAULT_THEME } from '@navide/plugin-ui/foundation'
import { seedSettings } from '@navide/plugin-ui/shared'

/** The settings key the Host uses for the app theme. Its stored form is the
 *  JSON-string encoding, which is also what the Host puts on the wire. */
export const PLANS_THEME_KEY = 'agent-team:theme'

const VALID_THEME_IDS = new Set(BUILTIN_THEMES.map((entry) => entry.id))

/** Accept both the bare id (entry query) and the JSON-string encoding the Host
 *  broadcasts on `ui.settings_changed`. Anything else is not a theme we ship. */
export function resolvePlansTheme(value: unknown): string | null {
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

export function parsePlansThemeFromQuery(queryOrSearch: string): string | null {
  const search = queryOrSearch.startsWith('?') ? queryOrSearch : `?${queryOrSearch}`
  return resolvePlansTheme(new URLSearchParams(search).get('theme'))
}

export function extractThemeFromSettingsEvent(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null
  const record = payload as Record<string, unknown>
  if (record.source !== 'host') return null
  const settings = record.settings
  if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) return null
  return resolvePlansTheme((settings as Record<string, unknown>)[PLANS_THEME_KEY])
}

/** Theme tokens are selected by `data-theme` on <html>; with no attribute the
 *  semantic layer resolves to dark-github, which is why an unthemed guest
 *  painted dark inside a light window. */
export function applyPlansTheme(theme: string): void {
  if (typeof document === 'undefined') return
  document.documentElement.setAttribute('data-theme', theme)
}

/**
 * Zero-flash initial theme, mirroring navide-git's src/mount.ts: the Host
 * passes the current app theme as `?theme=` because the plugin origin has no
 * bootstrap snapshot. Stamp `data-theme` before mount, and seed the settings
 * cache with the store's JSON-string encoding so `useTheme.loadTheme()` — which
 * PlansApp calls on mount — keeps it instead of falling back to the default.
 */
export function bootstrapPlansTheme(queryOrSearch: string): string {
  const theme = parsePlansThemeFromQuery(queryOrSearch) ?? DEFAULT_THEME
  applyPlansTheme(theme)
  seedSettings({ [PLANS_THEME_KEY]: JSON.stringify(theme) })
  return theme
}

/**
 * Follow later switches. The entry query is a load-time snapshot, and Plans has
 * no settings backend of its own, so `onSettingsChanged` never fires here —
 * the Host's `ui.settings_changed` event is the only live source. Theme is
 * read-only metadata for the guest, so this applies the attribute directly
 * rather than writing back through the settings store.
 */
export function bindPlansTheme(
  subscribeEvent: (type: string, listener: (payload: unknown) => void) => () => void,
): () => void {
  return subscribeEvent('ui.settings_changed', (payload) => {
    const next = extractThemeFromSettingsEvent(payload)
    if (next) applyPlansTheme(next)
  })
}
