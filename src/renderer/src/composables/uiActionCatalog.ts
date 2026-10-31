// The action catalog: what ui_invoke accepts, described.
//
// ui_list_actions answers plain ids, so an agent has to guess an action's args
// and only learns it was off limits by being refused. `ui.actions.describe`
// answers from this table instead. Button lists and action groups read the
// same table, so what an agent is told and what the user can pick stay one
// thing.
//
// Only `ui.*` actions have entries: they are the documented external contract
// (docs/en-US/external-mcp-control.md). Every other id still appears with the
// title and category `describeCommand` derives, and no args — those ids exist
// for keyboard shortcuts and promise nothing.
//
// The table is static for the same reason COMMAND_IDS is: commands carry no
// metadata where they are registered. uiActionCatalog.test.ts rebuilds the set
// from the source and fails on drift in either direction, and checks humanOnly
// and dedicatedTool against the backend's own refusals.
//
// ui.accounts.* cannot appear here: those actions are deliberately not in the
// command registry, and this module describes only ids it is handed from it.
import { describeCommand } from '@navide/plugin-ui/shared'
import { WORKSPACE_SCOPED_ACTIONS } from './useUiActionBus'

interface UiActionSpec {
  /** Shape of `args`; omitted when the action takes none. */
  args?: string
  summary: string
  /** The refusal the backend answers an agent with (error_code ui_human_only).
   *  `true` is every call, a string is the condition it applies under. */
  humanOnly?: true | string
  /** ui_invoke refuses this action and names this tool instead. */
  dedicatedTool?: string
}

export const UI_ACTION_SPECS: Readonly<Record<string, UiActionSpec>> = {
  'ui.actions.describe': { args: '{prefix?}', summary: 'Describe the registered actions, optionally only the ids starting with prefix' },
  'ui.diagnostics.read': { args: '{sinceSeq?, paneId?, limit?}', summary: 'Read the window diagnostics behind ui_diagnostics' },
  'ui.groupPeers': { args: '{paneId}', summary: 'List the panes a group broadcast from paneId would reach' },
  'ui.layout.setMode': { args: '{mode}', summary: 'Change the pane layout mode' },
  'ui.messaging.readIncoming': { args: '{paneId, uids?, limit?, includeDelivered?, reserve?, maxChars?}', summary: "Read the calling pane's own queued mail" },
  'ui.messaging.settleRead': { args: '{paneId, uids, ok?}', summary: 'Settle a reservation taken by ui.messaging.readIncoming' },
  'ui.pane.close': { args: '{paneId}', summary: 'Kill a pane' },
  'ui.pane.create': { args: '{agent, name?, task?}', summary: "Spawn a pane in the window's open workspace" },
  'ui.pane.focus': { args: '{paneId}', summary: 'Reveal and focus a pane, switching tab if needed' },
  'ui.pane.getStatus': { args: '{paneId}', summary: "Read a pane's status and recent output" },
  'ui.pane.interrupt': { args: '{paneId}', summary: "Press a pane's interrupt key" },
  'ui.pane.moveToWindow': { args: '{paneId, to}', summary: 'Move a pane to another window', dedicatedTool: 'window_move_pane' },
  'ui.pane.open': { args: '{paneId}', summary: 'Open a restore placeholder and wait for it' },
  'ui.pane.place': { args: '{paneId, runGroupId?, spawnedBy?}', summary: 'Move a pane to a tab group or under another pane' },
  'ui.pane.reclaim': { args: '{paneId} (one id or an array)', summary: "Free finished panes' resources, keeping each as a resumable card" },
  'ui.pane.sendKeys': { args: '{paneId, answer, expected?}', summary: "Answer a pane's prompt", humanOnly: true },
  'ui.pipeline.abort': { summary: 'Abort the run in progress' },
  'ui.pipeline.gate_pass': { args: '{nodeId?}', summary: 'Pass the gate the run is waiting on' },
  'ui.pipeline.gate_reject': { args: '{nodeId?, comment?}', summary: 'Reject the gate the run is waiting on and rerun from its reject edge' },
  'ui.pipeline.next': { summary: 'Advance the running pipeline to its next stage' },
  'ui.pipeline.reset': { summary: "Close every pane in the window's workspace and clear the run" },
  'ui.pipeline.restart': { summary: 'Start the recorded run over from stage one' },
  'ui.pipeline.restart_from': { args: '{nodeId, task?}', summary: 'Start a new run at the stage of a graph node' },
  'ui.pipeline.resume': { summary: 'Resume the recorded run after its last finished stage' },
  'ui.pipeline.start': { args: '{task?, pipelineId?}', summary: "Start a pipeline run in the window's open workspace" },
  'ui.plugins.openDeveloperMode': { summary: 'Open the Developer Mode section of Settings' },
  'ui.plugins.openInstallFromFile': { summary: 'Open the install-from-file section of Settings' },
  'ui.plugins.openMarketplace': { args: '{id?}', summary: "Open the Marketplace, or one Navide plugin's page" },
  'ui.preview.show': { args: '{kind, …}', summary: 'Show a file, diff or snippet in the preview panel' },
  'ui.settings.close': { summary: 'Close Settings' },
  'ui.settings.open': { args: '{tab?}', summary: 'Open Settings, optionally to a specific tab' },
  'ui.settings.yolo': { args: '{yolo?}', summary: 'Read the global permission-bypass switch, or set it', humanOnly: 'yolo is true' },
  'ui.tab.switch': { args: '{tabId}', summary: 'Switch the active stage tab' },
  'ui.window.close': { args: '{windowId}', summary: 'Close a window', dedicatedTool: 'window_close' },
  'ui.window.describe': { summary: 'Describe this window and the workspaces it holds' },
  'ui.window.focus': { args: '{workspace_path?}', summary: 'Bring this window to the front, switching workspace first if given' },
  'ui.window.openGit': { summary: 'Open the Git window for the current workspace' },
  'ui.window.openPipeline': { args: '{pipelineId?}', summary: 'Open the Pipeline Manager window' },
  'ui.window.openPlans': { args: '{rel_path?}', summary: 'Open the Plan window, optionally on one document' },
  'ui.window.openResourceManager': { summary: 'Open the Resource Manager' },
  'ui.window.openTurnStats': { summary: 'Open Turn Stats' },
  'ui.workspace.adopt': { args: '{path}', summary: "Take a project into this window's sidebar", dedicatedTool: 'cli_open_agent with workspace_path' },
  'ui.workspace.close': { args: '{path, keepPanes?}', summary: 'Close a workspace this window holds', dedicatedTool: 'workspace_close' },
  'ui.workspace.moveToWindow': { args: '{path, to}', summary: 'Move a workspace to another window', dedicatedTool: 'window_move_pane' },
  'ui.workspace.open': { args: '{path}', summary: 'Open a path as a workspace, in any live window' },
  'ui.workspace.receive': { args: '{path, paneIds?}', summary: 'Receive a workspace moved from another window', dedicatedTool: 'window_move_pane' },
  'ui.workspace.switch': { args: '{path}', summary: 'Switch this window to a workspace it already holds' },
}

