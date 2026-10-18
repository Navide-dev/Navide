/**
 * Plugin Developer Mode (the dist-plugins dev descriptors, the probe-plugin
 * menu and the AGENT_TEAM_PLUGIN_DEV_PATH unsigned local package) exists for
 * development builds only. A packaged build ignores AGENT_TEAM_PLUGIN_DEV so
 * an environment variable cannot sideload an unsigned plugin into a shipped
 * app. A packaged build installs from a file the user picked by hand in the
 * main window (card K3), never from one an environment variable names.
 */
export function pluginDeveloperModeEnabled(
  env: Record<string, string | undefined>,
  isPackaged: boolean,
): boolean {
  return !isPackaged && env['AGENT_TEAM_PLUGIN_DEV'] === '1'
}
