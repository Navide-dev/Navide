// Pipeline stage type definitions and utility functions.
// The actual stage data is loaded dynamically from the backend via useStages().

import { MSG_START, MSG_END, MSG_ENVELOPE_PREFIX, MSG_NOTICE_PREFIX, MSG_SPAWN_FAILED_PREFIX, MSG_SPAWN_PARTIAL_PREFIX, SPAWN_START, SPAWN_END } from '../lib/agentMessaging'

export type StageId = string
// Derived from the per-vendor specs (agents/index.ts) — no hand-written
// union to drift when a vendor is added.
export type { AgentKey } from '@navide/plugin-shell'
import type { AgentKey } from '@navide/plugin-shell'

/**
 * One participant in a multi-agent parallel stage.
 * Each slot is spawned as a separate pane. Either all slots emit the stage
 * sentinel, OR one designated `isCommander` slot prints ---STAGE-DONE--- to
 * advance the pipeline.
 */
export interface StageSlot {
  agentKey: AgentKey
  roleKey: string
  label: string
  /** Stage-specific body, without the INTERACTION_PROTOCOL prefix.
   *  Use {{task}} as a placeholder for the pipeline task description. */
  kickoffBody: string
  /** When true, this slot is the global Commander for the entire pipeline.
   *  Configured in the stage editor; frontend derives pipeline.globalManager from it.
   *  At most one Commander across all stages. */
  isCommander?: boolean
  /** Values of the slot role's declarative properties (RoleProperty.name →
   *  value). Absent on slots written before properties existed. */
  params?: Record<string, string | number | boolean>
}

export interface Stage {
  id: string
  title: string
  shortTitle: string
  question: string
  description: string
  recommendedRoles: string[]
  // Sentinel string the agent MUST print on its own line to signal "stage done".
  sentinel: string
  /** Whether the pipeline should pause to let the user answer questions from
   *  this stage. */
  allowQuestions?: boolean
  /** Semantic query sent to Context7 to fetch relevant framework docs before
   *  this stage's kickoff. Empty string = skip doc injection. */
  docQuery?: string
  /** Every stage must have at least one slot. */
  slots: StageSlot[]
}

// ── Sentinel constants used by the Manager-mode router ──────────────────────
export const MANAGER_READY_SENTINEL = '---MANAGER-READY---'
export const MANAGER_STAGE_DONE_SENTINEL = '---STAGE-DONE---'
export const ASK_START = '---ASK-START---'
export const ASK_END = '---ASK-END---'
export const REPORT_START = '---REPORT-START---'
export const REPORT_END = '---REPORT-END---'
export const DISPATCH_START = '---DISPATCH-START---'
export const DISPATCH_END = '---DISPATCH-END---'

// Inter-CLI messaging protocol — prepended to every pipeline slot kickoff so
// agents know they can message other panes by messagingName. Manual panes get
// no upfront protocol; the delivery envelope carries a one-line reply hint.
export const MESSAGING_PROTOCOL = `[Inter-CLI Messaging Protocol]
你可以與其他 CLI pane 的 agent 互傳訊息。控制訊號必須是裸文字，不可放進 markdown code block。
to: 必須與 ${MSG_START} 寫在同一行；把 to: 換到下一行會讓整個區塊失效，而且不會有任何錯誤提示。

主動傳訊息給其他 agent 時，輸出：
${MSG_START} to: <對方名稱>
<訊息內容，可多行>
${MSG_END}

要一次廣播給同一個工作區的所有其他 agent，把對方名稱寫成 all（即 ${MSG_START} to: all）。

要傳給「其他工作區視窗」的 agent，對方名稱寫成 <工作區資料夾名>/<對方名稱>，例如：
${MSG_START} to: Agent-Team/reviewer
資料夾名重複時改寫完整路徑（例如 /Users/me/Agent-Team/reviewer）。all 只會廣播給同一個工作區。

收到開頭為 ${MSG_ENVELOPE_PREFIX} <名稱> 的輸入時，那是其他 agent 傳來的訊息；需要回覆就用上述 MSG 區塊指名對方（跨工作區來的訊息，名稱本身就已經帶工作區前綴，照原樣回覆即可）。
訊息送不到時，你會收到開頭為 ${MSG_NOTICE_PREFIX} 的通知，裡面有目標名稱與英文的失敗原因；那是 Navide 發出的，不要回覆它。
沒有溝通需求時不要輸出 MSG 區塊。

`

