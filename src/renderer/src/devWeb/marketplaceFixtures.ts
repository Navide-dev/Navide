// Dev-only sample Navide Marketplace for the web mode (navide-dev-web): the
// web mode has no main process to ask the Registry, so the Marketplace page
// would show nothing to look at or screenshot. Imported only by devWebShim.ts,
// which the dev server injects when NAVIDE_DEV_WEB=1; no build contains it
// (scripts/check-no-dev-web.mjs). Every entry is made-up sample data under the
// `devweb-sample` namespace — nothing here is a real package or publisher.
// Shapes follow MarketplaceListResponse / MarketplaceExtensionDetail in
// src/preload/index.ts.

const NAMESPACE = 'devweb-sample'
const APP_VERSION = '0.2.46'

interface SampleVersion {
  version: string
  published_at: string
  yanked?: boolean
  capabilities: string[]
  sensitive: string[]
  downloads: number
  target?: string
  min?: string
}

interface Sample {
  name: string
  display_name: string
  description: string
  categories: string[]
  targets: string[]
  featured?: boolean
  rating: [number, number]
  verified_domain?: string
  has_changelog?: boolean
  readme: string
  versions: SampleVersion[]
}

const SAMPLES: Sample[] = [
  {
    name: 'git-tools',
    display_name: 'Git Tools (sample)',
    description: 'See status, commit, switch branches and compare changes without leaving Navide.',
    categories: ['productivity', 'version-control'],
    targets: ['universal'],
    featured: true,
    rating: [0, 0],
    verified_domain: 'sample.invalid',
    has_changelog: true,
    readme:
      '# Git Tools (sample)\n\nA made-up package for the dev web mode.\n\n## What it does\n\n- Shows the working tree status\n- Commits and switches branches\n- Compares changes side by side\n',
    versions: [
      { version: '1.0.11', published_at: '2026-11-20T00:00:00Z', capabilities: ['fs', 'ui', 'aiCli', 'shell'], sensitive: ['fs', 'aiCli', 'shell'], downloads: 2, min: '0.2.30' },
      { version: '1.0.7', published_at: '2026-11-15T00:00:00Z', capabilities: ['fs', 'ui', 'aiCli', 'shell'], sensitive: ['fs', 'aiCli', 'shell'], downloads: 3, min: '0.2.30' },
      { version: '0.2.31', published_at: '2026-10-25T00:00:00Z', yanked: true, capabilities: ['fs', 'ui', 'shell'], sensitive: ['fs', 'shell'], downloads: 4 },
    ],
  },
  {
    name: 'web-browser',
    display_name: 'Web Browser (sample)',
    description: 'Open sites in a pane next to your agents and keep their sign-ins.',
    categories: ['productivity'],
    targets: ['universal'],
    rating: [4.6, 12],
    readme: '# Web Browser (sample)\n\nA made-up package for the dev web mode.\n',
    versions: [
      { version: '1.2.0', published_at: '2026-11-18T00:00:00Z', capabilities: ['ui', 'web'], sensitive: ['web'], downloads: 31 },
      { version: '1.1.0', published_at: '2026-10-30T00:00:00Z', capabilities: ['ui', 'web'], sensitive: ['web'], downloads: 18 },
    ],
  },
  {
    name: 'plan-board',
    display_name: 'Plan Board (sample)',
    description: 'Read and approve plan documents beside the terminal.',
    categories: ['productivity'],
    targets: ['universal'],
    rating: [4.1, 5],
    readme: '# Plan Board (sample)\n\nA made-up package for the dev web mode.\n',
    versions: [{ version: '1.0.3', published_at: '2026-11-12T00:00:00Z', capabilities: ['ui'], sensitive: [], downloads: 44 }],
  },
  {
    name: 'notes-sync',
    display_name: 'Notes Sync (sample)',
    description: 'Sync agent notes to a folder you choose, on macOS only.',
    categories: ['ai'],
    targets: ['darwin-arm64', 'darwin-x64'],
    rating: [3.8, 3],
    readme: '# Notes Sync (sample)\n\nA made-up package for the dev web mode.\n',
    versions: [
      { version: '0.4.0', published_at: '2026-11-02T00:00:00Z', capabilities: ['fs', 'secrets'], sensitive: ['fs', 'secrets'], downloads: 9, target: 'darwin-arm64' },
      { version: '0.4.0', published_at: '2026-11-02T00:00:00Z', capabilities: ['fs', 'secrets'], sensitive: ['fs', 'secrets'], downloads: 3, target: 'darwin-x64' },
    ],
  },
]

