import { createHash } from 'node:crypto'
import { editorTerminalResumeKey } from '../../shared/terminalStorageOwner'
import type { TerminalOwnerOrigin } from '../terminalStorageOwner'

export interface AiTerminalStorageIdentity {
  origin: TerminalOwnerOrigin
  resumeKey: string
}

/** Compatibility mapping is Host-owned. Every public contribution can use
 * terminal persistence; only the migrated editor retains its old owner/key.
 * With a packageVersion (third-party packages), each version has its own
 * identity, so a new version never resumes or clears an older one's session.
 * Without it the key is the one used before versions were added. */
export function aiTerminalStorageIdentity(binding: {
  pluginId: string
  contributionKey: string
  workspacePath: string
  packageVersion?: string
}): AiTerminalStorageIdentity {
  if (binding.pluginId === 'navide.mini-ide' && binding.contributionKey === 'navide.mini-ide.window') {
    return { origin: 'legacy-mini-ide', resumeKey: editorTerminalResumeKey(binding.workspacePath) }
  }
  const hash = createHash('sha256').update(JSON.stringify([
    binding.pluginId, binding.contributionKey, binding.workspacePath,
    ...(binding.packageVersion === undefined ? [] : [binding.packageVersion]),
  ])).digest('hex')
  return { origin: 'host', resumeKey: `plugin-${hash}-ai-terminal` }
}