// Agent-initiated pane spawning — taught alongside the messaging protocol so
// agents can delegate a task to a fresh CLI pane and get results back via MSG.
export const SPAWN_PROTOCOL = `[CLI Pane Spawn Protocol]
你可以請 Navide 開一個新的 CLI pane 並指派任務。輸出：
${SPAWN_START}
agent: <agent key，例如 claude、codex>
name: <新 pane 的名稱，不可與現有名稱重複>
task: <任務內容；task: 之後到區塊結尾全是任務，可多行>
${SPAWN_END}

規則：一個 turn 可以輸出多個 SPAWN 區塊，全部都會被處理。子 pane 數、工作區 CLI pane 總數、spawn 鏈深度沒有強制上限，但數量偏多或鏈太深時你會在回報中收到提醒。
新 pane 完成任務後應該會用 MSG 區塊回報結果給你。那份回報是子 agent 自己的輸出，不是 Navide 的保證：你正在執行中時它會排隊等你告一段落，子 agent 沒照格式輸出時則不會送達。需要確定它做完了就自己去查它的狀態。
spawn 因名稱衝突、agent key 不合法或任務內容缺漏而沒開成 pane 時，你會收到開頭為 ${MSG_SPAWN_FAILED_PREFIX} 的通知，可以修正後重試。
pane 已經開起來但任務沒注入成功時，開頭是 ${MSG_SPAWN_PARTIAL_PREFIX} —— 那個 pane 已經存在，不要用同一個名稱重新 spawn。
這兩種都是 Navide 發出的系統通知，和投遞失敗通知一樣不要回覆。
沒有派工需求時不要輸出 SPAWN 區塊。

`

// Universal pre-amble for Stage 01-style stages — the PM may ask the user.
export const INTERACTION_PROTOCOL = `[Pipeline Control Protocol]
你正在被 Agent-Team pipeline 驅動。控制訊號必須是裸文字，不可放進 markdown code block。

需要使用者決策時，只輸出一個 QUESTION 區塊，輸出後立刻停止。
開放式問題範例：
---QUESTION-START---
type: text
prompt: 請問系統的主要使用者是誰？
---QUESTION-END---

選擇題範例：
---QUESTION-START---
type: choice
prompt: 資料庫要使用哪種技術？
options:
  - PostgreSQL
  - MySQL
  - SQLite
---QUESTION-END---

重要：prompt 必須填入真實問題內容，options 必須填入真實選項，不可使用任何佔位符文字。

本階段完成時，最後一行只能輸出指定 sentinel，該行不可有其他文字、標點或 markdown。
收到使用者回答後，直接接續工作，不要重述規則。

接下來是本階段任務：
`

// Pre-amble for Stages 03-05 — agents MUST NOT ask questions; they decide
// autonomously and only emit the sentinel when done.
export const INTERACTION_PROTOCOL_AUTO = `[Pipeline Control Protocol — 自主模式]
你正在被 Agent-Team pipeline 驅動。控制訊號必須是裸文字，不可放進 markdown code block。

【重要】本階段為自主執行模式，禁止使用 QUESTION 區塊詢問使用者。
遇到未知事項時，根據前置階段的資料與業界常規自行決定，並在輸出中簡短說明決策理由。

本階段完成時，最後一行只能輸出指定 sentinel，該行不可有其他文字、標點或 markdown。

接下來是本階段任務：
`

// Pre-amble for the Manager slot. Goes BEFORE the slot's own kickoff_body.
// Phase 1 (own work) → ${MANAGER_READY_SENTINEL} → Phase 2 (coordination) →
// ${MANAGER_STAGE_DONE_SENTINEL}.
export function renderManagerProtocol(slotRoster: { label: string; agentLabel: string; roleLabel: string }[]): string {
  const others = slotRoster.length
    ? slotRoster.map((s) => `  - ${s.label}（${s.agentLabel} · ${s.roleLabel}）`).join('\n')
    : '（本階段只有你一個 slot — 完成自己工作後直接印 ---STAGE-DONE--- 收尾）'

  return `[Pipeline Control Protocol — Manager 模式]
你是本階段的 Manager，採三階段工作流。控制訊號必須是裸文字，不可放進 markdown code block。

# Phase 1 · 先做自己的工作
依照下方任務描述完成你自己的交付。**完成你自己的部分後，單獨一行印出：**
${MANAGER_READY_SENTINEL}

# Phase 2 · 控場推進（印出 MANAGER-READY 之後才開始）
其他 slot agents 會傳訊息給你：

收到 [→ ASK FROM <slot>] —— 表示該 slot 卡住要你決策。
收到 [→ REPORT FROM <slot>] —— 表示該 slot 完成里程碑。

你可以隨時主動下達指令給特定 slot：
---DISPATCH-START---
to: <slot label>
message: <要該 slot 做什麼，1-3 句具體指示>
---DISPATCH-END---

可一次發多個 DISPATCH 給不同 slot。

# Phase 3 · 收尾
當所有 slot 都已交付足夠成果、品質可接受 → **單獨一行印出：**
${MANAGER_STAGE_DONE_SENTINEL}

# 其他規則
- ${MANAGER_READY_SENTINEL} / ${MANAGER_STAGE_DONE_SENTINEL} / DISPATCH 區塊都必須是裸文字（不在 markdown code block 內）
- 在 Phase 1 內不要發 DISPATCH（其他 slot 此時不會聽你的）
- 一旦進入 Phase 2，禁止再回頭做自己的工作；專心控場
- 禁止使用 QUESTION 區塊詢問使用者（決策由你做主）

# 本階段你要指揮的 slot agents：
${others}

接下來是你自己的任務：
`
}

