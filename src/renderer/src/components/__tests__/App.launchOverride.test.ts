// @vitest-environment node
// The App.vue half of "a per-vendor launch override reaches the spawn".
//
// App.vue cannot be mounted by this suite (see App.spawnAdvisories.test.ts), so
// — like the other App.*.test.ts files — these assert the WIRING against the
// source text: which setting is read, where the value is put, and that the two
// halves of cli.env_ignored are told apart. The executable proof of the values
// themselves lives in platform/plugin-shell/lib/cliLaunchOverride.test.ts.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

function fn(name: string): string {
  const start = appSource.indexOf(`function ${name}(`)
  expect(start, `function ${name} should exist`).toBeGreaterThan(-1)
  const end = appSource.indexOf('\n}\n', start)
  expect(end).toBeGreaterThan(start)
  return appSource.slice(start, end)
}

/** The body of a `backend.on('<event>', …)` registration. */
function handler(event: string): string {
  const start = appSource.indexOf(`backend.on('${event}'`)
  expect(start, `a handler for ${event} should exist`).toBeGreaterThan(-1)
  const end = appSource.indexOf('\n})\n', start)
  expect(end).toBeGreaterThan(start)
  return appSource.slice(start, end)
}

describe('resolveCommand — the stored launch-command override', () => {
  const body = fn('resolveCommand')

  // The precedence itself (caller > stored > none, login skips stored) is
  // pinned executably in cliLaunchOverride.test.ts; these pin that resolveCommand
  // delegates to it with the right inputs.
  it('asks chooseLaunchCommand, with the caller override, the stored setting and the login flag', () => {
    expect(body).toMatch(
      /chooseLaunchCommand\(\{\s*callerCommand: override,\s*storedCommand: settingsGet\(cliCommandKey\(agentKey\), ''\),\s*isLogin,\s*\}\)/,
    )
  })

  it('still returns an override verbatim, so model and effort are skipped', () => {
    // This is what the settings page has to warn about: an override means the
    // user writes the whole line and nothing below is appended.
    const overrideIdx = body.indexOf("if (launch.source !== 'none') {")
    expect(overrideIdx).toBeGreaterThan(-1)
    expect(body.indexOf('modelArgsFor(')).toBeGreaterThan(overrideIdx)
    expect(body).toContain('return { command: launch.command, source: launch.source }')
  })

  it('leaves the custom binary to the backend on the no-override path — the one a login pane takes', () => {
    // A login pane gets source 'none', so it falls through to the vendor's own
    // default command. The custom binary is swapped in by terminal.create
    // (backend cli_binary_overrides), for logins too.
    expect(body).toContain("return { command: parts.join(' '), source: 'none' }")
  })
})

describe('spawnPane — a login pane never launches on the stored command', () => {
  const body = fn('spawnPane')

  it('passes isLogin for both login shapes (isolated profile and live)', () => {
    // The backend keeps only the first token of a login command and appends the
    // sign-in subcommand, so `npx …` would become `npx auth login`.
    expect(body).toMatch(
      /resolveCommand\(opts\.agentKey, opts\.commandOverride, paneArgCtx, \{[^}]*\}, !!\(opts\.isLogin \|\| opts\.loginProfileId\)\)/,
    )
  })
})

describe('the spawn gate knows about the stored launch command', () => {
  it('wires launchCommandOverridden into both gate contexts', () => {
    for (const name of ['spawnGateContextFor', 'standaloneSpawnGateContext']) {
      expect(fn(name), name).toContain('launchCommandOverridden: storedLaunchCommandApplies')
    }
  })

  it('answers for a fresh, non-login pane from the same helper resolveCommand uses', () => {
    const body = fn('storedLaunchCommandApplies')
    expect(body).toMatch(
      /chooseLaunchCommand\(\{\s*callerCommand: '',\s*storedCommand: settingsGet\(cliCommandKey\(agentKey\), ''\),\s*isLogin: false,\s*\}\)\.source === 'stored'/,
    )
  })
})

describe('spawnPane — the stored environment variables', () => {
  const body = fn('spawnPane')

  it('passes the vendor\'s env table into the spawn options', () => {
    expect(body).toContain('env: spawnEnvOverride(settingsGet<unknown>(cliEnvKey(opts.agentKey), null))')
  })

  it('reads the agent key of the pane being spawned, not a fixed vendor', () => {
    expect(body).toContain('cliEnvKey(opts.agentKey)')
  })
})

describe('the launch-command override stops at a fresh spawn — and says so', () => {
  // The decision on record: a custom launch command is NOT merged into a
  // resume command, it is disclosed. Merging would mean choosing where a
  // session id belongs inside a line Navide did not write, and for codex and
  // muse `resume` is a SUBCOMMAND — args placed on the wrong side of it break
  // the resume outright. Replacing only argv[0] would be safe but is already
  // what the backend's binary override does, so it would add nothing.
  //
  // These two assertions are the pair: the builder stays pure, and the page
  // keeps saying what that costs. Wiring the override into resume later means
  // failing here, which is the prompt to revisit the wording at the same time.
  const resumeSource = readFileSync(
    resolve(process.cwd(), 'src/renderer/src/platform/plugin-shell/lib/resume-command.ts'),
    'utf8',
  )
  const settingsSource = readFileSync(
    resolve(process.cwd(), 'src/renderer/src/i18n/locales/zh-TW.json'),
    'utf8',
  )

  it('buildResumeCommand reads no settings — every input arrives as an argument', () => {
    expect(resumeSource).not.toContain('cliCommandKey')
    expect(resumeSource).not.toContain('settingsGet')
  })

  it('the settings page states the limitation rather than burying it in a comment', () => {
    // Worded, not just present: a key that survives as an empty or vague
    // string would pass a mere existence check while telling the user nothing.
    const line = settingsSource.split('\n').find((l) => l.includes('"command-shadows-resume"'))
    expect(line, 'zh-TW should carry the disclosure').toBeTruthy()
    expect(line).toContain('rebuild')
    expect(line).toContain('還原')
    expect(line).toContain('預設指令')
  })
})

describe('cli.env_ignored', () => {
  const body = handler('cli.env_ignored')

  it('reports denied and overridden with different wording', () => {
    // They are different failures: `denied` never entered the environment at
    // all, while `overridden` was accepted and then replaced — telling a user
    // "not allowed" about the second sends them to fix the wrong thing.
    expect(body).toContain("i18n.global.t('cli-env.denied'")
    expect(body).toContain("i18n.global.t('cli-env.overridden'")
  })

  it('surfaces both lists independently — the event may carry either or both', () => {
    expect(body).toContain('if (denied.length > 0)')
    expect(body).toContain('if (overridden.length > 0)')
  })

  it('names the vendor and the keys, so the toast says which setting to go fix', () => {
    expect(body).toContain("keys: denied.join(', ')")
    expect(body).toContain("keys: overridden.join(', ')")
    expect(body).toContain('const label = pane?.agentLabel || ev.label || ev.agent_key')
  })
})
