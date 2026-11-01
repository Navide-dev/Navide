/** What the Webhooks settings page says about a trigger, apart from the page. */

export type TriggerKind = 'webhook' | 'form' | 'github'

export interface WebhookTrigger {
  id: string
  name: string
  workspace: string
  pipeline_id: string
  kind: TriggerKind
  enabled: boolean
  per_minute: number
  per_day: number
  no_gate_ack: boolean
  unattended: boolean
  approval_timeout_min: number
  github_events: string[]
  form_fields: FormField[]
  form_public: boolean
}

export type FormFieldType = 'text' | 'textarea' | 'number' | 'email' | 'date' | 'select' | 'checkbox'

export interface FormField {
  label: string
  type: FormFieldType
  required: boolean
  options?: string[]
}

export interface WebhookRunView {
  trigger_id: string
  workspace: string
  started_at: number
  unattended: boolean
  waiting_since: number | null
  stops_at: number | null
}

export interface WebhookStatus {
  settings: { enabled: boolean; port: number; public_host: string }
  listening: boolean
  port: number
  error: string
  guard_enabled: boolean
  key_protection: 'keychain' | 'dpapi' | 'file'
  unattended_supported: boolean
  triggers: WebhookTrigger[]
  runs: WebhookRunView[]
}

export interface WebhookEvent {
  id: number
  ts: number
  outcome: string
  status: number
  size: number | null
  count: number
  detail: string | null
}

export const FORM_FIELD_TYPES: FormFieldType[] = ['text', 'textarea', 'number', 'email', 'date', 'select', 'checkbox']

export const GITHUB_EVENTS = ['push', 'pull_request', 'issues', 'issue_comment', 'release', 'workflow_run', 'check_suite']

/** The address to give the caller: the declared public host once there is one,
 *  because a loopback address means nothing to GitHub. */
export function triggerUrl(status: Pick<WebhookStatus, 'port' | 'settings'>, triggerId: string): string {
  const host = status.settings.public_host
  if (host) return `https://${host}/webhook/${triggerId}`
  return `http://127.0.0.1:${status.port || status.settings.port}/webhook/${triggerId}`
}

/** A form's address, token included, which is why it is shown once. Loopback
 *  unless the form was ticked public and a public host is declared. */
export function formUrl(status: Pick<WebhookStatus, 'port' | 'settings'>, token: string, isPublic: boolean): string {
  const host = status.settings.public_host
  if (isPublic && host) return `https://${host}/form/${token}`
  return `http://127.0.0.1:${status.port || status.settings.port}/form/${token}`
}

/** A call that works when pasted, with the key the page is showing. */
export function curlExample(url: string, key: string): string {
  return `curl -X POST '${url}' -H 'Authorization: Bearer ${key}' -H 'Content-Type: application/json' -d '{"hello":"world"}'`
}

export function minutesLeft(stopsAt: number, nowMs: number): number {
  return Math.max(0, Math.ceil((stopsAt * 1000 - nowMs) / 60_000))
}

export type TriggerState = 'off' | 'listener-off' | 'ready' | 'running' | 'waiting'

export function triggerState(trigger: WebhookTrigger, status: WebhookStatus): TriggerState {
  const run = status.runs.find((r) => r.trigger_id === trigger.id)
  if (run) return run.stops_at !== null ? 'waiting' : 'running'
  if (!trigger.enabled) return 'off'
  return status.listening ? 'ready' : 'listener-off'
}

const REFUSALS = new Set(['vendor-refused', 'no-gate', 'pipeline-missing'])

/** The locale key for a reason the backend refused a binding, '' for none. */
export function refusalKey(reason: string): string {
  return REFUSALS.has(reason) ? `webhooks.refused.${reason}` : ''
}

/** Audit outcomes with words of their own; anything else shows as it is. */
const OUTCOMES = new Set([
  'accepted', 'started', 'start-failed', 'duplicate', 'ping', 'event-ignored', 'daily-limit', 'rate-limited',
  'bad-key', 'bad-signature', 'run-active', 'no-window', 'app-locked', 'guard-off', 'vendor-refused', 'no-gate',
  'awaiting-approval', 'approval-timeout', 'run-timeout', 'interrupted', 'secret-lost', 'key-unavailable',
  'unattended-on', 'unattended-off', 'no-gate-acknowledged', 'form-invalid', 'form-public', 'bad-csrf', 'cross-site',
])

export function outcomeKey(outcome: string): string {
  return OUTCOMES.has(outcome) ? `webhooks.outcome.${outcome}` : ''
}
