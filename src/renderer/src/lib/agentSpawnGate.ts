// Gate logic for agent-initiated pane spawns (SPAWN blocks). Pure functions —
// App.vue supplies the runtime context; unit tests inject fakes. Failure
// reasons and advisories are agent-facing text (delivered back to the
// requesting pane), so they follow the protocol language in data/stages.ts.
//
// This gate only rejects on correctness (unknown agent, bad/taken name, empty
// task, a model/effort the vendor cannot be told) — it never rejects on volume. Child/workspace/depth counts above the
// advisory thresholds below still succeed; the caller just gets an
// `advisories` note back to relay or log.

import { modelArgsFor, type AgentKey, type CliModelCapability, type CliModelRefusal } from '@navide/plugin-shell'
import { normalizeMessagingName, type ParsedSpawnRequest } from './agentMessaging'

/** Advisory threshold for live child panes one pane has spawned — crossing it
 *  does not block the spawn, it just adds a note to the result. */
export const SPAWN_ADVISORY_CHILDREN_PER_PARENT = 3
/** Advisory threshold for AI CLI panes (terminal excluded) across the whole
 *  workspace — crossing it does not block the spawn, it just adds a note. */
export const SPAWN_ADVISORY_CLI_PANES = 8
/** Advisory threshold for spawn-chain depth: user-opened pane = 0, its spawns
 *  = 1, theirs = 2. Crossing it does not block the spawn, it just adds a note
 *  about how hard the chain will be to trace. */
export const SPAWN_ADVISORY_DEPTH = 2

export interface SpawnGateContext {
  /** Allowed agent keys (agentSpecs minus the plain-shell terminal). */
  validAgentKeys: readonly string[]
  /** True when the messaging name is already registered to a pane. */
  isNameTaken: (name: string) => boolean
  /** Spawn-chain depth of the requesting pane (user-opened = 0). */
  parentDepth: number
  /** Live child panes already spawned by the requesting pane. */
  parentChildCount: number
  /** Live AI CLI panes (terminal excluded) across the workspace. */
  cliPaneCount: number
  /** The model/effort capability of one agent key, from the renderer's own
   *  AgentSpec — the spec that actually assembles argv. The backend refuses an
   *  unsupported model too, but its capability table is a mirror; this is the
   *  authoritative check, so a drift between the two cannot launch a pane on
   *  the wrong model. Undefined for an unknown key. */
  modelCapabilityFor: (agentKey: string) => CliModelCapability | undefined
  /** True when a fresh pane of this agent launches on the user's stored
   *  launch command (Settings → CLI Agents). That line is used verbatim, so a
   *  model or effort could not reach argv. */
  launchCommandOverridden: (agentKey: string) => boolean
}

/** An accepted request. `model` / `effort` are present only when the caller
 *  asked for them, so a request that named neither yields exactly the object
 *  this gate returned before they existed. */
export interface SpawnGateOk {
  ok: true
  agentKey: string
  name: string
  task: string
  model?: string
  effort?: string
  advisories?: string[]
}

export type SpawnGateResult = SpawnGateOk | { ok: false; reason: string }

/** The advisory notes for one spawn's volume context (chain depth, children
 *  per parent, workspace CLI panes) — never a rejection, just what would be
 *  reported back on a successful spawn. Pulled out of evaluateSpawnRequest so
 *  a caller that bypasses the gate (e.g. ui.pane.create) can still surface
 *  the same notes. */
export function spawnAdvisoriesFor(
  ctx: Pick<SpawnGateContext, 'parentDepth' | 'parentChildCount' | 'cliPaneCount'>,
): string[] {
  const advisories: string[] = []
  if (ctx.parentDepth >= SPAWN_ADVISORY_DEPTH) {
    advisories.push(
      `spawn 鏈深度即將達到 ${ctx.parentDepth + 1}（建議值 ${SPAWN_ADVISORY_DEPTH}）：鏈太深時，` +
        `孫代 pane 的產出很難回溯到最初的請求者，追蹤與除錯會變困難`,
    )
  }
  if (ctx.parentChildCount >= SPAWN_ADVISORY_CHILDREN_PER_PARENT) {
    advisories.push(
      `此 pane 即將啟動第 ${ctx.parentChildCount + 1} 個子 pane（建議值 ${SPAWN_ADVISORY_CHILDREN_PER_PARENT}）`,
    )
  }
  if (ctx.cliPaneCount >= SPAWN_ADVISORY_CLI_PANES) {
    advisories.push(
      `此工作區已有 ${ctx.cliPaneCount} 個 CLI pane（建議值 ${SPAWN_ADVISORY_CLI_PANES}）；` +
        `每個約佔用 250–500MB 記憶體，數量偏多時請留意系統負載`,
    )
  }
  return advisories
}

