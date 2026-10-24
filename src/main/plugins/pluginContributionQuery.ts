import { validateSupportedLocale } from '../hostLocale'

export interface PluginContributionQueryOptions {
  contributionKey: string
  workspacePath: string
  theme: string
  locale?: string
  httpUrl?: string
  gitReadOnly?: Record<string, string>
  extraParams?: Record<string, string>
  /** The workspace's user-set alias (`Project.display_name`), for the title of
   *  the window a `window` contribution lives in. Omitted from the query when
   *  blank so the view can tell "no alias" — fall back to
   *  `basename(workspace_path)` — from an alias equal to the folder name, and
   *  so the query of every surface that has no title of its own is unchanged.
   *  KNOWN LIMITATION: a load-time snapshot. A rename while the window is open
   *  does not retitle it, because plugin views have no
   *  `project.ui_state_changed` subscription (project.* is in neither CAP_MAP
   *  nor CAP_EVENTS). */
  workspaceDisplayName?: string
}

export function composePluginContributionQuery(options: PluginContributionQueryOptions): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(options.extraParams ?? {})) params.set(key, value)
  params.set('workspace_path', options.workspacePath)
  const displayName = (options.workspaceDisplayName ?? '').trim()
  if (displayName) params.set('workspace_display_name', displayName)
  if (options.httpUrl) params.set('http_url', options.httpUrl)
  else params.delete('http_url')
  params.set('theme', options.theme)
  if (options.locale !== undefined) {
    const validLocale = validateSupportedLocale(options.locale) ?? 'zh-TW'
    params.set('locale', validLocale)
  } else {
    params.delete('locale')
  }
  for (const [key, value] of Object.entries(options.gitReadOnly ?? {})) params.set(key, value)
  params.set('v2', '1')
  const contribution = options.contributionKey.split('.').at(-1)
  if (contribution === 'left' || contribution === 'window') {
    params.set('contribution', contribution)
  }
  return `?${params.toString()}`
}

/** Load-time query for a composed provider frame — the plugin's own UI rendering
 *  inside a receiver, rather than in its own window. It carries the same
 *  context a contribution window gets: the workspace it belongs to, the
 *  manifest-v2 runtime, and the VIEW ID (`left`, `window`, `branch-detail`),
 *  which is what a plugin app dispatches on to mount the right surface. */
export function composePluginFrameQuery(contributionKey: string, workspacePath: string): string {
  const params = new URLSearchParams({
    workspace_path: workspacePath,
    v2: '1',
    contribution: contributionKey.split('.').at(-1) ?? '',
  })
  return `?${params.toString()}`
}
