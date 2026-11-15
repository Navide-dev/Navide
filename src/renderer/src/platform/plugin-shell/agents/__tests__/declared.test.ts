/**
 * The launch and resume fields of every agent spec come from the runtime's
 * declarations (`_declared.ts`, reading `cli_declarations.json`).
 *
 * `MAIN` is what each spec file itself held before it read them: the label,
 * the command, and the arguments its functions built. The declarations must
 * keep giving exactly these.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import declarations from '../_cli_declarations'
import { AGENT_SPECS } from '../index'

interface Held {
  label: string
  command: string
  yolo?: string
  model?: string
  effort?: string
  efforts?: readonly string[]
  resume?: string
  kind?: 'agent'
}

const MAIN: Record<string, Held> = {
  aider: { label: 'Aider', command: 'aider', yolo: '--yes-always' },
  antigravity: {
    label: 'Antigravity CLI (Google)',
    command: 'agy',
    yolo: '--dangerously-skip-permissions',
    model: '--model M',
    effort: '--effort E',
    efforts: ['low', 'medium', 'high'],
    resume: '--conversation ID',
  },
  claude: {
    label: 'Claude Code (Anthropic)',
    command: 'claude',
    yolo: '--dangerously-skip-permissions',
    model: '--model M',
    effort: '--effort E',
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    resume: '--resume ID',
  },
  codex: {
    label: 'Codex CLI (OpenAI)',
    command: 'codex',
    yolo: '--dangerously-bypass-approvals-and-sandbox',
    model: '--model M',
    resume: 'resume ID',
  },
  copilot: {
    label: 'GitHub Copilot CLI',
    command: 'copilot',
    yolo: '--yolo',
    model: '--model M',
    effort: '--reasoning-effort E',
    efforts: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
    resume: '--resume=ID',
  },
  cursor: { label: 'Cursor CLI', command: 'agent', yolo: '--force', model: '--model M', resume: '--resume=ID' },
  devin: { label: 'Devin CLI (Cognition)', command: 'devin', yolo: '--permission-mode dangerous' },
  droid: { label: 'Droid CLI (Factory)', command: 'droid', yolo: '--auto high', resume: '--resume ID' },
  goose: { label: 'Goose (AAIF)', command: 'goose', resume: 'session -r --session-id ID' },
  grok: { label: 'Grok Build (SpaceXAI)', command: 'grok', model: '--model M', resume: '-r ID' },
  hermes: { label: 'Hermes Agent', command: 'hermes chat', yolo: '--yolo', resume: '--continue ID', kind: 'agent' },
  kilo: { label: 'Kilo Code CLI', command: 'kilo', yolo: '--auto', model: '--model M', resume: '--session ID' },
  kimi: {
    label: 'Kimi Code CLI (Moonshot AI)',
    command: 'kimi',
    yolo: '--yolo',
    model: '--model M',
    resume: '--session ID',
  },
  kiro: { label: 'Kiro CLI (AWS)', command: 'kiro-cli chat --v3', yolo: '--trust-all-tools' },
  mcode: { label: 'MiniMax Code', command: 'mcode' },
  muse: {
    label: 'Muse Code (Meta)',
    command: 'muse',
    yolo: '--disable-approval',
    model: '--model M',
    effort: '--reasoning-effort E',
    efforts: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    resume: 'resume ID',
  },
  opencode: { label: 'OpenCode (Anomaly)', command: 'opencode', model: '--model M', resume: '--session ID' },
  openclaw: { label: 'OpenClaw', command: 'openclaw tui --local', resume: '--session ID', kind: 'agent' },
  pi: {
    label: 'Pi',
    command: 'pi',
    model: '--model M',
    effort: '--thinking E',
    efforts: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
    resume: '--session-id ID',
  },
  qwen: { label: 'Qwen Code (Alibaba Cloud)', command: 'qwen', yolo: '--yolo', model: '--model M', resume: '--resume ID' },
}

/** The display order of main's hand-kept `ORDERED` list in `index.ts`,
 *  recorded before discovery replaced it. It is each declaration's
 *  `order.menu`, with the plain terminal after the CLIs. A CLI declared
 *  later is not in it and needs no entry: the tests below compare the
 *  recorded keys only. */
const MAIN_ORDER = [
  'claude', 'codex', 'antigravity', 'grok', 'kimi', 'opencode', 'qwen', 'kilo', 'pi', 'copilot',
  'cursor', 'aider', 'muse', 'droid', 'mcode', 'goose', 'devin', 'kiro', 'openclaw', 'hermes',
  'terminal',
]

/** The `resumeCommandPattern` each spec file held on main. A spec that held
 *  none was recognized by the generic `<agentKey> --resume <id>` shape. */
const MAIN_RESUME_PATTERN: Record<string, RegExp> = {
  aider: /^aider\b.*--restore-chat-history\b/,
  antigravity: /^agy\s+--conversation\s+\S+/,
  codex: /^codex\s+resume\s+\S+/,
  copilot: /^copilot\s+--resume(?:=|\s+)\S+/,
  cursor: /^(?:cursor-)?agent\s+--resume(?:=|\s+)\S+/,
  goose: /^goose\s+session\s+-r\s+--session-id\s+\S+/,
  grok: /^grok\s+-r\s+\S+/,
  hermes: /^hermes\s+chat\b.*\s(?:--continue|-c)\s+\S+/,
  kilo: /^kilo\s+(?:--session|-s)\s+\S+/,
  kimi: /^kimi\s+(?:--session|-S)\s+\S+/,
  muse: /^muse\s+resume\s+\S+/,
  opencode: /^opencode\s+(?:--session|-s)\s+\S+/,
  openclaw: /^openclaw\s+tui\b.*\s--session(?:=|\s+)\S+/,
  pi: /^pi\s+--session-id\s+\S+/,
}

