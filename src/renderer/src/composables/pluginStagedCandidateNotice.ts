import { i18n } from '@navide/plugin-ui/foundation'

/** Text for the Host's report that a plugin installed without Restart could
 *  not be activated at launch; says where Restart and Discard still are. */
export function pluginStagedCandidateNotice(notice: { pluginId: string; version: string; reason: string }): string {
  return i18n.global.t('label.plugin-staged-not-activated', {
    plugin: notice.pluginId,
    version: notice.version,
    reason: notice.reason,
  })
}