/** Turn a {@link modelArgsFor} refusal into agent-facing text (protocol
 *  language, see the header). Says what this vendor DOES accept, not just what
 *  it rejected — a caller told only "not supported" retries with the same
 *  shape. Surfaces a user reads take {@link modelRefusalMessage} instead. */
export function describeModelRefusal(
  agentKey: string,
  refusal: Exclude<ReturnType<typeof modelArgsFor>, { ok: true }>['refusal'],
  effort: string,
): string {
  if (refusal.kind === 'model-unsupported') {
    return (
      `「${agentKey}」無法在啟動時指定模型，這樣開會落回它的預設模型 — ` +
      `請拿掉 model 參數，改在 CLI 裡自己切換模型`
    )
  }
  if (refusal.kind === 'effort-unsupported') {
    return (
      `「${agentKey}」沒有獨立的 effort 參數 — 請拿掉 effort；` +
      `若這家 CLI 是把強度寫在模型 id 裡（例如 gpt-5.3-codex-high），請改寫進 model`
    )
  }
  if (refusal.kind === 'model-malformed') {
    return (
      `model 只能是單一的模型 id — 不可含空白，也不可用「-」開頭。` +
      `帶空白的值會被拆成兩個參數，等於多塞了一個旗標給 CLI`
    )
  }
  if (refusal.kind === 'effort-malformed') {
    return `effort 只能是單一個字 — 不可含空白，也不可用「-」開頭`
  }
  return (
    `「${agentKey}」的 effort 只接受：${refusal.accepted.join('、')}，` +
    `收到的是「${effort}」`
  )
}

const MODEL_REFUSAL_I18N_KEY: Record<CliModelRefusal['kind'], string> = {
  'model-unsupported': 'spawn.model.refuse.model-unsupported',
  'effort-unsupported': 'spawn.model.refuse.effort-unsupported',
  'model-malformed': 'spawn.model.refuse.model-malformed',
  'effort-malformed': 'spawn.model.refuse.effort-malformed',
  'effort-invalid': 'spawn.model.refuse.effort-invalid',
}

/** The same refusal as an i18n message descriptor, for the surfaces a user
 *  reads (spawn dialog, Settings → CLI Agents). This module has no i18n
 *  access, so the caller resolves it with its own `t(key, params)`. Kept next
 *  to {@link describeModelRefusal} so the two wordings drift together, not
 *  apart. */
export function modelRefusalMessage(
  agentKey: string,
  refusal: CliModelRefusal,
  effort: string,
): { key: string; params: Record<string, string> } {
  const params: Record<string, string> = { agent: agentKey, effort }
  if (refusal.kind === 'effort-invalid') params.accepted = refusal.accepted.join(', ')
  return { key: MODEL_REFUSAL_I18N_KEY[refusal.kind], params }
}

/** The same agent-key whitelist check evaluateSpawnRequest does, pulled out
 *  so a caller that bypasses the rest of the gate (ui.pane.create) can still
 *  refuse a key with no runtime representation before
 *  it reaches spawnPane, instead of relying on a `as AgentKey` cast that does
 *  nothing at runtime. Throws instead of returning a result because the only
 *  caller already throws for its other validation failures. */
export function assertAgentKeyAllowed(
  agent: unknown,
  validAgentKeys: readonly string[],
): AgentKey | 'terminal' {
  if (typeof agent !== 'string' || !validAgentKeys.includes(agent)) {
    throw new Error(`agent 欄位缺少或不合法：「${String(agent)}」不是可用的 agent key`)
  }
  return agent as AgentKey | 'terminal'
}

/** Validate one spawn request against the whitelist, naming rules and
 *  correctness checks — the only things that reject. Volume (children per
 *  parent, workspace CLI panes, chain depth) never rejects; past its advisory
 *  threshold it's reported back in `advisories` on the success result. */
