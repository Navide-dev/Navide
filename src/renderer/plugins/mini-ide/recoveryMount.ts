// Mini-IDE plugin entry — Phase 2 M4.
//
// Mounts the UNMODIFIED EditorWindowApp.vue inside the isolated plugin
// WebContentsView. It boots exactly like the secondary editor window
// (src/renderer/src/main.ts, `?window=editor`): the same theme-token CSS layers
// and i18n, then `createApp(EditorWindowApp).mount('#app')`.
//
// The one difference is invisible to the app source: the plugin build aliases
// `composables/useBackend` to `./capabilityBackend`, so every `send`/`on` inside
// EditorWindowApp, useGit, … is routed through `window.nav` (the
// host capability broker) instead of a direct WebSocket. EditorWindowApp still
// reads its `workspace_path` / `filepath` from `window.location.search`, which
// the host sets when it loads this entry — no injection needed here.

import { createApp } from 'vue'
import { i18n, resolveAvailableUiLocale } from '@navide/plugin-ui/foundation'

// Theme token layers — order matters: primitives → semantic roles → themes.
import '@navide/plugin-ui/styles.css'

import EditorWindowApp from '../../src/EditorWindowApp.vue'
import { seedSettings } from '@navide/plugin-ui/shared'

// Zero-flash initial theme: the host passes the current app theme as `?theme=`
// (the plugin origin has no `window.agentTeam.getBootstrapSettings`, so the
// settings cache seeds empty here). Stamp `data-theme` before mount and seed
// the cache with the store's JSON-string encoding so useTheme.loadTheme()
// keeps it; the connect-time `ui.settings.get` reconcile then takes over.
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

// Announce readiness to the host broker (mirrors the noop/fs_probe plugins).
window.nav?.ready?.()

const app = createApp(EditorWindowApp)
app.use(i18n)
app.mount('#app')
