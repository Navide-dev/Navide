/**
 * How each CLI is launched and resumed, read from the runtime's declarations.
 *
 * `native/navide-cli-runtime/src/vendors/<key>.rs` declares a CLI once.
 * `_cli_declarations.ts` is the launch and resume part of every declaration,
 * printed by `navide-cli-runtime declarations launch`. It is generated, never
 * edited: the same output as the JSON the backend's vendor registry reads
 * (`backend/agent_team_backend/cli_declarations.json`), written as a typed
 * constant and kept inside this module because plugin-shell imports nothing
 * from outside itself. The crate's own test (`tests/checked_in.rs`) fails
 * when either copy is not what the source prints, and rewrites both. A spec
 * file spreads `declared('<key>')` instead of retyping the command and its
 * flags:
 *
 *   label, defaultCommand, skipPermissionFlag, modelArgs, effortArgs,
 *   knownEfforts, resumeArgs, resumeCommandPattern, kind
 *
 * A field the declaration leaves empty is absent from the result, never
 * `undefined`-valued, so a spec looks the same as one that omitted the line.
 */
import declarations from './_cli_declarations'
import type { AgentSpec } from './types'

interface Declaration {
  key: string
  label: string
  kind: string
  launch: {
    program: string
    base_args: readonly string[]
    yolo_args: readonly string[]
    /** Argument template; `{}` is the value. */
    model: readonly string[] | null
    effort: readonly string[] | null
    efforts: readonly string[]
  }
  /** Argument template after the program; `{id}` is the session id. */
  resume: { args: readonly string[] | null }
}

export type DeclaredFields = Pick<
  AgentSpec,
  | 'label'
  | 'defaultCommand'
  | 'skipPermissionFlag'
  | 'modelArgs'
  | 'effortArgs'
  | 'knownEfforts'
  | 'resumeArgs'
  | 'resumeCommandPattern'
  | 'kind'
>

const BY_KEY = new Map<string, Declaration>(declarations.map((entry) => [entry.key, entry]))

/** `template` joined into one command-line string, `hole` replaced by the value as written. */
function filled(template: readonly string[], hole: string): (value: string) => string {
  const [before, ...after] = template.join(' ').split(hole)
  return (value) => [before, ...after].join(value)
}

/**
 * Recognizes the resume command Navide itself builds: the program, its base
 * arguments and the resume arguments, in that order, `{id}` being any one
 * word. A spec that must recognize more than that (a short-flag alias, the
 * `=` and the spaced form both, a former program name, arguments in between)
 * sets its own `resumeCommandPattern` after the spread.
 */
function resumePattern(words: readonly string[]): RegExp {
  const escaped = words.map((word) =>
    word
      .split('{id}')
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('\\S+'),
  )
  return new RegExp(`^${escaped.join('\\s+')}`)
}

export function declared(key: string): DeclaredFields {
  const entry = BY_KEY.get(key)
  if (!entry) throw new Error(`no CLI declaration for "${key}" (_cli_declarations.ts)`)
  const { launch, resume } = entry
  const fields: DeclaredFields = {
    label: entry.label,
    defaultCommand: [launch.program, ...launch.base_args].join(' '),
  }
  if (launch.yolo_args.length) fields.skipPermissionFlag = launch.yolo_args.join(' ')
  if (launch.model) fields.modelArgs = filled(launch.model, '{}')
  if (launch.effort) fields.effortArgs = filled(launch.effort, '{}')
  if (launch.efforts.length) fields.knownEfforts = launch.efforts
  if (resume.args) {
    fields.resumeArgs = filled(resume.args, '{id}')
    fields.resumeCommandPattern = resumePattern([launch.program, ...launch.base_args, ...resume.args])
  }
  if (entry.kind === 'agent') fields.kind = 'agent'
  return fields
}
