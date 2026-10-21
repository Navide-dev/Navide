// Plans plugin entry.
//
// Mounts the UNMODIFIED PlanWindowApp.vue inside the isolated plugin
// WebContentsView. It boots exactly like the core plan window
// (src/renderer/src/main.ts, `?window=plans`): the same theme-token CSS layers
// and i18n, then `createApp(PlanWindowApp).mount('#app')`.
//
// The one difference is invisible to the app source: the plugin build aliases
// `composables/useBackend` to `./capabilityBackend`, so every `send`/`on` inside
// PlanWindowApp, PlansPane, PlanReviewToolbar, … is routed through `window.nav`
// (the host capability broker) instead of a direct WebSocket. PlanWindowApp
// still reads its `workspace_path` / `rel_path` from `window.location.search`,
// which the host sets when it loads this entry — no injection needed here.

import { createApp } from 'vue'
import { i18n, resolveAvailableUiLocale } from '@navide/plugin-ui/foundation'

// Theme token layers — order matters: primitives → semantic roles → themes.
import '@navide/plugin-ui/styles.css'

import PlanWindowApp from '../../src/PlanWindowApp.vue'
import { seedSettings } from '@navide/plugin-ui/shared'

// Zero-flash initial theme: the host passes the current app theme as `?theme=`
// (the plugin origin has no `window.agentTeam.getBootstrapSettings`, so the
// settings cache seeds empty here). Stamp `data-theme` before mount and seed
// the cache with the store's JSON-string encoding so useTheme.loadTheme()
// keeps it; the connect-time `ui.settings.get` reconcile then takes over.
// Mirrors plugins/mini-ide/mount.ts.
const initialTheme = new URLSearchParams(window.location.search).get('theme')
if (initialTheme) {
  document.documentElement.setAttribute('data-theme', initialTheme)
  seedSettings({ 'agent-team:theme': JSON.stringify(initialTheme) })
}

const initialLocale = resolveAvailableUiLocale(new URLSearchParams(window.location.search).get('locale'))
if (initialLocale) {
  i18n.global.locale.value = initialLocale
  seedSettings({ 'agent-team:language': initialLocale })
}

// Host-driven plan switching without a reload. PlanWindowApp subscribes to
// `window.agentTeam.onPlanOpenDoc` to switch the open plan in place when the
// sidebar (in the core window) clicks another plan. That host bridge is absent
// in the plugin origin (plugin-preload exposes only `window.nav`), so translate
// the host's `plugin:openTarget` deliveries (`window.nav.onOpenTarget`,
// re-open-with-new-query) into it. Install the shim BEFORE mount so
// PlanWindowApp's onMounted registers its handler; `agentTeam` is otherwise
// undefined here, so nothing is shadowed.
{
  const nav = (window as unknown as {
    nav?: { onOpenTarget?: (cb: (p: Record<string, string>) => void) => () => void }
  }).nav
  let planOpenDocCb: ((relPath: string) => void) | null = null
  ;(window as unknown as { agentTeam?: unknown }).agentTeam = {
    onPlanOpenDoc(cb: (relPath: string) => void): () => void {
      planOpenDocCb = cb
      return () => {
        if (planOpenDocCb === cb) planOpenDocCb = null
      }
    },
  }
  nav?.onOpenTarget?.((params) => {
    const relPath = params['rel_path']
    if (relPath) planOpenDocCb?.(relPath)
    const targetLocale = resolveAvailableUiLocale(params['locale'])
    if (targetLocale) {
      i18n.global.locale.value = targetLocale
      seedSettings({ 'agent-team:language': targetLocale })
    }
  })
}

// Announce readiness to the host broker (mirrors the noop/mini-ide plugins).
// Local cast instead of relying on the `Window.nav` global augmentation — see
// the note in ./capabilityBackend.ts.
;(window as unknown as { nav?: { ready?: () => void } }).nav?.ready?.()

const app = createApp(PlanWindowApp)
app.use(i18n)
app.mount('#app')