/** Not `ui.*`, so it has no spec, but ui_invoke refuses it all the same. */
const OTHER_DEDICATED_TOOLS: Readonly<Record<string, string>> = {
  'workbench.action.closeWindow': 'window_close',
}

export interface UiActionInfo {
  id: string
  title: string
  category: string
  /** Absent: takes no args, or (no summary either) an id with no documented contract. */
  args?: string
  summary?: string
  humanOnly?: true | string
  dedicatedTool?: string
  /** Refused when the window has switched to another project. */
  workspaceScoped: boolean
}

export function describeUiAction(id: string): UiActionInfo {
  const { label, category } = describeCommand(id)
  const spec = UI_ACTION_SPECS[id]
  const dedicatedTool = spec?.dedicatedTool ?? OTHER_DEDICATED_TOOLS[id]
  return {
    id,
    title: label,
    category,
    ...(spec?.args ? { args: spec.args } : {}),
    ...(spec ? { summary: spec.summary } : {}),
    ...(spec?.humanOnly ? { humanOnly: spec.humanOnly } : {}),
    ...(dedicatedTool ? { dedicatedTool } : {}),
    workspaceScoped: WORKSPACE_SCOPED_ACTIONS.has(id),
  }
}

/** `ids` is the window's registry; a prefix narrows it. `overlay` lets a
 *  command the table cannot know, a Navide plugin's, describe itself. */
export function describeUiActions(
  ids: readonly string[],
  prefix?: unknown,
  overlay?: (id: string) => Partial<UiActionInfo> | undefined,
): UiActionInfo[] {
  const wanted = typeof prefix === 'string' ? ids.filter((id) => id.startsWith(prefix)) : ids
  return wanted.map((id) => ({ ...describeUiAction(id), ...overlay?.(id) }))
}
