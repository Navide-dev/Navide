// The renderer's view of the Navide Marketplace developer (plan
// mcp-navide-0-2-27, W3): states and Registry answers, never a token or key.
import type { ManifestDisclosure } from './pluginDisclosure'

export interface DeveloperPublicState {
  registry: string
  signedIn: { account: boolean; publisher: boolean }
  namespace: string | null
  tokenExpiresAt: { account: string | null; publisher: string | null }
  keyFingerprint: string | null
  keyRegistered: boolean
}

/** A Registry call's outcome as the renderer sees it. */
export type DeveloperCallResult =
  | { ok: true; status: number; body: unknown }
  | { ok: false; status: number; code: string | null; message: string }

/** A package read once into the Host for publishing. */
export interface StagedPackage {
  stageId: string
  path: string
  fileName: string
  id: string
  version: string
  publisher: string
  digest: string
  size: number
  /** The platform target to publish under: the build host's for a package with a native backend. */
  defaultTarget: string
  hasBackend: boolean
  disclosure: ManifestDisclosure | null
}

/** One row of the developer's own versions (the Registry's names). */
export interface DeveloperVersionRow {
  namespace: string | null
  name: string | null
  version: string | null
  channel: string | null
  targets: string[]
  status: 'pending' | 'approved' | 'rejected' | null
  yanked: boolean
  reason: string | null
  submitted_at: string | null
  reviewed_at: string | null
}

export type DeveloperApplicationStatus = 'none' | 'pending' | 'approved' | 'rejected' | 'revoked'

export interface DeveloperApi {
  state(): Promise<DeveloperPublicState>
  signIn(scope: 'account' | 'publish'): Promise<DeveloperPublicState>
  signOut(): Promise<DeveloperPublicState>
  registerKey(): Promise<DeveloperPublicState>
  application(): Promise<DeveloperCallResult>
  submitApplication(input: {
    fields: Record<string, string | boolean>
    fieldSources: Record<string, 'user' | 'agent-draft'>
  }): Promise<DeveloperCallResult>
  versions(): Promise<DeveloperCallResult>
  /** `path` from a form (an agent's draft or a link); without it the Host opens a file dialog. */
  stagePackage(path?: string): Promise<StagedPackage | null>
  publish(input: { stageId: string; target: string }): Promise<DeveloperCallResult & { digest?: string }>
  yank(input: { namespace: string; name: string; version: string }): Promise<DeveloperCallResult>
}
