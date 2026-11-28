// The window's view of the commanders (0.2.51): the list, each commander's
// dispatch tree with Navide's detected states, and the window-only mutations.
// The backend owns all of it (commander.* WS, lib/commander.ts); this mirrors
// it so the sidebar tab, the detail modal and the pane header chips read one
// copy.
//
// One shared store per renderer rather than provide/inject: the pane headers
// sit under App.vue, which this feature does not touch, and ControlPane — the
// one component mounted once per main window — binds the backend to it.
import { computed, ref, watch, type Ref } from 'vue'
import type { WsResponse } from '../../../shared/wsClient'
import type {
  CommanderEvents,
  CommanderFields,
  CommanderMessages,
  CommanderMessageType,
  CommanderState,
  CommanderSummary,
  CommanderTree,
  CommanderTreeNode,
} from '../lib/commander'

const RPC_TIMEOUT_MS = 15_000
/** Detected states change without an event (a pane goes quiet), so the trees
 *  are re-read on this interval while anything is listed. */
const TREE_POLL_MS = 30_000
/** commander.* answers FORBIDDEN until the window has proven itself (the
 *  ws.welcome challenge useBackend answers right after connecting), so a
 *  refresh sent on connect can land first. It is retried this many times. */
const FORBIDDEN_RETRIES = 6
const FORBIDDEN_RETRY_MS = 400

/** A refused commander.* call, with the backend's error code. */
class CommanderCallError extends Error {
  constructor(message: string, readonly code: string) {
    super(message)
  }
}

/** The slice of useBackend this store needs; tests pass a fake. */
export interface CommanderBackend {
  status: Ref<string>
  send<T = unknown>(type: string, payload?: Record<string, unknown>, timeoutMs?: number): Promise<WsResponse<T>>
  on(type: string, cb: (payload: unknown) => void): () => void
}

/** What a pane header or sidebar row shows for a pane a commander dispatched. */
export interface PaneCommanderMark {
  commanderId: string
  commanderName: string
  icon: string
  color: string
  state: CommanderState
}

export interface CommanderDetailData {
  commander: CommanderSummary
  memory: string
  tree: CommanderTree
}

type Request<K extends CommanderMessageType> = CommanderMessages[K]['request']
type Response<K extends CommanderMessageType> = CommanderMessages[K]['response']

/** Every dispatched node below the root, depth first. */
export function dispatchedNodes(tree: CommanderTree | null | undefined): CommanderTreeNode[] {
  const out: CommanderTreeNode[] = []
  const walk = (nodes: CommanderTreeNode[]): void => {
    for (const n of nodes) {
      out.push(n)
      walk(n.children)
    }
  }
  if (tree) walk(tree.root.children)
  return out
}

