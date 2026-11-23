// Pure editing of the receiver-side pane policy — "who, on another device, may
// drive a pane on this machine". The backend enforces the same document
// (backend/agent_team_backend/pane_policy.py); this half only composes it.
//
// Two properties of the format drive everything here:
//   * it is **deny by default with allow-only rules**, so an empty document is
//     not "unconfigured", it is "refuse everything";
//   * every field is two-state — an exact value or `*` — never a pattern, so a
//     rule is something a person can verify by reading it.
//
// The server stores the document verbatim and never merges, so an edit is
// always "read the whole thing, change it, write the whole thing back".

export const POLICY_VERSION = 1
/** Matches a whole field. Never a prefix: `deploy-*` is a literal pane name. */
export const ANY = '*'

export interface PolicyRule {
  from: { memberId: string; deviceId: string }
  to: { workspace: string; paneName: string }
  action: 'allow'
  /** Set on a rule written for another organization's machine: it applies
   *  only through that grant, and must survive every rewrite of the document
   *  or the rule would outlive the grant (backend pane_policy.for_grant). */
  grantId?: string
  /** When a grant-tagged rule was allowed; kept through rewrites like grantId. */
  grantedAt?: number
}

export interface PolicyDocument {
  version: number
  default: 'deny' | 'allow'
  rules: PolicyRule[]
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function readRule(raw: unknown): PolicyRule | null {
  if (!raw || typeof raw !== 'object') return null
  const rule = raw as Record<string, unknown>
  if (rule.action !== 'allow') return null
  const from = (rule.from ?? {}) as Record<string, unknown>
  const to = (rule.to ?? {}) as Record<string, unknown>
  const memberId = text(from.memberId)
  const deviceId = text(from.deviceId)
  const workspace = text(to.workspace)
  const paneName = text(to.paneName)
  if (!memberId || !deviceId || !workspace || !paneName) return null
  const grantId = text(rule.grantId)
  const grantedAt = typeof rule.grantedAt === 'number' && Number.isFinite(rule.grantedAt) ? rule.grantedAt : undefined
  return {
    from: { memberId, deviceId },
    to: { workspace, paneName },
    action: 'allow',
    ...(grantId ? { grantId } : {}),
    ...(grantId && grantedAt !== undefined ? { grantedAt } : {}),
  }
}

/**
 * Normalize whatever the server handed back into an editable document.
 *
 * Drops rules this build cannot render rather than showing a half-read row:
 * the editor writes back what it displays, so a rule it could not display
 * would be silently dropped by the save anyway — better it never appears as
 * something the user believes is in force. A document of another version is
 * *not* rewritten to this one for the same reason the backend fails closed on
 * it: its unread fields may be constraints, and reissuing it at this version
 * would widen the grant it meant to narrow.
 */
export function readPolicy(raw: unknown): PolicyDocument {
  const empty: PolicyDocument = { version: POLICY_VERSION, default: 'deny', rules: [] }
  if (!raw || typeof raw !== 'object') return empty
  const doc = raw as Record<string, unknown>
  if (doc.version !== POLICY_VERSION) return empty
  const rules = Array.isArray(doc.rules)
    ? doc.rules.map(readRule).filter((rule): rule is PolicyRule => rule !== null)
    : []
  return { version: POLICY_VERSION, default: doc.default === 'allow' ? 'allow' : 'deny', rules }
}

/** Blank means "any": the editor's text boxes are optional, and an omitted
 *  field is the widest thing the field can say, not an invalid rule. */
export function makeRule(input: {
  memberId?: string
  deviceId?: string
  workspace?: string
  paneName?: string
}): PolicyRule {
  return {
    from: {
      memberId: text(input.memberId) || ANY,
      deviceId: text(input.deviceId) || ANY
    },
    to: {
      workspace: text(input.workspace) || ANY,
      paneName: text(input.paneName) || ANY
    },
    action: 'allow'
  }
}

/**
 * Whether a rule can also let a machine paired through an organization in.
 *
 * Shown, not restricted: such a rule is the user's own, and the format denies
 * by default. A rule tagged with a grant is that organization pairing's own;
 * one naming this account's member is not reachable by an organization
 * machine (it is judged by the member its grant named). Everything else —
 * a wildcard member, or another account's member — may be.
 */
export function mayApplyToOrgMachines(rule: PolicyRule, ownMemberId: string): boolean {
  if (rule.grantId) return false
  return rule.from.memberId === ANY || rule.from.memberId !== text(ownMemberId)
}

export function sameRule(a: PolicyRule, b: PolicyRule): boolean {
  return (
    a.from.memberId === b.from.memberId &&
    a.from.deviceId === b.from.deviceId &&
    a.to.workspace === b.to.workspace &&
    a.to.paneName === b.to.paneName &&
    (a.grantId ?? '') === (b.grantId ?? '')
  )
}

/**
 * The one rule behind the "allow my own other devices" switch: this member,
 * any device of theirs, any pane here.
 *
 * Written with the member id rather than by listing device ids because that is
 * what "my devices" means over time — a laptop bought next week is covered
 * without editing anything, and a device signed out of the account stops being
 * covered the moment it is.
 */
export function ownDevicesRule(memberId: string): PolicyRule {
  return makeRule({ memberId, deviceId: ANY, workspace: ANY, paneName: ANY })
}

export function allowsOwnDevices(doc: PolicyDocument, memberId: string): boolean {
  if (!text(memberId)) return false
  const wanted = ownDevicesRule(memberId)
  return doc.rules.some((rule) => sameRule(rule, wanted))
}

/** Toggle the switch above. Turning it off removes only that exact rule — a
 *  narrower rule the user wrote by hand is theirs, not ours to revoke. */
export function withOwnDevices(
  doc: PolicyDocument,
  memberId: string,
  enabled: boolean
): PolicyDocument {
  if (!text(memberId)) return doc
  const wanted = ownDevicesRule(memberId)
  if (enabled) return addRule(doc, wanted)
  return { ...doc, rules: doc.rules.filter((rule) => !sameRule(rule, wanted)) }
}

/** Append unless an identical rule is already there — duplicates grant nothing
 *  and only make the list harder to audit. */
export function addRule(doc: PolicyDocument, rule: PolicyRule): PolicyDocument {
  if (doc.rules.some((existing) => sameRule(existing, rule))) return doc
  return { ...doc, rules: [...doc.rules, rule] }
}

export function removeRuleAt(doc: PolicyDocument, index: number): PolicyDocument {
  if (index < 0 || index >= doc.rules.length) return doc
  return { ...doc, rules: doc.rules.filter((_, position) => position !== index) }
}
