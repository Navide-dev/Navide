/**
 * Plugin Developer Mode (the dist-plugins dev descriptors, the probe-plugin
 * menu and the AGENT_TEAM_PLUGIN_DEV_PATH unsigned local package) exists for
 * development builds only. A packaged build ignores AGENT_TEAM_PLUGIN_DEV so
 * an environment variable cannot sideload an unsigned plugin into a shipped
 * app. A packaged build installs from a file the user picked by hand in the
 * main window (card K3), never from one an environment variable names.
 *
 * Card K4 adds the user's own switch (Settings → Navide Plugins → Developer
 * Mode, stored by the main process): in a packaged build it is the only way
 * in, and it loads folders the user picks in the main window, never
 * AGENT_TEAM_PLUGIN_DEV_PATH. A development build keeps its environment
 * variable as before; the switch, off by default, only adds to it.
 */
export function pluginDeveloperModeEnabled(
  env: Record<string, string | undefined>,
  isPackaged: boolean,
  userSwitch = false,
): boolean {
  if (isPackaged) return userSwitch
  return env['AGENT_TEAM_PLUGIN_DEV'] === '1' || userSwitch
}
