// The user's pipeline Reset closes every pane of the workspace on screen —
// panes the user opened by hand included — so it asks first and names each
// pane that will close. The host builds the list from the same panes its
// teardown kills; this only words the dialog.

type Translate = (key: string, values?: Record<string, unknown>, plural?: number) => string

export interface ResetPane {
  name: string
  /** Opened by the user, not by a run: called out, since Reset closes it too. */
  manual: boolean
}

export interface ResetConfirmDialog {
  title: string
  message: string
  /** One pane per line; absent when no pane is open. */
  detail?: string
  confirmText: string
  danger: true
}

export function resetConfirmDialog(t: Translate, panes: readonly ResetPane[]): ResetConfirmDialog {
  const base = { title: t('pipelineEditor.run.reset-title'), confirmText: t('pipelineEditor.run.reset-confirm'), danger: true as const }
  if (!panes.length) return { ...base, message: t('pipelineEditor.run.reset-message-none') }
  const mark = t('pipelineEditor.run.reset-manual-mark')
  return {
    ...base,
    message: t('pipelineEditor.run.reset-message', { count: panes.length }, panes.length),
    detail: panes.map((p) => (p.manual ? `• ${p.name} (${mark})` : `• ${p.name}`)).join('\n'),
  }
}