export function evaluateSpawnRequest(
  req: ParsedSpawnRequest,
  ctx: SpawnGateContext,
): SpawnGateResult {
  if (!req.agent || !ctx.validAgentKeys.includes(req.agent)) {
    return { ok: false, reason: `agent 欄位缺少或不合法：「${req.agent}」不是可用的 agent key` }
  }
  const name = req.name ? normalizeMessagingName(req.name) : null
  if (!name) return { ok: false, reason: 'name 欄位缺少或不合法' }
  // "/" separates <folder>/<pane> in an address: a name holding one would read
  // as a pane of another project (review #546).
  if (name.includes('/')) {
    return { ok: false, reason: `名稱「${name}」含有「/」，它是位址中資料夾與 pane 的分隔符，請換一個名稱` }
  }
  if (ctx.isNameTaken(name)) {
    return { ok: false, reason: `名稱「${name}」已被其他 pane 使用，請換一個名稱` }
  }
  // A fresh pane with nothing to do is a mistake. A RESUMED one is not — the
  // conversation already has its context, and the caller may only want it
  // back on screen, talking to it later with cli_send. Nor is a terminal: its
  // task is an optional first command, and a bare shell prompt is a pane.
  if (!req.task && !req.resumesSession && req.agent !== 'terminal') {
    return { ok: false, reason: 'task 欄位不可為空' }
  }

  const model = (req.model ?? '').trim()
  const effort = (req.effort ?? '').trim()
  const chosen = modelArgsFor({
    spec: ctx.modelCapabilityFor(req.agent),
    request: { model, effort },
  })
  if (!chosen.ok) return { ok: false, reason: describeModelRefusal(req.agent, chosen.refusal, effort) }
  // Refused, not dropped: the caller named a model, and a pane that opens on
  // the vendor default looks exactly like one that got it. A resume is exempt —
  // its command is rebuilt from the vendor's own syntax, model included, and
  // never reads the stored launch command.
  if ((model || effort) && !req.resumesSession && ctx.launchCommandOverridden(req.agent)) {
    return {
      ok: false,
      reason:
        `「${req.agent}」設了自訂啟動指令（設定 → CLI Agents），整條命令照原樣執行，` +
        `Navide 不會再加上 model / effort — 請拿掉這兩個參數，或先清空該啟動指令`,
    }
  }

  const advisories = spawnAdvisoriesFor(ctx)

  const result: SpawnGateOk = { ok: true, agentKey: req.agent, name, task: req.task }
  if (model) result.model = model
  if (effort) result.effort = effort
  if (advisories.length > 0) result.advisories = advisories
  return result
}

/** Evaluate every SPAWN block in a turn — no longer just the first. Each
 *  request is checked against the running counts: a successful request bumps
 *  `parentChildCount` and `cliPaneCount` for the next one in the same turn
 *  (depth is unchanged — every spawn in a turn is the same parent's direct
 *  child), so opening five panes in one turn sees its advisories cross
 *  threshold partway through, not stay pinned at the turn's starting counts.
 *  A rejected request does not bump anything — it never spawns.
 *
 *  Names claimed earlier in the same turn count as taken. `isNameTaken` only
 *  knows about panes that already exist, so without this two blocks asking for
 *  the same name would both pass and the second would be quietly renamed with
 *  a suffix downstream — a clear rejection is more useful than a silent
 *  rename. Only reachable since a turn stopped being limited to one spawn. */
export function evaluateTurnSpawns(
  requests: ParsedSpawnRequest[],
  ctx: SpawnGateContext,
): SpawnGateResult[] {
  let parentChildCount = ctx.parentChildCount
  let cliPaneCount = ctx.cliPaneCount
  const claimedThisTurn = new Set<string>()
  return requests.map((req) => {
    const result = evaluateSpawnRequest(req, {
      ...ctx,
      parentChildCount,
      cliPaneCount,
      isNameTaken: (name) => claimedThisTurn.has(name) || ctx.isNameTaken(name),
    })
    if (result.ok) {
      parentChildCount++
      cliPaneCount++
      claimedThisTurn.add(result.name)
    }
    return result
  })
}

/** Spawn-chain depth of a pane: number of `spawnedBy` links walkable from it.
 *  Cycle-guarded. A missing ancestor ends the walk — spawnedBy is runtime-only
 *  (not persisted), so after an app restart every pane counts as root again;
 *  accepted MVP behaviour. */
export function computeSpawnDepth(
  paneId: string,
  parentOf: (id: string) => string | null | undefined,
): number {
  let depth = 0
  const seen = new Set<string>([paneId])
  let cur = parentOf(paneId)
  while (cur && !seen.has(cur)) {
    depth++
    seen.add(cur)
    cur = parentOf(cur)
  }
  return depth
}
