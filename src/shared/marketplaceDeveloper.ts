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
  /** L1d: the Registry already holds a different key (its fingerprint), so
   *  this Navide's key was not registered; publishing from here needs the
   *  user's explicit replacement, while the other key keeps working. */
  keyConflictFingerprint: string | null
  /** 0.2.43 #2b: the Navide Cloud member these tokens came from through the
   *  Cloud sign-in (no browser); null after a browser sign-in or when signed out. */
  cloudMemberId: string | null
}

/** A Registry call's outcome as the renderer sees it. */
export type DeveloperCallResult =
  | { ok: true; status: number; body: unknown }
  | { ok: false; status: number; code: string | null; message: string; doc?: string | null }

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

/** Who may publish under the signed-in namespace (0.2.40: owner and publisher members). */
export interface DeveloperMembers {
  /** The signed-in account's role in the namespace. */
  your_role: 'owner' | 'publisher' | null
  items: Array<{ member_id: string; role: 'owner' | 'publisher'; added_at: string | null }>
}

export type DeveloperApplicationStatus = 'none' | 'pending' | 'approved' | 'rejected' | 'revoked'

export interface DeveloperApi {
  state(): Promise<DeveloperPublicState>
  signIn(scope: 'account' | 'publish'): Promise<DeveloperPublicState>
  /** 0.2.43 #2b: account-scope sign-in through the Navide Cloud account, no browser; unchanged state when unavailable. */
  syncCloudAccount(): Promise<DeveloperPublicState>
  signOut(): Promise<DeveloperPublicState>
  registerKey(options?: { replace?: boolean }): Promise<DeveloperPublicState>
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
  /** The namespace's members; `body` is DeveloperMembers. */
  members(): Promise<DeveloperCallResult>
  /** Owner only: add or remove a publisher member; `body` is the new DeveloperMembers. */
  addMember(input: { memberId: string }): Promise<DeveloperCallResult>
  removeMember(input: { memberId: string }): Promise<DeveloperCallResult>
}

/** The one entry page for Navide plugin authors (docs/en-US/build-for-navide.md). */
export const BUILD_FOR_NAVIDE_URL = 'https://github.com/Navide-dev/Navide/blob/main/docs/en-US/build-for-navide.md'
const DOCS_URL = 'https://github.com/Navide-dev/Navide/blob/main/docs/en-US'
/** The developer documents the Help menu's Developers submenu opens (b5). */
export const DEVELOPER_DOC_URLS = {
  'build-for-navide': BUILD_FOR_NAVIDE_URL,
  'plugin-development': `${DOCS_URL}/plugin-development.md`,
  'plugin-development-v2': `${DOCS_URL}/plugin-development-v2.md`,
  'marketplace-publishing': `${DOCS_URL}/marketplace-publishing.md`,
} as const
export type DeveloperDoc = keyof typeof DEVELOPER_DOC_URLS
/** The Navide pages the Developers submenu opens: Settings → Navide Marketplace → Developer, and its Testplace section. */
export type DeveloperPage = 'developer-settings' | 'testplace'
export type DeveloperMenuItem = 'title' | DeveloperDoc | DeveloperPage
/** What a CAPABILITY_DENIED refusal links to (docs/en-US/plugin-development-v2.md). */
export const CAPABILITY_DENIED_DOC_URL = `${DOCS_URL}/plugin-development-v2.md#capability_denied`

/** A Registry error's `doc` (c3) when it is a page of Navide's own documentation or site; null otherwise. */
export function trustedDocUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 512) return null
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || url.username || url.password) return null
  if (url.hostname === 'github.com' && url.pathname.startsWith('/Navide-dev/Navide/')) return url.toString()
  if (url.hostname === 'navide.dev' || url.hostname.endsWith('.navide.dev')) return url.toString()
  return null
}
/** The developer console's open page: the publishing steps, before signing in. */
export const DEVELOPERS_URL = 'https://developers.navide.dev/developer'