export function createCommanderStore() {
  const commanders = ref<CommanderSummary[]>([])
  const trees = ref<Record<string, CommanderTree>>({})
  const loaded = ref(false)
  const listError = ref('')
  const opError = ref('')
  const busy = ref(false)
  /** The commander whose detail modal is open; '' for none. */
  const detailId = ref('')
  /** The create dialog: open, and the pane it upgrades ('' = a new commander). */
  const createOpen = ref(false)
  const createPaneId = ref('')

  let backend: CommanderBackend | null = null
  let offs: (() => void)[] = []
  let poll: ReturnType<typeof setInterval> | null = null
  let stopStatusWatch: (() => void) | null = null
  let listSeq = 0
  let retryTimer: ReturnType<typeof setTimeout> | null = null

  async function call<K extends CommanderMessageType>(type: K, payload: Request<K>): Promise<Response<K> | null> {
    if (!backend) return null
    const resp = await backend.send<Response<K>>(type, payload as Record<string, unknown>, RPC_TIMEOUT_MS)
    if (!resp.ok || !resp.payload) throw new CommanderCallError(resp.error?.message || `${type} failed`, resp.error?.code ?? '')
    return resp.payload
  }

  async function loadTree(id: string): Promise<void> {
    try {
      const tree = await call('commander.tree', { id })
      if (tree) trees.value = { ...trees.value, [id]: tree }
    } catch {
      // A tree that fails to load keeps its last copy; the list still shows.
    }
  }

  async function refresh(attempt = 0): Promise<void> {
    if (!backend || backend.status.value !== 'connected') return
    if (retryTimer !== null) clearTimeout(retryTimer)
    retryTimer = null
    const seq = ++listSeq
    try {
      const answer = await call('commander.list', {})
      if (seq !== listSeq || !answer) return
      commanders.value = answer.commanders
      listError.value = ''
      loaded.value = true
      const live = new Set(answer.commanders.map((c) => c.id))
      trees.value = Object.fromEntries(Object.entries(trees.value).filter(([id]) => live.has(id)))
      await Promise.all(answer.commanders.map((c) => loadTree(c.id)))
    } catch (err) {
      if (seq !== listSeq) return
      if (err instanceof CommanderCallError && err.code === 'FORBIDDEN' && attempt < FORBIDDEN_RETRIES) {
        retryTimer = setTimeout(() => void refresh(attempt + 1), FORBIDDEN_RETRY_MS * (attempt + 1))
        return
      }
      listError.value = err instanceof Error ? err.message : String(err)
    }
  }

  function applyChanged(p: CommanderEvents['commander.changed']): void {
    if (!p || typeof p.id !== 'string') return
    const rest = commanders.value.filter((c) => c.id !== p.id)
    if (p.commander) {
      const at = commanders.value.findIndex((c) => c.id === p.id)
      const next = [...rest]
      next.splice(at < 0 ? next.length : at, 0, p.commander)
      commanders.value = next
      void loadTree(p.id)
    } else {
      commanders.value = rest
      const { [p.id]: _gone, ...keep } = trees.value
      trees.value = keep
      if (detailId.value === p.id) detailId.value = ''
    }
  }

  /** Attach the window's backend. Idempotent for the same backend. */
  function bind(next: CommanderBackend): void {
    if (backend === next) return
    unbind()
    backend = next
    offs = [
      next.on('commander.changed', (p) => applyChanged(p as CommanderEvents['commander.changed'])),
      next.on('commander.stall', (p) => {
        const id = (p as CommanderEvents['commander.stall'] | null)?.commander_id
        if (id) void loadTree(id)
      }),
    ]
    stopStatusWatch = watch(
      () => next.status.value,
      (status, previous) => {
        if (status === 'connected' && previous !== 'connected') void refresh()
      },
    )
    poll = setInterval(() => {
      if (!loaded.value) {
        void refresh()
        return
      }
      for (const c of commanders.value) void loadTree(c.id)
    }, TREE_POLL_MS)
    void refresh()
  }

  function unbind(): void {
    for (const off of offs) off()
    offs = []
    stopStatusWatch?.()
    stopStatusWatch = null
    if (poll !== null) clearInterval(poll)
    poll = null
    if (retryTimer !== null) clearTimeout(retryTimer)
    retryTimer = null
    backend = null
  }

  /** Pane id → the commander that dispatched it and its detected state. */
  const paneMarks = computed(() => {
    const out = new Map<string, PaneCommanderMark>()
    for (const c of commanders.value) {
      for (const node of dispatchedNodes(trees.value[c.id])) {
        if (!node.pane_id || node.closed_at) continue
        out.set(node.pane_id, { commanderId: c.id, commanderName: c.name, icon: c.icon, color: c.color, state: node.state })
      }
    }
    return out
  })

  /** Pane id → commander id, for the panes that are a commander's body now. */
  const bodyPanes = computed(() => {
    const out = new Map<string, string>()
    for (const c of commanders.value) if (c.body && !c.body.detached_at) out.set(c.body.pane_id, c.id)
    return out
  })

  const byId = (id: string): CommanderSummary | null => commanders.value.find((c) => c.id === id) ?? null

  async function mutate<K extends CommanderMessageType>(type: K, payload: Request<K>): Promise<Response<K> | null> {
    opError.value = ''
    busy.value = true
    try {
      return await call(type, payload)
    } catch (err) {
      opError.value = err instanceof Error ? err.message : String(err)
      return null
    } finally {
      busy.value = false
    }
  }

  /** The backend leaves no gap between answer and broadcast, but a window may
   *  not get its own broadcast; applying the answer keeps it current either way. */
  function applySummary(summary: CommanderSummary | undefined): void {
    if (summary) applyChanged({ id: summary.id, commander: summary })
  }

  async function create(fields: Request<'commander.create'>): Promise<CommanderSummary | null> {
    const answer = await mutate('commander.create', fields)
    applySummary(answer?.commander)
    return answer?.commander ?? null
  }

  async function upgradePane(paneId: string, fields: CommanderFields): Promise<CommanderSummary | null> {
    const answer = await mutate('commander.upgrade_pane', { ...fields, pane_id: paneId })
    applySummary(answer?.commander)
    return answer?.commander ?? null
  }

  async function update(id: string, changes: CommanderFields): Promise<CommanderSummary | null> {
    const answer = await mutate('commander.update', { id, changes })
    applySummary(answer?.commander)
    return answer?.commander ?? null
  }

  async function downgrade(id: string): Promise<boolean> {
    const answer = await mutate('commander.downgrade', { id })
    if (answer) applyChanged({ id, commander: null })
    return !!answer
  }

  async function archive(id: string): Promise<boolean> {
    const answer = await mutate('commander.archive', { id })
    if (answer) applyChanged({ id, commander: null })
    return !!answer
  }

  async function getDetail(id: string): Promise<CommanderDetailData | null> {
    try {
      const answer = await call('commander.get', { id })
      if (answer) trees.value = { ...trees.value, [id]: answer.tree }
      return answer
    } catch (err) {
      opError.value = err instanceof Error ? err.message : String(err)
      return null
    }
  }

  function openDetail(id: string): void {
    detailId.value = id
  }

  function openCreate(paneId = ''): void {
    opError.value = ''
    createPaneId.value = paneId
    createOpen.value = true
  }

  return {
    commanders, trees, loaded, listError, opError, busy, detailId, createOpen, createPaneId,
    paneMarks, bodyPanes, byId,
    bind, unbind, refresh, loadTree,
    create, upgradePane, update, downgrade, archive, getDetail, openDetail, openCreate,
  }
}

export type CommanderStore = ReturnType<typeof createCommanderStore>

let shared: CommanderStore | null = null

/** The renderer's one commander store. */
export function useCommanders(): CommanderStore {
  if (!shared) shared = createCommanderStore()
  return shared
}

/** Tests only: drop the shared store. */
export function resetCommandersForTest(): void {
  shared?.unbind()
  shared = null
}
