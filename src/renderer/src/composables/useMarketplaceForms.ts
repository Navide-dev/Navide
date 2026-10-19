// The main window's Navide Marketplace developer forms (plan mcp-navide-0-2-27,
// W3, P3-P5): which form is open in Settings > Navide Marketplace > Developer,
// and with what.
//
// A form opens four ways, all onto the same form and the same submit path:
// the user's own click, an agent's *_open (`marketplace.form_open`, locating
// data only), an agent's *_fill (a form request carrying the agent's draft),
// and a navide://publish link. Only the user's Submit sends anything. For a
// form request, Submit first moves it to `applying` with a confirmation only
// this window can mint (`<approval_id>:approve`), and the outcome is reported
// with `plugins.agent_request.finish`; closing the form rejects it.
import { shallowRef } from 'vue'
import type { useBackend } from './useBackend'
import {
  MARKETPLACE_FORM_OPEN_EVENT,
  PLUGIN_APPROVAL_DECIDE_ACTION,
  PLUGIN_APPROVAL_FINISH_ACTION,
  PLUGIN_APPROVAL_LIST_MESSAGE,
  PLUGIN_APPROVAL_REQUEST_EVENT,
  PLUGIN_APPROVAL_RESOLVED_EVENT,
  isFormApprovalKind,
  type FormApprovalKind,
  type MarketplaceForm,
  type MarketplaceFormOpen,
  type PluginApprovalRequest,
} from '../../../shared/pluginAgentTools'
import type { DeveloperCallResult } from '../../../shared/marketplaceDeveloper'

type Backend = Pick<ReturnType<typeof useBackend>, 'send' | 'on'>

export type MarketplaceFormOrigin = 'user' | 'agent-open' | 'agent-fill' | 'link'

export interface OpenMarketplaceForm {
  form: MarketplaceForm
  origin: MarketplaceFormOrigin
  /** Locating data: a package path and target, or an id and version. */
  prefill: Record<string, string>
  /** Who asked, for an agent's open or fill. */
  requester: PluginApprovalRequest['requester'] | null
  /** The form request an agent filed (its draft and reason); null otherwise. */
  request: PluginApprovalRequest | null
  /** A fresh number per open, so opening the same form again still re-renders it. */
  seq: number
}

const FORM_OF_KIND: Record<FormApprovalKind, MarketplaceForm> = {
  'developer-application': 'developer-application',
  'plugin-publish': 'publish',
  'plugin-yank': 'publish-yank',
  'testplace-invite': 'testplace-invite',
}

/** The form showing (or about to show) on the Developer page. */
export const openMarketplaceForm = shallowRef<OpenMarketplaceForm | null>(null)
/** Which view the Navide Marketplace page shows. */
export const marketplaceView = shallowRef<'browse' | 'developer'>('browse')
let seq = 0

export function setMarketplaceView(view: 'browse' | 'developer'): void {
  marketplaceView.value = view
}

export function showMarketplaceForm(form: Omit<OpenMarketplaceForm, 'seq'>): void {
  openMarketplaceForm.value = { ...form, seq: ++seq }
  marketplaceView.value = 'developer'
}

export function closeMarketplaceForm(): void {
  openMarketplaceForm.value = null
}

function formOfRequest(request: PluginApprovalRequest): OpenMarketplaceForm | null {
  if (!isFormApprovalKind(request.kind) || request.status !== 'pending') return null
  const prefill: Record<string, string> = {}
  if (request.kind === 'plugin-yank' && request.target.version) {
    prefill.id = request.target.id
    prefill.version = request.target.version
  }
  return {
    form: FORM_OF_KIND[request.kind], origin: 'agent-fill', prefill, requester: request.requester, request, seq: ++seq,
  }
}

