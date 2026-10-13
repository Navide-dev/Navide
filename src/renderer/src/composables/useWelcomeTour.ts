import { reactive, ref } from 'vue'
import { settingsGet, settingsSet } from '@navide/plugin-ui/shared'

// What the first-run welcome tour records, and whether it is running.
//
// `pending` is set only when the first-run wizard is completed (or put off)
// — never from the onboarding status check — so an install that was already
// set up before this tour existed never sees it; App.vue also calls it off
// when a workspace record turns up as it comes due. Ending it, finished or
// skipped, turns it off for good: it was pushed at the user, who may well
// not be new to Navide. Every start begins at the first bubble and passes over
// what is already done, so there is no saved step to go stale or for two
// windows to overwrite. A replay from the Help menu records nothing.
//
// The settings are shared by every main window, so one window owns the tour
// (`claim`): it alone judges, starts and runs it, keeping its claim fresh; a
// window that closed mid-tour is taken over once that goes stale. A window
// that sees the tour end elsewhere takes its own bubbles down (`release`).
//
// Most of what a step waits for is read off the window (App.vue's
// welcomeFacts); the three momentary actions — an @ pick, a pane dropped on
// another, the quota badge opened — are reported through `notify`, which
// records nothing unless the tour is running.
const PENDING_KEY = 'agentTeam.tour.welcome.pending'
const OWNER_KEY = 'agentTeam.tour.welcome.owner'
// This really is a first install (decided once; see nextWelcomeTourMove).
const ELIGIBLE_KEY = 'agentTeam.tour.welcome.eligible'

export type WelcomeMoment = 'mention' | 'drop' | 'usage'

/** When each momentary action last happened while the tour ran. */
export const welcomeActionTimes = reactive({ mentionAt: 0, dropAt: 0, usageAt: 0 })

/** Which tour is on screen in this window: the first-run one, a replay, or none. */
const active = ref<'first-run' | 'replay' | null>(null)

/** This window, for the owner claim. */
const WINDOW_ID = globalThis.crypto?.randomUUID?.() ?? `w-${Math.random().toString(36).slice(2)}`
/** An owner silent this long has gone (its window closed mid-tour). */
const OWNER_STALE_MS = 15_000
/** How often the owner refreshes its claim. */
const OWNER_HEARTBEAT_MS = 5_000

export function useWelcomeTour() {
  function pending(): boolean {
    return settingsGet<boolean>(PENDING_KEY, false) === true
  }

  /** The first-run wizard was just completed: the tour is due. */
  function markFirstRun(): void {
    settingsSet(PENDING_KEY, true)
    settingsSet(ELIGIBLE_KEY, false)
  }

  function eligible(): boolean {
    return settingsGet<boolean>(ELIGIBLE_KEY, false) === true
  }

  /** No workspace record was found: this is a first install, for good. */
  function markEligible(): void {
    settingsSet(ELIGIBLE_KEY, true)
  }

  /** Not a first install after all: the tour is off. */
  function cancel(): void {
    settingsSet(PENDING_KEY, false)
    settingsSet(OWNER_KEY, null)
    if (active.value === 'first-run') active.value = null
  }

  /** Own the tour, or keep owning it: false while another window holds a
   *  fresh claim. */
  function claim(now = Date.now()): boolean {
    const owner = settingsGet<{ id?: string; at?: number } | null>(OWNER_KEY, null)
    const at = typeof owner?.at === 'number' ? owner.at : 0
    if (owner?.id && owner.id !== WINDOW_ID && now - at < OWNER_STALE_MS) return false
    if (owner?.id !== WINDOW_ID || now - at >= OWNER_HEARTBEAT_MS) {
      settingsSet(OWNER_KEY, { id: WINDOW_ID, at: now })
    }
    return true
  }

  /** The tour is no longer this window's to show (it ended elsewhere, or
   *  another window took it over): take its bubbles down. A replay stays. */
  function release(): void {
    if (active.value === 'first-run') active.value = null
  }

  function start(): boolean {
    if (active.value || !pending()) return false
    active.value = 'first-run'
    return true
  }

  function replay(): void {
    active.value = 'replay'
  }

  function finish(_completed: boolean): void {
    if (active.value === 'first-run') {
      settingsSet(PENDING_KEY, false)
      settingsSet(OWNER_KEY, null)
    }
    active.value = null
  }

  function notify(what: WelcomeMoment): void {
    if (!active.value) return
    welcomeActionTimes[`${what}At`] = Date.now()
  }

  return { active, pending, eligible, markFirstRun, markEligible, cancel, claim, release, start, replay, finish, notify }
}
