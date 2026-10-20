/** Capability addresses the catalog marks `requiresUserGesture`. Kept as a
 * tiny module so the sandboxed plugin preload can share it without bundling
 * the full capability catalog; a test pins it to the catalog declarations. */
export const USER_GESTURE_CAPABILITY_ADDRESSES: readonly string[] = [
  'ui.openExternal',
  'web.create',
  'web.setOwner',
  'web.takeControl',
  'web.returnControl',
  'web.clearData',
]
