/**
 * cliModel.ts
 *
 * One definition of how a launch command names the model to run.
 *
 * `modelArgsFor` answers both questions a caller has — "may this vendor be
 * told which model to use?" and "what does that look like on the command
 * line?" — from the same branch, so a refusal and the argv can never
 * disagree. Every spawn, resume and restore path must go through it, for the
 * reason spelled out in cliPermission.ts: a flag inlined at one call site
 * takes effect on some paths and not others.
 *
 * Values are also shape-checked before they reach a command line. A model id
 * is data, not syntax: it cannot contain whitespace and cannot begin with a
 * dash, or `--model "sonnet --dangerously-skip-permissions"` would split into
 * three arguments and hand the spawn an extra flag. This is NOT the identity
 * check the comment on modelArgsFor rules out — it never asks whether an id
 * exists, only whether the string can turn into a second argument, so it
 * cannot go stale when a vendor renames its models.
 *
 * A vendor that cannot select a model at launch declares no `modelArgs`, and
 * asking one for a model is refused rather than dropped. That is deliberate:
 * droid and opencode accept an unknown `--model` on their interactive command
 * and ignore it, so a silently discarded flag looks exactly like a working
 * one until someone reads the transcript and finds the wrong model answered.
 */

/** What a caller asks for. Empty strings mean "not requested". */
export interface CliModelRequest {
  model: string
  effort: string
}

/** Why a request was refused. Structured rather than prose: the MCP tool
 *  answers agents in English and the renderer gate answers users in Chinese,
 *  and both derive their wording from these. */
export type CliModelRefusal =
  | { kind: 'model-unsupported' }
  | { kind: 'model-malformed' }
  | { kind: 'effort-malformed' }
  | { kind: 'effort-unsupported' }
  | { kind: 'effort-invalid'; accepted: readonly string[] }

export type CliModelResult =
  | { ok: true; args: string }
  | { ok: false; refusal: CliModelRefusal }

/** A value safe to place after a flag: no whitespace, no shell metacharacters,
 *  and never a leading dash. The dash is last inside the class where it is a
 *  literal, so it is excluded from the FIRST position by giving that position
 *  its own class — `[A-Za-z0-9._:/-]+` alone would happily match `--flag`.
 *  The permitted set covers every real id shape: `openai/gpt-5.6-sol`
 *  (provider/model), `gpt-5.3-codex-high` (effort in the id) and
 *  `anthropic/claude:thinking` (pi's suffix). */
const ARGUMENT_SAFE = /^[A-Za-z0-9._:/][A-Za-z0-9._:/-]*$/

/** The subset of AgentSpec this module reads. Declared structurally so the
 *  function is testable without building a whole spec. */
export interface CliModelCapability {
  modelArgs?: (model: string) => string
  effortArgs?: (effort: string) => string
  knownEfforts?: readonly string[]
}

/** Arguments to append to a launch command, or the reason the request cannot
 *  be honoured.
 *
 *  Model ids are NOT validated. They change with every vendor release, so a
 *  build-time list would reject valid values; an unknown id is the CLI's own
 *  error to report. Effort values ARE validated when the vendor declares
 *  `knownEfforts`, because that vocabulary is small and closed.
 *
 *  Asking for nothing yields '' and never refuses, so callers that pass no
 *  model behave exactly as they did before this existed. */
export function modelArgsFor(input: {
  spec: CliModelCapability | undefined
  request: CliModelRequest
}): CliModelResult {
  const model = input.request.model.trim()
  const effort = input.request.effort.trim()
  if (!model && !effort) return { ok: true, args: '' }

  const parts: string[] = []
  if (model) {
    if (!input.spec?.modelArgs) return { ok: false, refusal: { kind: 'model-unsupported' } }
    if (!ARGUMENT_SAFE.test(model)) return { ok: false, refusal: { kind: 'model-malformed' } }
    const arg = input.spec.modelArgs(model).trim()
    if (arg) parts.push(arg)
  }
  if (effort) {
    if (!input.spec?.effortArgs) return { ok: false, refusal: { kind: 'effort-unsupported' } }
    const accepted = input.spec.knownEfforts
    if (accepted && !accepted.includes(effort)) {
      return { ok: false, refusal: { kind: 'effort-invalid', accepted } }
    }
    // A vendor may declare effortArgs with no vocabulary, in which case the
    // value reaches the command line unchecked; the shape guard is what keeps
    // that combination from being an injection point.
    if (!ARGUMENT_SAFE.test(effort)) return { ok: false, refusal: { kind: 'effort-malformed' } }
    const arg = input.spec.effortArgs(effort).trim()
    if (arg) parts.push(arg)
  }
  return { ok: true, args: parts.join(' ') }
}

/** True when the vendor can be told which model to run. Callers that only
 *  need the capability (a gate, a tool description) use this instead of
 *  building a request. */
export function supportsModel(spec: CliModelCapability | undefined): boolean {
  return Boolean(spec?.modelArgs)
}

/** True when the vendor has a separate effort flag. False for vendors that
 *  encode effort in the model id itself (cursor's `gpt-5.3-codex-high`) —
 *  those take it through `model`. */
export function supportsEffort(spec: CliModelCapability | undefined): boolean {
  return Boolean(spec?.effortArgs)
}

/** The effort a model id already names in its suffix, when the separately
 *  picked effort differs from it — or '' when there is nothing to warn about.
 *
 *  Some ids carry their level (`gemini-4-neon-low`); agy refuses such an id
 *  together with a different `--effort` (measured on agy 1.5.13: "--model
 *  gemini-4-neon-low conflicts with --effort=high", exit 1). This is a hint for
 *  the UI, never a refusal: the user's pick is launched as chosen, and the CLI
 *  remains the authority on which combinations it accepts. */
export function effortSuffixConflict(input: {
  spec: CliModelCapability | undefined
  request: CliModelRequest
}): string {
  const model = input.request.model.trim()
  const effort = input.request.effort.trim()
  const known = input.spec?.knownEfforts
  if (!model || !effort || !known) return ''
  const suffix = model.slice(model.lastIndexOf('-') + 1)
  if (!model.includes('-') || !known.includes(suffix) || suffix === effort) return ''
  return suffix
}
