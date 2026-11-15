import { createApp } from 'vue'
import '@navide/plugin-ui/styles.css'
import { seedSettings } from '@navide/plugin-ui/shared'
import { i18n } from '@navide/plugin-ui/foundation'
import './miniIdeMessages'
import { disposeBackend, viewRuntime } from './composables/useBackend'
import MiniIdeApp from './MiniIdeApp.vue'

const params = new URLSearchParams(window.location.search)
const theme = params.get('theme')
if (theme) {
  document.documentElement.setAttribute('data-theme', theme)
  seedSettings({ 'agent-team:theme': JSON.stringify(theme) })
}
const requestedLocale = params.get('locale')
const locale = i18n.global.availableLocales.find((available) => available === requestedLocale)
if (locale) {
  i18n.global.locale.value = locale
  seedSettings({ 'agent-team:language': locale })
}

const app = createApp(MiniIdeApp)
app.use(i18n)
app.mount('#app')
viewRuntime.ready()
window.addEventListener('unload', () => {
  app.unmount()
  disposeBackend()
}, { once: true })
