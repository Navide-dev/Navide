// A2-3: who had a developer folder loaded (DESIGN-A2 G3), in the wording of
// agent request cards, for the "Local folder" info card.
import { revealInvisibleText as reveal } from '../../../shared/pluginAgentTools'

export type DeveloperFolderLoadedBy =
  | { kind: 'user' }
  | { kind: 'agent'; callerKind: string; paneName?: string; approvedAt: string }
  | { kind: 'unknown' }

export function developerFolderLoadedByText(
  loadedBy: DeveloperFolderLoadedBy | undefined,
  t: (key: string, values?: Record<string, unknown>) => string,
): string {
  if (!loadedBy || loadedBy.kind === 'unknown') return t('settings.extensions.developerMode.loadedByUnknown')
  if (loadedBy.kind === 'user') return t('settings.extensions.developerMode.loadedByUser')
  const requester = loadedBy.callerKind === 'pane' && loadedBy.paneName
    ? t('plugin-agent.caller.pane', { name: reveal(loadedBy.paneName) })
    : loadedBy.callerKind === 'external' ? t('plugin-agent.caller.external')
      : loadedBy.callerKind === 'host' ? t('plugin-agent.caller.host')
        : t('plugin-request.caller-unknown')
  return t('settings.extensions.developerMode.loadedByAgent', { requester, at: new Date(loadedBy.approvedAt).toLocaleString() })
}
