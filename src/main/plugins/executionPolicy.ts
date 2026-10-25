import {
  EXECUTION_POLICY_SCHEMA_VERSION,
  V2_SYSTEM_NAMESPACES,
  type ExecutionPolicy,
} from '../../../packages/plugin-contracts/src/index'
import { HOST_SHELL_EXECUTABLE_ALLOWLIST } from './pluginCapabilityCatalog'

export type ExecutionPolicySnapshotState = 'default' | 'user' | 'corrupt'

export interface ExecutionPolicySnapshot {
  policy: ExecutionPolicy
  revision: number
  state: ExecutionPolicySnapshotState
}

export const HOST_DEFAULT_EXECUTION_POLICY: ExecutionPolicy = {
  schemaVersion: EXECUTION_POLICY_SCHEMA_VERSION,
  mode: 'allowlist',
  // Message text reaches an agent only when the user names it in a policy, so
  // the default allowlist leaves it out.
  system: V2_SYSTEM_NAMESPACES.filter((namespace) => namespace !== 'agentMessages'),
  shell: [...HOST_SHELL_EXECUTABLE_ALLOWLIST],
}

export const FAIL_CLOSED_EXECUTION_POLICY: ExecutionPolicy = {
  schemaVersion: EXECUTION_POLICY_SCHEMA_VERSION,
  mode: 'allowlist',
  system: [],
  shell: [],
}

export function cloneExecutionPolicy(policy: ExecutionPolicy): ExecutionPolicy {
  return {
    schemaVersion: policy.schemaVersion,
    mode: policy.mode,
    system: [...policy.system],
    shell: [...policy.shell],
  }
}
