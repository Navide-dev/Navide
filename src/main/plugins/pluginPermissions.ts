import type {
  PluginManifestV2Permissions,
  PluginShellMode,
  PluginSystemNamespace,
} from './pluginManifestV2'

export type PluginPermissionGrant =
  | { permission: 'system'; namespace: PluginSystemNamespace }
  | { permission: 'shell'; mode: PluginShellMode; executables?: readonly string[] }

export type PluginCapabilityPolicy =
  | { kind: 'legacy'; requires: readonly string[] }
  | {
      kind: 'manifest-v2'
      system: readonly PluginSystemNamespace[]
      shell?: PluginShellMode
      /** C2: executables a `shell: "allowlist"` package declares beyond the
       *  Host's `git`, `gh`, `glab`; the broker admits exactly these too. */
      shellExecutables?: readonly string[]
      // Reserved for B1 adapter composition; authorization currently reads
      // normalized system and shell fields directly.
      grants: readonly PluginPermissionGrant[]
    }

export type ManifestV2CapabilityPolicy = Extract<
  PluginCapabilityPolicy,
  { kind: 'manifest-v2' }
>

export function legacyCapabilityPolicy(requires: readonly string[]): PluginCapabilityPolicy {
  return { kind: 'legacy', requires: [...requires] }
}

export function manifestV2CapabilityPolicy(
  permissions: PluginManifestV2Permissions
): ManifestV2CapabilityPolicy {
  const grants: PluginPermissionGrant[] = []
  for (const namespace of permissions.system ?? []) {
    grants.push({ permission: 'system', namespace })
  }
  if (permissions.shell) {
    grants.push({
      permission: 'shell',
      mode: permissions.shell,
      ...(permissions.shellExecutables ? { executables: [...permissions.shellExecutables] } : {}),
    })
  }
  return {
    kind: 'manifest-v2',
    system: [...(permissions.system ?? [])],
    ...(permissions.shell ? { shell: permissions.shell } : {}),
    ...(permissions.shell === 'allowlist' && permissions.shellExecutables
      ? { shellExecutables: [...permissions.shellExecutables] }
      : {}),
    grants,
  }
}
