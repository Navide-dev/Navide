import { i18n } from '@navide/plugin-ui/foundation'

/** Text for the Host's report that a workspace's agent Plans backend stopped
 *  for good. Names the folder only, never the rest of its path. */
export function plansBackendStoppedNotice(workspacePath: string): string {
  const folder = workspacePath.split(/[\\/]/).filter(Boolean).pop() ?? workspacePath
  return i18n.global.t('label.plans-backend-stopped', { folder })
}