/** Move a form request to `applying` (Submit) or `rejected` (closing the form). */
export async function decideFormRequest(backend: Pick<Backend, 'send'>, approvalId: string, approve: boolean): Promise<void> {
  const subject = `${approvalId}:${approve ? 'approve' : 'reject'}`
  const confirmation = await window.agentTeam?.trustConfirm(PLUGIN_APPROVAL_DECIDE_ACTION, '', subject)
  const res = await backend.send(PLUGIN_APPROVAL_DECIDE_ACTION, { approval_id: approvalId, approve, confirmation }, 30_000)
  if (!res.ok) throw new Error(res.error?.message ?? 'the request could not be decided')
}

async function finishFormRequest(
  backend: Pick<Backend, 'send'>,
  approvalId: string,
  status: 'completed' | 'failed',
  error: string | null,
): Promise<void> {
  const confirmation = await window.agentTeam?.trustConfirm(PLUGIN_APPROVAL_FINISH_ACTION, '', `${approvalId}:${status}`)
  await backend.send(PLUGIN_APPROVAL_FINISH_ACTION, { approval_id: approvalId, status, error, confirmation })
}

/** The user's Submit: for an agent's form request, approve it, run the call, report the result. */
export async function submitMarketplaceForm<R extends DeveloperCallResult>(
  backend: Pick<Backend, 'send'>,
  request: PluginApprovalRequest | null,
  run: () => Promise<R>,
): Promise<R> {
  if (!request) return run()
  await decideFormRequest(backend, request.approval_id, true)
  let result: R
  try {
    result = await run()
  } catch (error) {
    await finishFormRequest(backend, request.approval_id, 'failed', error instanceof Error ? error.message : String(error))
    throw error
  }
  await finishFormRequest(
    backend, request.approval_id,
    result.ok ? 'completed' : 'failed',
    result.ok ? null : `${result.code ?? result.status}: ${result.message}`,
  )
  return result
}

/** Listen for agents' opens and drafts in this main window; `reveal` shows Settings > Navide Marketplace. */
export function installMarketplaceFormListeners(backend: Backend, reveal: () => void): () => void {
  const offs: Array<() => void> = []
  offs.push(backend.on(MARKETPLACE_FORM_OPEN_EVENT, (raw) => {
    const event = raw as MarketplaceFormOpen
    if (!event?.form) return
    showMarketplaceForm({
      form: event.form, origin: 'agent-open', prefill: event.prefill ?? {}, requester: event.requester ?? null, request: null,
    })
    reveal()
  }))
  offs.push(backend.on(PLUGIN_APPROVAL_REQUEST_EVENT, (raw) => {
    const form = formOfRequest(raw as PluginApprovalRequest)
    if (!form) return
    openMarketplaceForm.value = form
    marketplaceView.value = 'developer'
    reveal()
  }))
  offs.push(backend.on(PLUGIN_APPROVAL_RESOLVED_EVENT, (raw) => {
    const { approval_id: approvalId, status } = raw as { approval_id: string; status: string }
    const current = openMarketplaceForm.value
    // Decided in another window, or expired: this window's draft is no longer the request.
    if (current?.request?.approval_id === approvalId && (status === 'rejected' || status === 'expired')) {
      openMarketplaceForm.value = null
    }
  }))
  return () => offs.forEach((off) => off())
}

/** Drafts filed while no window was listening (or before a reload): show the newest. */
export async function restorePendingForms(backend: Pick<Backend, 'send'>): Promise<boolean> {
  const res = await backend.send<{ requests: PluginApprovalRequest[] }>(PLUGIN_APPROVAL_LIST_MESSAGE)
  if (!res.ok || !Array.isArray(res.payload?.requests)) return false
  const pending = res.payload.requests.filter((r) => isFormApprovalKind(r.kind) && r.status === 'pending')
  const newest = pending.sort((a, b) => b.created_at - a.created_at)[0]
  const form = newest ? formOfRequest(newest) : null
  if (!form || openMarketplaceForm.value) return false
  openMarketplaceForm.value = form
  marketplaceView.value = 'developer'
  return true
}
