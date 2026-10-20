import { createApp, type Component } from 'vue'
import { i18n, resolveAvailableUiLocale } from '@navide/plugin-ui/foundation'
import { seedSettings } from '@navide/plugin-ui/shared'
import { readHostBootstrapSettings } from './lib/settingsBootstrap'

// Publish the Host snapshot before a lazy renderer root imports lib/settings.
// The settings module only reads this generic value, so plugin bundles do not
// inherit the Host preload bridge just to obtain initial UI preferences.
const bootstrapSettings = readHostBootstrapSettings()
;(globalThis as typeof globalThis & { __navideSettingsBootstrap?: Record<string, unknown> }).__navideSettingsBootstrap =
  bootstrapSettings
seedSettings(bootstrapSettings)

const bootstrapLocaleRaw = bootstrapSettings['agent-team:language']
if (typeof bootstrapLocaleRaw === 'string') {
  const candidate = bootstrapLocaleRaw.trim()
  const resolved = resolveAvailableUiLocale(candidate)
  if (resolved) {
    i18n.global.locale.value = resolved
  } else {
    try {
      const decodedLocale = resolveAvailableUiLocale(JSON.parse(candidate))
      if (decodedLocale) {
        i18n.global.locale.value = decodedLocale
      }
    } catch {
      // ignore
    }
  }
}

// Theme token layers — order matters: primitives → semantic roles → theme overrides.
import '@navide/plugin-ui/styles.css'

// Publish the platform for CSS that has to reserve different space in the
// title bar: macOS keeps 80px on the left for the traffic lights it draws
// itself, while the platforms where we draw our own controls need that room
// on the right instead. Set here, before any root mounts, so the first paint
// already has the right geometry.
import { needsDrawnWindowControls } from '../../shared/osplat'
if (needsDrawnWindowControls()) {
  document.documentElement.dataset.windowControls = 'drawn'
}

// Window-type dispatcher: Electron main appends `?window=editor`,
// `?window=plans`, etc. for secondary windows. Default is the main shell.
const params = new URLSearchParams(window.location.search)
const which = params.get('window') ?? 'main'

// Lazy-load only the root app this window needs. Statically importing them all
// pulled the editor window's heavy tree (Monaco) into every window's initial
// bundle — including the main shell, which never renders it. Dynamic import lets
// Vite code-split each root app so the main window's first paint isn't delayed by
// parsing Monaco it won't use.
const loadRoot = (): Promise<{ default: Component }> => {
  switch (which) {
    case 'editor': return import('./EditorWindowApp.vue')
    case 'plans':  return import('./PlanWindowApp.vue')
    case 'token-monitor': return import('./TokenMonitorApp.vue')
    default:       return import('./App.vue')
  }
}

// ── Fail-loud diagnostics ─────────────────────────────────────────────────────
// Secondary windows render into their own renderer; if mount throws the window
// goes silently black. Surface the error on-screen + console — but ONLY when the
// app actually failed to render (so benign transient rejections, e.g. a
// pre-connect "ws not open", never wipe a working UI).
function logErr(label: string, err: unknown): void {
  // eslint-disable-next-line no-console
  console.error(`[renderer:${which}] ${label}`, err)
}

function showFatalIfBlank(label: string, err: unknown): void {
  logErr(label, err)
  const host = document.getElementById('app')
  // Only take over the screen when nothing has rendered into #app. The pre-mount
  // splash counts as "blank" — if mount failed it's still sitting there, and the
  // fatal error must replace it rather than be suppressed by its presence.
  const onlyPreSplash = host?.childElementCount === 1 && host.firstElementChild?.id === 'pre-splash'
  if (!host || (host.childElementCount > 0 && !onlyPreSplash)) return
  const detail = err instanceof Error ? `${err.message}\n\n${err.stack ?? ''}` : String(err)
  const box = document.createElement('pre')
  box.style.cssText =
    'margin:0;padding:16px;height:100vh;overflow:auto;background:#1a0d0d;color:#ff9a9a;' +
    'font:12px/1.5 ui-monospace,Menlo,monospace;white-space:pre-wrap;word-break:break-word;'
  box.textContent = `⚠ ${label} (window=${which})\n\n${detail}`
  host.replaceChildren(box)
}

// Uncaught sync errors can blank a window before mount; promise rejections are
// usually benign (network/ws timing) so they only log.
window.addEventListener('error', (e) => showFatalIfBlank('Uncaught error', e.error ?? e.message))
window.addEventListener('unhandledrejection', (e) => logErr('Unhandled promise rejection', e.reason))

// Dropping a file onto any area without its own drop handler would otherwise
// navigate the whole window to that file (Electron default), wiping the app.
// Swallow stray drags at the document level; explicit drop zones still work
// because their handlers run during dispatch before this bubble-phase default.
window.addEventListener('dragover', (e) => e.preventDefault())
window.addEventListener('drop', (e) => e.preventDefault())

loadRoot()
  .then(({ default: Root }) => {
    const app = createApp(Root)
    app.use(i18n)
    app.config.errorHandler = (err, _instance, info) => showFatalIfBlank(`Vue error (${info})`, err)
    app.mount('#app')
  })
  .catch((err) => showFatalIfBlank('App failed to mount', err))
