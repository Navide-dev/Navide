import { computed, onScopeDispose, reactive, watch, type WatchSource } from 'vue'

// Overlays that pop up by themselves — a CLI question, the job editor — sit
// below the welcome tour's coach-mark mask, which would swallow their clicks.
// Each registers while it is open, and the tour steps aside until none is
// (App.vue's welcomeTourSuspended and pollWelcomeTour).

const open = reactive(new Set<symbol>())

/** Some registered overlay is open. */
export const tourBlocked = computed(() => open.size > 0)

/** Hold the tour off while `isOpen` is true, and when the caller's scope ends. */
export function blockTourWhile(isOpen: WatchSource<boolean>): void {
  const id = Symbol('tour-blocker')
  watch(isOpen, (value) => (value ? open.add(id) : open.delete(id)), { immediate: true })
  onScopeDispose(() => open.delete(id))
}
