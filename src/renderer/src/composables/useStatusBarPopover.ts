import { ref, type Ref } from 'vue'

/** Ids of the popovers anchored to the status bar. */
export type StatusBarPopoverId = 'backend' | 'announcements' | 'clock' | 'resource' | 'notify'

/**
 * One open-popover id instead of one boolean per popover: independent booleans
 * let every status-bar popover be open at once, stacked over each other.
 */
export function useStatusBarPopover(): {
  openPopover: Ref<StatusBarPopoverId | null>
  toggle: (id: StatusBarPopoverId) => void
  close: () => void
} {
  const openPopover = ref<StatusBarPopoverId | null>(null)
  return {
    openPopover,
    toggle: (id) => {
      openPopover.value = openPopover.value === id ? null : id
    },
    close: () => {
      openPopover.value = null
    },
  }
}
