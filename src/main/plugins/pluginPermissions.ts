import type {
  PluginManifestV2Permissions,
  PluginShellMode,
  PluginSystemNamespace,
} from './pluginManifestV2'
import type { AgentsEventAddress } from '../../../packages/plugin-contracts/src/agents'

export type PluginPermissionGrant =
  | { permission: 'system'; namespace: PluginSystemNamespace }
  | { permission: 'shell'; mode: PluginShellMode; executables?: readonly string[] }

export type PluginCapabilityPolicy =
  | { kind: 'legacy'; requires: readonly string[] }
  | {
      kind: 'manifest-v2'
      system: readonly PluginSystemNamespace[]
      shell?: PluginShellMode
      /** `permissions.agents.events`: the Host events this package receives. */
      agentEvents?: readonly AgentsEventAddress[]
      /** `permissions.plugins`: the plugins whose contributes.api this one calls. */
      plugins?: readonly string[]
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
    ...(permissions.agents ? { agentEvents: [...permissions.agents.events] } : {}),
    ...(permissions.plugins ? { plugins: [...permissions.plugins] } : {}),
    ...(permissions.shell === 'allowlist' && permissions.shellExecutables
      ? { shellExecutables: [...permissions.shellExecutables] }
      : {}),
    grants,
  }
}
