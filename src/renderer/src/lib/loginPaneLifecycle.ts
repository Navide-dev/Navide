// What happens to a CLI sign-in pane once its CLI is done.
//
// A sign-in pane opened for an account slot (a profile id) is closed by the
// login-harvest broadcast, which names that slot. One opened with no slot —
// the install dialog's sign-in button, the live account's sign-in, the
// "switched account cannot authenticate" path — has nothing a harvest could
// name, so it is tracked by its pane id and judged by how its CLI ended: the
// vendor's auth subcommand (`codex login`, `claude auth login`) exits 0 once
// the sign-in landed. Any other ending keeps the pane so its error stays on
// screen.

export type LoginPaneExitAction = 'close' | 'keep'

export function loginPaneExitAction(input: {
  /** The pane is a slot-less sign-in pane this window opened. */
  tracked: boolean
  exitCode: number | null | undefined
}): LoginPaneExitAction {
  return input.tracked && input.exitCode === 0 ? 'close' : 'keep'
}

/** A sign-in pane whose CLI has ended can be restarted: as the ordinary CLI,
 *  not as another sign-in (see rebuildPaneViaResume). */
export function loginPaneRestartable(pane: { isLogin?: boolean }, status: string | undefined): boolean {
  return !!pane.isLogin && (status === 'exited' || status === 'error')
}