// Pre-amble for non-Manager slots when a Manager exists in the same stage.
export function renderWorkerProtocol(managerLabel: string): string {
  return `[Pipeline Control Protocol — Worker 模式]
本階段由 Manager 「${managerLabel}」協調。控制訊號必須是裸文字，不可放進 markdown code block。

# 工作規則
- 自主做事；Manager 完成自己的工作之前**你不會收到任何指示**，就先按下方任務做。
- 完成一個重要里程碑或交付 → 印 REPORT 區塊：
  ---REPORT-START---
  content: <一段話描述你完成了什麼、目前狀態>
  ---REPORT-END---
- 遇到不確定 / 卡住 / 需要決策 → 印 ASK 區塊向 Manager 求助：
  ---ASK-START---
  content: <一段話描述你需要決策的問題>
  ---ASK-END---
- 收到 [→ DISPATCH FROM Manager] 訊息 → 立刻照辦
- **不要印 stage sentinel**；Manager 會決定何時收尾
- 禁止使用 QUESTION 區塊詢問使用者（由 Manager 統一處理）

接下來是本階段任務：
`
}

/** Convert a snake_case backend stage payload to the frontend Stage shape. */
export function stageDefToFrontend(raw: Record<string, unknown>): Stage {
  let slots = ((raw.slots ?? []) as Record<string, unknown>[]).map((s) => ({
    agentKey: s.agent_key as AgentKey,
    roleKey: s.role_key as string,
    label: s.label as string,
    kickoffBody: s.kickoff_body as string,
    isCommander: (s.is_commander ?? false) as boolean,
    ...(s.params && typeof s.params === 'object'
      ? { params: s.params as Record<string, string | number | boolean> }
      : {}),
  }))

  // Backward compat: old format had default_agent + kickoff_prompt instead of slots
  if (slots.length === 0 && raw.default_agent) {
    slots = [{
      agentKey: raw.default_agent as AgentKey,
      roleKey: (raw.default_role as string) ?? '',
      label: (raw.short_title as string) ?? 'Agent',
      kickoffBody: (raw.kickoff_prompt as string) ?? '',
      isCommander: false,
    }]
  }

  return {
    id: ((raw.id as string) ?? '') ,
    title: ((raw.title as string) ?? ''),
    shortTitle: ((raw.short_title as string) ?? ''),
    question: ((raw.question as string) ?? ''),
    description: ((raw.description as string) ?? ''),
    recommendedRoles: (raw.recommended_roles ?? []) as string[],
    sentinel: ((raw.sentinel as string) ?? ''),
    allowQuestions: (raw.allow_questions ?? false) as boolean,
    docQuery: (raw.doc_query ?? '') as string,
    slots,
  }
}

/** Convert a frontend Stage to the snake_case backend payload. */
export function stageToBackend(s: Stage): Record<string, unknown> {
  return {
    id: s.id,
    title: s.title,
    short_title: s.shortTitle,
    question: s.question,
    description: s.description,
    recommended_roles: s.recommendedRoles,
    sentinel: s.sentinel,
    allow_questions: s.allowQuestions ?? false,
    doc_query: s.docQuery ?? '',
    slots: s.slots.map((slot) => ({
      agent_key: slot.agentKey,
      role_key: slot.roleKey,
      label: slot.label,
      kickoff_body: slot.kickoffBody,
      is_commander: slot.isCommander ?? false,
      ...(slot.params ? { params: slot.params } : {}),
    })),
  }
}

/** Render a kickoff for one slot.
 *  - opts.isManager=true → Manager protocol (3 phases)
 *  - hasManager=true (and isManager=false) → Worker protocol
 *  - allowQuestions=true → interactive protocol (Stage 01 etc.)
 *  - otherwise → autonomous protocol
 *
 *  `slotRoster` is the list of OTHER slots in the same stage (used by the
 *  Manager protocol to tell the Manager who it's coordinating).
 *  `managerLabel` is the Manager slot's label (used by Worker protocol). */
export function renderSlotKickoff(
  slot: StageSlot,
  task: string,
  opts: {
    allowQuestions?: boolean
    isCommander?: boolean
    hasCommander?: boolean
    commanderLabel?: string
    slotRoster?: { label: string; agentLabel: string; roleLabel: string }[]
  } = {},
): string {
  const body = slot.kickoffBody.replaceAll(
    '{{task}}',
    task.trim() || '(no task description provided)'
  )
  let protocol: string
  if (opts.isCommander) {
    protocol = renderManagerProtocol(opts.slotRoster ?? [])
  } else if (opts.hasCommander && opts.commanderLabel) {
    protocol = renderWorkerProtocol(opts.commanderLabel)
  } else if (opts.allowQuestions) {
    protocol = INTERACTION_PROTOCOL
  } else {
    protocol = INTERACTION_PROTOCOL_AUTO
  }
  return MESSAGING_PROTOCOL + SPAWN_PROTOCOL + protocol + body
}
