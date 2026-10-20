// Git plugin composition root.
//
// The isolated plugin view receives one already-authenticated capability
// closure from the SDK shim. All feature ports are built here and injected into
// the shared Git surface; GitWindowApp and its domain components never see the
// capability backend, IPC/WebSocket details, or Host routes.

import { createApp } from 'vue'
import {
  createAiCliSessionController,
  type AiCliPluginContext,
} from '@navide/plugin-ui'
import { i18n, resolveAvailableUiLocale } from '@navide/plugin-ui/foundation'
import { useBackend } from './capabilityBackend'
import { createPluginGitTransport, type PluginGitSdk } from './sdkGitTransport'
import {
  createPluginCapabilitySdk,
  createPluginKeybindingsPort,
  createPluginGitSurfacePorts,
  createPluginGitContributionHostPort,
  createPluginGitWorkspaceGrantPort,
  createPluginGitSettingsPort,
  createPluginLegacyRepoSelectionPort,
} from './pluginSurfacePorts'
import {
  GIT_ACCOUNTS_KEY,
  GIT_BRANCH_DIFF_KEY,
  GIT_FILE_ACCESS_KEY,
  GIT_ISSUES_KEY,
  GIT_TRANSPORT_KEY,
  GIT_UI_KEY,
} from './ports/gitSurface'
import { initKeybindingsPort, initSettingsBackend, onSettingsChanged, seedSettings, settingsGet } from '@navide/plugin-ui/shared'

// Theme token layers — order matters: primitives → semantic roles → themes.
import '@navide/plugin-ui/styles.css'
import './pluginDocument.css'

import GitWindowApp from './GitWindowApp.vue'
import GitLeftApp from './GitLeftApp.vue'
import GitDetailApp from './GitDetailApp.vue'

// Zero-flash initial theme: the host passes the current app theme as `?theme=`
// (the plugin origin has no `window.agentTeam.getBootstrapSettings`, so the
// settings cache seeds empty here). Stamp `data-theme` before mount and seed
// the cache with the store's JSON-string encoding so useTheme.loadTheme()
// keeps it; the connect-time `ui.settings.get` reconcile then takes over.
// Mirrors plugins/plans/mount.ts.
const query = new URLSearchParams(window.location.search)
const initialLocale = resolveAvailableUiLocale(query.get('locale'))
const initialTheme = query.get('theme')
const initialThemeCustom = query.get('git_theme_custom')
const initialYolo = query.get('git_yolo') ?? '1'
const initialAnalyzerModel = query.get('git_analyzer_model') ?? ''
const initialSettings: Record<string, unknown> = {
  'agentTeam.yolo': initialYolo === '0' ? '0' : '1',
  'agentTeam.analyzerModel': initialAnalyzerModel,
}
if (initialTheme) {
  document.documentElement.setAttribute('data-theme', initialTheme)
  initialSettings['agent-team:theme'] = JSON.stringify(initialTheme)
}
if (initialThemeCustom) initialSettings['agent-team:theme-custom'] = initialThemeCustom
if (initialLocale) {
  initialSettings['agent-team:language'] = initialLocale
  i18n.global.locale.value = initialLocale
}
seedSettings(initialSettings)
const offLanguageSettings = onSettingsChanged((keys) => {
  if (!keys.includes('agent-team:language')) return
  const language = resolveAvailableUiLocale(settingsGet<string>('agent-team:language', ''))
  if (language) {
    i18n.global.locale.value = language
  }
})
window.addEventListener('unload', offLanguageSettings, { once: true })

const backend = useBackend()
const capabilitySdk = createPluginCapabilitySdk(backend)
const gitSdk: PluginGitSdk = {
  status: capabilitySdk.status,
  request: capabilitySdk.request,
  subscribe: capabilitySdk.subscribe,
}
const gitTransport = createPluginGitTransport(gitSdk)
const surfacePorts = createPluginGitSurfacePorts(capabilitySdk, gitTransport)
const contributionHostPort = createPluginGitContributionHostPort(capabilitySdk)
const workspaceGrantPort = createPluginGitWorkspaceGrantPort(capabilitySdk)
const legacyRepoSelection = createPluginLegacyRepoSelectionPort(capabilitySdk)
const settingsPort = createPluginGitSettingsPort(capabilitySdk)
const isLeftContribution = query.get('contribution') === 'left'
const isDetailContribution = query.get('contribution') === 'branch-detail'

// The Git window owns the AI CLI panel, but not its transport.  Adapt the
// already-authenticated capability/event closure to the public controller
// shape so the panel never receives the generic backend or a raw terminal port.
const aiCliController = isLeftContribution || isDetailContribution ? null : createAiCliSessionController({
  capabilities: {
    invoke: (async (method: string, params: unknown) => {
      const response = await capabilitySdk.request(
        method,
        params as Record<string, unknown>,
      )
      if (!response.ok) {
        throw new Error(response.error?.message || `AI CLI capability '${method}' failed`)
      }
      return response.payload
    }) as AiCliPluginContext['capabilities']['invoke'],
  },
  events: {
    subscribe: ((event: string, listener: (payload: unknown) => void) => {
      const unsubscribe = capabilitySdk.subscribe(
        event,
        listener as (payload: unknown) => void,
      )
      return { dispose: unsubscribe }
    }) as AiCliPluginContext['events']['subscribe'],
  },
})

// Hook shared settings to the same authenticated ui capability closure before
// the app reads any cached setting.
initSettingsBackend(settingsPort)
initKeybindingsPort(createPluginKeybindingsPort())

function mountPlugin(): void {
  const app = isLeftContribution
    ? createApp(GitLeftApp, { surfacePorts, hostPort: contributionHostPort, legacyRepoSelection })
    : isDetailContribution
      ? createApp(GitDetailApp)
      : createApp(GitWindowApp, { workspaceGrantPort, aiCliController: aiCliController! })
  app.use(i18n)
  app.provide(GIT_TRANSPORT_KEY, surfacePorts.gitTransport)
  app.provide(GIT_FILE_ACCESS_KEY, surfacePorts.fileAccess)
  app.provide(GIT_UI_KEY, surfacePorts.ui)
  app.provide(GIT_BRANCH_DIFF_KEY, surfacePorts.branchDiff)
  app.provide(GIT_ACCOUNTS_KEY, surfacePorts.accounts)
  app.provide(GIT_ISSUES_KEY, surfacePorts.issues)
  app.mount('#app')

  // Announce readiness only after the app has mounted and installed every port.
  ;(window as unknown as { nav?: { ready?: () => void } }).nav?.ready?.()
}

try {
  mountPlugin()
} catch (error: unknown) {
  // A composition failure leaves an empty frame; the frame's own console is the
  // only place that can say why.
  console.error(
    `[navide.git] failed to mount the ${isDetailContribution ? 'detail' : isLeftContribution ? 'left' : 'window'} view.`,
    error,
  )
}