const CATEGORIES = [
  { slug: 'productivity', label: 'Productivity', count: 3 },
  { slug: 'version-control', label: 'Version control', count: 1 },
  { slug: 'ai', label: 'AI', count: 1 },
]

function latest(sample: Sample): SampleVersion {
  return sample.versions.find((v) => !v.yanked) ?? sample.versions[0]
}

function listItem(sample: Sample): Record<string, unknown> {
  const head = latest(sample)
  return {
    namespace: NAMESPACE,
    name: sample.name,
    identity: `${NAMESPACE}.${sample.name}`,
    display_name: sample.display_name,
    description: sample.description,
    categories: sample.categories,
    latest_version: head.version,
    latest_targets: sample.targets,
    installable: true,
    download_count: sample.versions.reduce((sum, v) => sum + v.downloads, 0),
    rating_average: sample.rating[0],
    featured: sample.featured === true,
    compatible: true,
    min_navide_version: head.min ?? null,
    app_version: APP_VERSION,
    license: 'MIT',
    repository: null,
    homepage: null,
    icon_path: null,
    extension_pack: null,
    trust_tier: 'signed-verified',
    latest_prerelease_version: null,
  }
}

function search(query?: string, _sort?: string, options?: { category?: string } | null): Record<string, unknown> {
  const text = (query ?? '').trim().toLowerCase()
  const items = SAMPLES.filter(
    (sample) =>
      (!text || `${sample.display_name} ${sample.description}`.toLowerCase().includes(text)) &&
      (!options?.category || sample.categories.includes(options.category))
  ).map(listItem)
  return { items, total: items.length, offset: 0, limit: 20, site_url: 'https://marketplace.sample.invalid' }
}

function detail(args: { namespace?: string; name?: string } | null): Record<string, unknown> {
  const sample = SAMPLES.find((s) => s.name === args?.name) ?? SAMPLES[0]
  const head = latest(sample)
  return {
    ...listItem(sample),
    updated_at: head.published_at,
    rating_count: sample.rating[1],
    publisher: 'Sample Publisher',
    host_target: 'darwin-arm64',
    latest_installable_version: head.version,
    latest_compatible_version: head.version,
    gets_prereleases: false,
    has_changelog: sample.has_changelog === true,
    verified_domain: sample.verified_domain ?? null,
    screenshots: [],
    web_url: `https://marketplace.sample.invalid/extensions/${NAMESPACE}/${sample.name}`,
    readme: sample.readme,
    versions: sample.versions.map((v) => ({
      version: v.version,
      published_at: v.published_at,
      target: v.target ?? 'universal',
      yanked: v.yanked === true,
      trust_tier: 'signed-verified',
      capabilities: v.capabilities,
      sensitive_capabilities: v.sensitive,
      download_count: v.downloads,
      installable: !v.target || v.target === 'darwin-arm64',
      compatible: true,
      min_navide_version: v.min ?? null,
      channel: 'stable',
      disclosure: null,
      scan: null,
      registry: null,
    })),
  }
}

/** Dotted bridge paths the dev web mode answers with sample data. */
export const MARKETPLACE_FIXTURES: Record<string, (...args: never[]) => unknown> = {
  'plugins.marketplaceSearch': search,
  'plugins.marketplaceCategories': () => CATEGORIES,
  'plugins.marketplaceDetail': detail,
  'plugins.marketplaceChangelog': () => '## 1.0.11\n\n- Sample change for the dev web mode.\n',
  'plugins.marketplaceIcon': () => null,
  'plugins.marketplacePackMembers': () => [],
}
