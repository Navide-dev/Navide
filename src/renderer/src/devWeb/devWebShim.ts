// Dev-only web mode shim. Never imported by the app: the dev server injects it
// into index.html only when started with NAVIDE_DEV_WEB=1 (see
// scripts/dev-web/devWebPlugin.ts), so no build ever contains it — and
// scripts/check-no-dev-web.mjs fails a build that does.
//
// In a browser there is no preload, so this stands in for window.agentTeam:
// backend info and window proofs come from the dev server; everything else
// the desktop bridge does is answered with a visible "not supported in web
// mode" notice and an undefined (or empty) result. Inside Electron the real bridge
// exists and this does nothing.

type PlatformId = 'darwin' | 'win32' | 'linux'

export interface DevWebBridgeDeps {
  fetchJson(url: string, init?: RequestInit): Promise<unknown>
  /** Called with the dotted name of each unsupported call. */
  notify(name: string): void
  platform: PlatformId
}

const PREFIX = '/__navide_dev_web/'

// Unsupported calls whose callers read the result without a guard get an
// empty-but-well-formed value instead of undefined (still with a notice), so
// the main window renders. Shapes follow src/preload/index.ts.
const EMPTY_RESULTS: Record<string, unknown> = {
  readHealthCheckTimeout: { ok: false },
  readKeybindings: { ok: false },
  getZoomFactor: 1,
  getHomeDir: '',
  listOpenWorkspaces: [],
  getDetachedGroups: [],
  takeRestoredAdoptedWorkspaces: [],
  'restore.getPending': null,
  'restore.getSkipped': [],
  'plugins.listContributions': [],
  // The Navide Plugins and Navide Marketplace pages as in an app with no
  // third-party Navide plugins, Developer Mode off and nothing pending.
  'plugins.listInstalled': [],
  'plugins.listFactoryPackages': [],
  'plugins.checkUpdates': [],
  'plugins.pendingUpdates': [],
  'plugins.listPacks': [],
  'plugins.developerMode': { enabled: false, folders: [] },
  'plugins.developerModeReminderDismissed': false,
  'plugins.disabledBuiltins': [],
  'plugins.disabledStoreStatus': { status: 'ok' },
  'plugins.expiredTestplace': [],
  'plugins.clockQuarantine': [],
  'plugins.selfHostedQuarantine': [],
  'plugins.installedDisclosures': [],
  'plugins.backendResourceUsage': {
    children: { current: 0, peak: 0, retained: 0 },
    views: [],
    plugins: [],
  },
  'plugins.nativeBackends.list': { enabled: true, plugins: [] },
  'plugins.nativeBackends.resourceNotices': [],
  'plugins.marketplaceCategories': [],
  'plugins.marketplaceSearch': { items: [], total: 0, offset: 0, limit: 20 },
  // A healthy store on the Host default (src/main/plugins/executionPolicy.ts),
  // with no workspace and an empty shell allowlist.
  'executionPolicy.inspect': {
    defaultPolicy: { schemaVersion: 1, mode: 'allowlist', system: ['fs', 'ui', 'aiCli', 'web', 'agents'], shell: [] },
    userPolicy: null,
    global: {
      policy: { schemaVersion: 1, mode: 'allowlist', system: ['fs', 'ui', 'aiCli', 'web', 'agents'], shell: [] },
      revision: 0,
      state: 'default',
    },
    workspace: null,
    recovery: { state: 'healthy', canRebuild: false, unsafePaths: [] },
    sourceRecovery: { state: 'healthy', canReset: false, unsafePaths: [] },
  },
  'deepLink.ready': [],
  'permissions.status': { automation: 'unknown', notifications: 'unknown', folders: 'unknown', fullDisk: 'unknown' },
  'gitAccounts.isAvailable': { ok: false },
  'gitAccounts.list': { ok: true, accounts: [] },
  'updater.getState': { status: 'unsupported', currentVersion: 'dev-web' },
  'updater.getSettings': {
    autoCheck: false,
    autoDownload: false,
    autoInstallOnQuit: false,
    channel: 'stable',
    notifyOnCheckFailure: false,
    checkFailureThreshold: 3,
    retryDownload: false,
    downloadRetryCount: 0,
    installTimeoutSeconds: 30,
  },
}

export function createDevWebBridge(deps: DevWebBridgeDeps): unknown {
  const implemented: Record<string, unknown> = {
    appName: 'Agent-Team',
    version: 'dev-web',
    platform: deps.platform,
    legalLinks: {},
    getBootstrapSettings: (): string => '{}',
    getBackendInfo: () => deps.fetchJson(`${PREFIX}backend`, undefined),
    proveWindow: async (nonce: string): Promise<string | null> => {
      const answer = (await deps.fetchJson(`${PREFIX}prove`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nonce }),
      })) as { proof?: unknown }
      return typeof answer?.proof === 'string' ? answer.proof : null
    },
  }

  // A callable proxy per dotted path, so both `agentTeam.fn()` and
  // `agentTeam.ns.fn()` land here without listing the bridge's ~150 members.
  const node = (path: string): unknown =>
    new Proxy(function devWebUnsupported() {}, {
      get(_target, key) {
        // Never look like a promise or a serialisable value.
        if (typeof key === 'symbol' || key === 'then' || key === 'toJSON') return undefined
        if (!path && Object.prototype.hasOwnProperty.call(implemented, key)) return implemented[key]
        return node(path ? `${path}.${key}` : key)
      },
      apply() {
        const last = path.slice(path.lastIndexOf('.') + 1)
        // Event subscriptions simply never fire; hand back a disposer.
        if (/^on[A-Z]/.test(last)) return () => {}
        deps.notify(path)
        return Promise.resolve(structuredClone(EMPTY_RESULTS[path]))
      },
    })
  return node('')
}

function detectPlatform(): PlatformId {
  const ua = navigator.userAgent
  if (/Mac/.test(ua)) return 'darwin'
  if (/Windows/.test(ua)) return 'win32'
  return 'linux'
}

interface DevWebState {
  unsupported: string[]
}

function install(): void {
  const state: DevWebState = { unsupported: [] }
  ;(window as unknown as { __navide_dev_web__: DevWebState }).__navide_dev_web__ = state

  const banner = document.createElement('div')
  banner.id = 'navide-dev-web-notice'
  banner.setAttribute('role', 'status')
  banner.style.cssText =
    'position:fixed;left:8px;bottom:8px;z-index:var(--z-toast);max-width:60vw;padding:4px 8px;' +
    'font:11px/1.4 system-ui,sans-serif;color:#1f2328;background:#ffd33d;border-radius:4px;' +
    'opacity:.9;pointer-events:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis'
  const render = (): void => {
    const n = state.unsupported.length
    banner.textContent = n
      ? `Dev web mode — not supported in web mode (${n}): ${state.unsupported[n - 1]}`
      : 'Dev web mode'
  }
  render()
  const mount = (): void => {
    document.body.appendChild(banner)
  }
  if (document.body) mount()
  else document.addEventListener('DOMContentLoaded', mount, { once: true })

  const bridge = createDevWebBridge({
    platform: detectPlatform(),
    fetchJson: async (url, init) => {
      const res = await fetch(url, { credentials: 'same-origin', ...init })
      if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
      return res.json()
    },
    notify: (name) => {
      state.unsupported.push(name)
      console.warn(`[dev-web] not supported in web mode: agentTeam.${name}`)
      render()
    },
  })
  ;(window as unknown as { agentTeam: unknown }).agentTeam = bridge
}

if (typeof window !== 'undefined' && !(window as unknown as { agentTeam?: unknown }).agentTeam) install()
