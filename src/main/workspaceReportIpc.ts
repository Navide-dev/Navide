import type { BrowserWindow, IpcMainEvent } from 'electron'
import { isTrustedPluginManagementSender } from './plugins/pluginIpc'

/** Only a registered main window's top frame may say which repository it shows,
 *  because a workbench acceptance applies to that repository. A missing frame
 *  is refused, as `isAppWindowSender` and `trustedGitLeftWindow` refuse it. */
export function mayReportWorkspace(
  event: Pick<IpcMainEvent, 'sender' | 'senderFrame'>,
  mainWindows: ReadonlySet<BrowserWindow>,
): boolean {
  return Boolean(event.senderFrame) && isTrustedPluginManagementSender(event, mainWindows)
}
