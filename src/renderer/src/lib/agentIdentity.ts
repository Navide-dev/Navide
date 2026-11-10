/**
 * Agent identity — what a long-lived agent pane (spec kind 'agent': Hermes,
 * OpenClaw) is known by, independent of the pane it currently runs in.
 *
 * Plan agent-0-2-40_78e071 decision 5: identity = the pane name + a colour +
 * the vendor it runs on, stored in Navide (ui settings). Closing the pane keeps
 * the identity; reopening attaches a new pane to it and resumes the session the
 * identity last ran when the vendor can resume.
 */
import { CLI_AGENT_SPECS } from '@navide/plugin-shell'

export const AGENT_COLORS = ['violet', 'teal', 'blue', 'orange', 'green', 'pink'] as const
export type AgentColor = (typeof AGENT_COLORS)[number]

/** Mid-tone hues readable as a 5px bar and as an avatar behind white text in
 *  both themes. Kept here rather than as theme tokens: they name an identity,
 *  not a role in the UI, so they must not change with the theme. */
export const AGENT_COLOR_HEX: Readonly<Record<AgentColor, string>> = {
  violet: '#7650dc',
  teal: '#0b8a9c',
  blue: '#3a66d6',
  orange: '#c45a1c',
  green: '#2f8a43',
  pink: '#b8367d',
}

export interface AgentIdentity {
  /** Stable for the identity's life, whatever it is renamed to. */
  id: string
  /** The pane name; renaming the pane renames the identity. */
  name: string
  color: AgentColor
  /** Vendor key ('hermes', 'openclaw'). */
  agentKey: string
  workspacePath: string
  /** The pane it runs in now; null while closed. */
  paneId: string | null
  /** The vendor session it last ran, for resume; null when none was seen. */
  sessionId: string | null
  /** Epoch ms the identity was created. */
  createdAt: number
}

/** True for a vendor whose panes are agent panes. */
export function isAgentVendor(agentKey: string | undefined | null): boolean {
  if (!agentKey) return false
  return CLI_AGENT_SPECS.some((spec) => spec.agentKey === agentKey && spec.kind === 'agent')
}

export function agentVendorLabel(agentKey: string): string {
  return CLI_AGENT_SPECS.find((spec) => spec.agentKey === agentKey)?.label ?? agentKey
}

/** The avatar letter: the identity's first character, else the vendor's. */
export function agentInitial(name: string, agentKey: string): string {
  const first = Array.from(name.trim())[0] ?? Array.from(agentVendorLabel(agentKey))[0] ?? '?'
  return first.toUpperCase()
}

/** The first colour no existing identity uses, cycling once all are taken. */
export function nextAgentColor(existing: readonly AgentIdentity[]): AgentColor {
  const used = new Set(existing.map((a) => a.color))
  return AGENT_COLORS.find((c) => !used.has(c)) ?? AGENT_COLORS[existing.length % AGENT_COLORS.length]
}

/** Parses the stored list, dropping malformed rows rather than failing the
 *  whole list: the value lives in a user-editable settings file. */
export function parseAgentIdentities(raw: unknown): AgentIdentity[] {
  if (!Array.isArray(raw)) return []
  const out: AgentIdentity[] = []
  for (const row of raw) {
    if (!row || typeof row !== 'object') continue
    const r = row as Record<string, unknown>
    if (typeof r.id !== 'string' || typeof r.agentKey !== 'string' || typeof r.name !== 'string') continue
    out.push({
      id: r.id,
      name: r.name,
      color: (AGENT_COLORS as readonly string[]).includes(r.color as string) ? (r.color as AgentColor) : 'violet',
      agentKey: r.agentKey,
      workspacePath: typeof r.workspacePath === 'string' ? r.workspacePath : '',
      paneId: typeof r.paneId === 'string' && r.paneId ? r.paneId : null,
      sessionId: typeof r.sessionId === 'string' && r.sessionId ? r.sessionId : null,
      createdAt: typeof r.createdAt === 'number' ? r.createdAt : 0,
    })
  }
  return out
}

/** What an agent pane's header is drawn from (TerminalPane `agent` prop). */
export interface AgentPaneInfo {
  name: string
  /** Hex colour of the identity's bar and avatar. */
  color: string
  initial: string
  /** Vendor label, e.g. "Hermes Agent". */
  vendor: string
  /** Model the pane was launched on; undefined = the vendor's default. */
  model?: string
  /** Epoch ms the identity was created (0 when unknown). */
  createdAt: number
}

/** One identity with its pane's state, for Settings → Agents and the ＋ menu. */
export interface AgentIdentitySummary {
  identity: AgentIdentity
  /** Its pane is open in this window. */
  open: boolean
  /** The open pane's status ('' when closed). */
  status: string
}