describe('agent specs built from the declarations', () => {
  const vendors = AGENT_SPECS.filter((spec) => spec.agentKey !== 'terminal')

  it('lists the specs in the order main listed them', () => {
    const listed = AGENT_SPECS.map((spec) => spec.agentKey)
    expect(MAIN_ORDER.filter((key) => !listed.includes(key))).toEqual([])
    // Relative order of the recorded keys only; a later CLI takes its own place.
    expect(listed.filter((key) => MAIN_ORDER.includes(key))).toEqual(MAIN_ORDER)
  })

  it('still has the spec file of every CLI main had', () => {
    // A spec file is optional for a CLI declared later, not for these: one
    // deleted by mistake would leave the CLI listed from its declaration
    // alone, losing its hint and patterns without any other test noticing.
    const files = Object.keys(import.meta.glob('../*.ts')).map((path) => path.replace(/^\.\.\//, '').replace(/\.ts$/, ''))
    expect(MAIN_ORDER.filter((key) => key !== 'terminal' && !files.includes(key))).toEqual([])
  })

  it('lists the plain terminal after every CLI', () => {
    const listed = AGENT_SPECS.map((spec) => spec.agentKey)
    expect(listed.indexOf('terminal')).toBe(listed.length - 1)
  })

  it.each(MAIN_ORDER.filter((key) => key !== 'terminal'))('%s recognizes a resume command as on main', (key) => {
    const spec = vendors.find((candidate) => candidate.agentKey === key)!
    // App.vue's looksLikeResumeCommand: the spec's pattern, else the generic shape.
    const now = spec.resumeCommandPattern ?? new RegExp(`^${key}\\s+--resume\\s+\\S+`)
    const main = MAIN_RESUME_PATTERN[key] ?? new RegExp(`^${key}\\s+--resume\\s+\\S+`)
    expect(now.source).toBe(main.source)
    expect(now.flags).toBe(main.flags)
  })

  it('still lists every vendor main had', () => {
    const keys = vendors.map((spec) => spec.agentKey)
    expect(Object.keys(MAIN).filter((key) => !keys.includes(key))).toEqual([])
  })

  it.each(Object.entries(MAIN))('%s launches and resumes as on main', (key, main) => {
    const spec = vendors.find((candidate) => candidate.agentKey === key)!
    const held: Held = { label: spec.label, command: spec.defaultCommand }
    if (spec.skipPermissionFlag !== undefined) held.yolo = spec.skipPermissionFlag
    if (spec.modelArgs) held.model = spec.modelArgs('M')
    if (spec.effortArgs) held.effort = spec.effortArgs('E')
    if (spec.knownEfforts) held.efforts = [...spec.knownEfforts]
    if (spec.resumeArgs) held.resume = spec.resumeArgs('ID')
    if (spec.kind === 'agent') held.kind = 'agent'
    expect(held).toEqual(main)
  })

  it('puts a value with `$` in it into the arguments as written', () => {
    const claude = vendors.find((spec) => spec.agentKey === 'claude')!
    expect(claude.modelArgs?.('a$&b')).toBe('--model a$&b')
    expect(claude.resumeArgs?.("$'x")).toBe("--resume $'x")
  })
})

describe('a declared CLI with no spec file', () => {
  afterEach(() => {
    vi.doUnmock('../_cli_declarations')
    vi.resetModules()
  })

  it('is listed from its declaration alone, where its order.menu says', async () => {
    // A fake CLI no Rust file declares: devin's declaration under another key,
    // with a resume command, one place after devin, and no agents/<key>.ts.
    const devin = declarations.find((entry) => entry.key === 'devin')!
    const fake = {
      ...devin,
      key: 'nosuchcli',
      label: 'No Such CLI',
      order: { ...devin.order, menu: devin.order.menu + 1 },
      resume: { ...devin.resume, args: ['--resume', '{id}'] },
    }
    vi.resetModules()
    vi.doMock('../_cli_declarations', () => ({ default: [...declarations, fake] }))
    const fresh = await import('../index')

    const keys = fresh.AGENT_SPECS.map((spec) => spec.agentKey)
    expect(keys.indexOf('nosuchcli')).toBe(keys.indexOf('devin') + 1)
    expect(keys.at(-1)).toBe('terminal')
    const spec = fresh.AGENT_SPECS.find((candidate) => candidate.agentKey === 'nosuchcli')!
    expect(spec.label).toBe('No Such CLI')
    expect(spec.defaultCommand).toBe('devin')
    expect(spec.resumeArgs?.('abc')).toBe('--resume abc')
    expect(spec.resumeCommandPattern?.test('devin --resume abc')).toBe(true)
    // Main's CLIs keep their order around it.
    expect(keys.filter((key) => MAIN_ORDER.includes(key))).toEqual(MAIN_ORDER)
  })
})
