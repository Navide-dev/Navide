import { createApp } from 'vue'
import '@navide/plugin-ui/styles.css'
import './pluginDocument.css'
import BrowserApp from './BrowserApp.vue'
import { browserViewRuntime, subscribeHostEvent } from './backend'
import { i18n } from '@navide/plugin-ui/foundation'
import { bindBrowserLocale, bootstrapBrowserI18n } from './browserI18n'
import { bindBrowserTheme, bootstrapBrowserTheme } from './browserTheme'

// Both entrypoints share one app; the Host-authenticated `contribution` query
// tells the left section from the window.
bootstrapBrowserI18n(i18n, window.location.search)
bindBrowserLocale(i18n, subscribeHostEvent)
bootstrapBrowserTheme(window.location.search)
bindBrowserTheme(subscribeHostEvent)

const app = createApp(BrowserApp)
app.use(i18n)
app.mount('#app')
browserViewRuntime.ready()
