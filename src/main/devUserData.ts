import { isAbsolute } from 'node:path'

/**
 * Where a dev (unpackaged) instance keeps its Electron userData — renderer
 * localStorage, the open-windows registry, plugin storage.
 *
 * By default beside the packaged app's, with a `-dev` suffix (or
 * `-dev-plans-<profile>` for a Plans dev profile), so the two never share it.
 * NAVIDE_DEV_USER_DATA_DIR, an absolute path, replaces it outright: pointed at
 * an empty directory (with AGENT_TEAM_DATA_DIR on another), it is how a dev
 * run looks like a first install. Electron's own --user-data-dir switch does
 * not get through `pnpm dev`, which is why this exists. A relative value is
 * ignored and reported back as `ignored`.
 */
export function devUserDataPath(
  base: string,
  env: Record<string, string | undefined>,
  plansDevProfile: string | null,
): { path: string; ignored: string | null } {
  const explicit = env['NAVIDE_DEV_USER_DATA_DIR']
  if (explicit && isAbsolute(explicit)) return { path: explicit, ignored: null }
  return {
    path: `${base}${plansDevProfile ? `-dev-plans-${plansDevProfile}` : '-dev'}`,
    ignored: explicit ? explicit : null,
  }
}
