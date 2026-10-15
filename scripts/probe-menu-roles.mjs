// Print the accelerator Electron installs behind each menu role, so the
// transcription in packages/plugin-ui/src/shared/keybindings/externalKeys.ts can be checked
// against the shipped Electron instead of against memory.
//
//   npx electron scripts/probe-menu-roles.mjs
//
// getDefaultRoleAccelerator() answers for the platform it runs on, so a macOS
// run fills the `mac` column only. Run it again on Windows or Linux to verify
// the `other` column — the roles that branch (toggleDevTools, togglefullscreen)
// cannot be seen from macOS at all.
//
// Headless on purpose: no window, no dock icon, exits as soon as it has printed.
import { app, MenuItem } from 'electron'

// Every role src/main/menu.ts installs, plus the ones it deliberately omits —
// those are omitted precisely because of the keys they would claim, so knowing
// their accelerators is the point.
const ROLES = [
  'about', 'close', 'cut', 'delete', 'front', 'help', 'hide', 'hideOthers',
  'minimize', 'paste', 'pasteAndMatchStyle', 'quit', 'redo', 'reload',
  'selectAll', 'services', 'toggleDevTools', 'togglefullscreen', 'undo',
  'unhide', 'zoom',
  'forceReload', 'resetZoom', 'zoomIn', 'zoomOut',
]

app.dock?.hide()

app.whenReady().then(() => {
  const roles = {}
  for (const role of ROLES) {
    try {
      const item = new MenuItem({ role })
      // Not MenuItem.accelerator: that reports only an explicitly set one and
      // is null for every role.
      roles[role] = item.getDefaultRoleAccelerator?.() ?? null
    } catch (err) {
      roles[role] = `ERROR: ${err.message}`
    }
  }
  process.stdout.write(
    JSON.stringify({ platform: process.platform, electron: process.versions.electron, roles }, null, 2) + '\n'
  )
  app.exit(0)
})
