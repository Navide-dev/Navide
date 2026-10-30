import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildError,
  buildSuccess,
  isCapabilityAllowed,
  parseCapabilityCall,
  resolveCapabilityCall,
  planCapabilityCall,
  backendResponseToCapability,
  createTerminalOutputBatcher,
  terminalSessionIdOf,
  terminalSessionsFromResponse,
  isCallAllowed,
  isEventAllowed,
  planPublicCapabilityCall,
  isPublicCapabilityEventAllowed,
  HOST_EVENT_SOURCE_PLUGIN_ID,
  shellTopLevelExecutables,
  executionPolicyAllows,
  isAuthenticatedInitiator,
  type PublicCapabilityDecision,
  type HostCapabilityContext,
  type CapabilityCall,
  type PublicCapabilityExecutionPlan,
  type StorageSnapshotTier,
} from './pluginCapabilityBroker'
import { HOST_SHELL_EXECUTABLE_ALLOWLIST, STORAGE_LIMITS } from './pluginCapabilityCatalog'
import { manifestV2CapabilityPolicy, type PluginCapabilityPolicy } from './pluginPermissions'
import { HOST_DEFAULT_EXECUTION_POLICY, type ExecutionPolicySnapshot } from './executionPolicy'
import type { WsResponse } from '../../shared/wsClient'

describe('isCapabilityAllowed', () => {
  it('always allows the built-in ping namespace regardless of requires', () => {
    expect(isCapabilityAllowed([], 'ping')).toBe(true)
  })

  it('allows a namespace explicitly declared in requires', () => {
    expect(isCapabilityAllowed(['fs'], 'fs')).toBe(true)
  })

  it('denies a namespace that is neither built-in nor declared', () => {
    expect(isCapabilityAllowed([], 'fs')).toBe(false)
    expect(isCapabilityAllowed(['git'], 'fs')).toBe(false)
  })
})

describe('buildSuccess / buildError', () => {
  it('builds a success envelope carrying the reqId and result', () => {
    expect(buildSuccess('r1', { pong: true })).toEqual({
      reqId: 'r1',
      ok: true,
      result: { pong: true },
    })
  })

  it('builds an error envelope with just a code when no message given', () => {
    expect(buildError('r2', 'UNKNOWN')).toEqual({
      reqId: 'r2',
      ok: false,
      error: { code: 'UNKNOWN' },
    })
  })

  it('includes the message when provided', () => {
    expect(buildError('r3', 'CAP_DENIED', 'nope')).toEqual({
      reqId: 'r3',
      ok: false,
      error: { code: 'CAP_DENIED', message: 'nope' },
    })
  })
})

describe('parseCapabilityCall', () => {
  it('accepts a well-formed payload and stamps the authoritative pluginId', () => {
    const raw = { ns: 'ping', method: 'ping', args: { hello: 1 }, reqId: 'abc', pluginId: 'spoofed' }
    expect(parseCapabilityCall(raw, 'navide.noop')).toEqual({
      pluginId: 'navide.noop',
      ns: 'ping',
      method: 'ping',
      args: { hello: 1 },
      reqId: 'abc',
    })
  })

  it('rejects non-object payloads', () => {
    expect(parseCapabilityCall(null, 'p')).toBeNull()
    expect(parseCapabilityCall('x', 'p')).toBeNull()
  })

  it('rejects payloads missing required string fields', () => {
    expect(parseCapabilityCall({ method: 'm', reqId: 'r' }, 'p')).toBeNull()
    expect(parseCapabilityCall({ ns: 'ping', reqId: 'r' }, 'p')).toBeNull()
    expect(parseCapabilityCall({ ns: 'ping', method: 'm' }, 'p')).toBeNull()
    expect(parseCapabilityCall({ ns: '', method: 'm', reqId: 'r' }, 'p')).toBeNull()
  })
})

describe('resolveCapabilityCall', () => {
  const call = (over: Partial<CapabilityCall> = {}): CapabilityCall => ({
    pluginId: 'navide.noop',
    ns: 'ping',
    method: 'ping',
    args: { hello: 1 },
    reqId: 'r1',
    ...over,
  })

  it('echoes args back for a ping call', () => {
    expect(resolveCapabilityCall(call(), [])).toEqual({
      reqId: 'r1',
      ok: true,
      result: { pong: true, echo: { hello: 1 } },
    })
  })

  it('denies a namespace the plugin did not declare', () => {
    const res = resolveCapabilityCall(call({ ns: 'fs' }), [])
    expect(res.ok).toBe(false)
    expect(res.error?.code).toBe('CAP_DENIED')
  })

  it('returns UNKNOWN for a declared-but-unimplemented namespace', () => {
    const res = resolveCapabilityCall(call({ ns: 'fs', method: 'read' }), ['fs'])
    expect(res.ok).toBe(false)
    expect(res.error?.code).toBe('UNKNOWN')
  })
})

describe('planCapabilityCall', () => {
  const call = (over: Partial<CapabilityCall> = {}): CapabilityCall => ({
    pluginId: 'navide.fs_probe',
    ns: 'fs',
    method: 'read_file',
    args: { rel_path: 'a.txt' },
    reqId: 'r1',
    ...over,
  })

  it('DENIES an un-granted namespace before it can reach the backend', () => {
    const plan = planCapabilityCall(call({ ns: 'git', method: 'status' }), ['fs'])
    expect(plan.kind).toBe('respond')
    if (plan.kind === 'respond') expect(plan.response.error?.code).toBe('CAP_DENIED')
  })

  it('resolves the built-in ping in-process (never routed to the backend)', () => {
    const plan = planCapabilityCall(call({ ns: 'ping', method: 'ping', args: { a: 1 } }), [])
    expect(plan.kind).toBe('respond')
    if (plan.kind === 'respond') {
      expect(plan.response.ok).toBe(true)
      expect(plan.response.result).toEqual({ pong: true, echo: { a: 1 } })
    }
  })

  it('routes a granted, mapped call to the backend WS type', () => {
    const plan = planCapabilityCall(call(), ['fs'])
    expect(plan).toEqual({ kind: 'backend', wsType: 'fs.read_file' })
  })

  it('returns UNKNOWN for a granted namespace with no mapped method', () => {
    const plan = planCapabilityCall(call({ method: 'chmod' }), ['fs'])
    expect(plan.kind).toBe('respond')
    if (plan.kind === 'respond') expect(plan.response.error?.code).toBe('UNKNOWN')
  })

  it('routes a granted issues call to its backend WS type', () => {
    const plan = planCapabilityCall(call({ ns: 'issues', method: 'list' }), ['issues'])
    expect(plan).toEqual({ kind: 'backend', wsType: 'issues.list' })
  })

  it('DENIES an issues call when the plugin did not declare issues', () => {
    const plan = planCapabilityCall(call({ ns: 'issues', method: 'list' }), ['fs', 'git'])
    expect(plan.kind).toBe('respond')
    if (plan.kind === 'respond') expect(plan.response.error?.code).toBe('CAP_DENIED')
  })

  it('routes ui.open_in_editor to the host (never to the backend WS)', () => {
    const plan = planCapabilityCall(call({ ns: 'ui', method: 'open_in_editor' }), ['ui'])
    expect(plan).toEqual({ kind: 'host', action: 'open_in_editor' })
  })

  it('routes the shell-level ui host capabilities to their host actions', () => {
    expect(planCapabilityCall(call({ ns: 'ui', method: 'open_external' }), ['ui'])).toEqual({
      kind: 'host',
      action: 'open_external',
    })
    expect(planCapabilityCall(call({ ns: 'ui', method: 'reveal_path' }), ['ui'])).toEqual({
      kind: 'host',
      action: 'reveal_path',
    })
    expect(planCapabilityCall(call({ ns: 'ui', method: 'open_workspace' }), ['ui'])).toEqual({
      kind: 'host',
      action: 'open_workspace',
    })
    expect(planCapabilityCall(call({ ns: 'ui', method: 'pick_folder' }), ['ui'])).toEqual({
      kind: 'host',
      action: 'pick_folder',
    })
  })

  it('DENIES ui.open_in_editor when the plugin did not declare ui', () => {
    const plan = planCapabilityCall(call({ ns: 'ui', method: 'open_in_editor' }), ['fs', 'git'])
    expect(plan.kind).toBe('respond')
    if (plan.kind === 'respond') expect(plan.response.error?.code).toBe('CAP_DENIED')
  })
})

describe('Manifest v2 access-aware policy', () => {
  const policy = manifestV2CapabilityPolicy({
    system: ['fs', 'ui'],
  })

  it('projects only declared first-level namespaces', () => {
    expect(isCallAllowed(policy, 'ping', 'ping')).toBe(true)
    expect(isCallAllowed(policy, 'fs', 'read_file')).toBe(true)
    expect(isCallAllowed(policy, 'ui', 'open_external')).toBe(true)
    expect(isCallAllowed(policy, 'aiCli', 'startSession')).toBe(false)
  })

  it('does not turn a deferred storage declaration into a runtime surface', () => {
    expect(isCallAllowed(policy, 'storage', 'get')).toBe(false)
    expect(isCallAllowed(policy, 'storage', 'delete')).toBe(false)
  })

  it('does not route v2 events without authenticated Host context', () => {
    expect(isEventAllowed(policy, 'git.changed')).toBe(false)
    expect(isEventAllowed(policy, 'ui.settings_changed')).toBe(false)
    expect(isEventAllowed(policy, 'workspace.filesChanged')).toBe(false)
  })
})

describe('Issue 03/04 public Host planner', () => {
  const policy = manifestV2CapabilityPolicy({ system: ['aiCli'], shell: 'allowlist' })
  const binding = {
    pluginId: 'acme.ai-cli',
    packageVersion: '1.0.0',
    workspaceId: 'workspace-1',
    instanceId: 'instance-1',
    audience: 'audience-1',
  } as const
  const context = (overrides: Partial<HostCapabilityContext> = {}): HostCapabilityContext => ({
    publisherEligible: true,
    userGrant: { packageVersion: '1.0.0', system: ['aiCli'], shell: 'allowlist' },
    runtimeBinding: binding,
    aiCliProfiles: ['codex'],
    sessionBindings: new Map(),
    ...overrides,
  })
  const call = (overrides: Partial<CapabilityCall> = {}): CapabilityCall => ({
    pluginId: 'acme.ai-cli',
    ns: 'aiCli',
    method: 'startSession',
    args: { profileId: 'codex', cols: 100, rows: 30 },
    reqId: 'req-1',
    ...overrides,
  })

  // Review M2 on #648: a session is owned by one package and one version, not
  // just one instance id. A binding that differs only there is refused.
  it.each([
    ['another package', { pluginId: 'other.plugin' }],
    ['another version of the package', { packageVersion: '0.9.0' }],
  ])('refuses a session bound to %s for input, stop and resize', (_case, differs) => {
    const calls: Array<Partial<CapabilityCall>> = [
      { method: 'sendInput', args: { sessionId: 'session-1', data: 'x' } },
      { method: 'stopSession', args: { sessionId: 'session-1', force: true } },
      { method: 'resizeSession', args: { sessionId: 'session-1', cols: 80, rows: 24 } },
    ]
    for (const overrides of calls) {
      expect(planPublicCapabilityCall(call(overrides), policy, context({
        sessionBindings: new Map([['session-1', binding]]),
      }))).toMatchObject({ kind: 'allow' })
      expect(planPublicCapabilityCall(call(overrides), policy, context({
        sessionBindings: new Map([['session-1', { ...binding, ...differs }]]),
      }))).toMatchObject({ kind: 'deny', response: { error: { message: 'AI CLI session ownership mismatch' } } })
    }
  })

  it('returns a Host-owned plan only after grant, binding, and schema checks', () => {
    expect(planPublicCapabilityCall(call(), policy, context())).toMatchObject({
      kind: 'allow',
      plan: { kind: 'public', address: 'aiCli.startSession', scope: 'workspace', runtime: binding },
    })
  })

  it('keeps legacy Host aliases out of Manifest v2 plans', () => {
    const uiBinding = { ...binding, pluginId: 'acme.ui' }
    const uiPolicy = manifestV2CapabilityPolicy({ system: ['ui'] })
    const uiContext: HostCapabilityContext = {
      publisherEligible: false,
      userGrant: { packageVersion: '1.0.0', system: ['ui'] },
      runtimeBinding: uiBinding,
    }
    const legacyAlias = planCapabilityCall(
      {
        pluginId: 'acme.ui',
        ns: 'ui',
        method: 'open_external',
        args: { url: 'https://example.com' },
        reqId: 'legacy-alias',
      },
      uiPolicy,
      uiContext,
    )
    expect(legacyAlias).toMatchObject({
      kind: 'respond',
      response: { error: { code: 'METHOD_NOT_FOUND' } },
    })

    const v2Address = planCapabilityCall(
      {
        pluginId: 'acme.ui',
        ns: 'ui',
        method: 'openExternal',
        args: { url: 'https://example.com' },
        reqId: 'v2-address',
        // The v2 address resolves; its gesture gate is covered separately.
        userGesture: true,
      },
      uiPolicy,
      uiContext,
    )
    expect(v2Address).toMatchObject({ kind: 'public', address: 'ui.openExternal' })
  })

  it('fails closed without a workspace or package-version grant', () => {
    expect(planPublicCapabilityCall(call(), policy, context({ runtimeBinding: { ...binding, workspaceId: null } }))).toMatchObject({
      kind: 'deny',
      response: { error: { code: 'WORKSPACE_SCOPE_VIOLATION' } },
    })
    expect(planPublicCapabilityCall(call(), policy, context({ userGrant: null }))).toMatchObject({
      kind: 'deny',
      response: { error: { code: 'CAPABILITY_DENIED' } },
    })
  })

  it('does not require first-party publisher eligibility', () => {
    expect(planPublicCapabilityCall(call(), policy, context({ publisherEligible: false }))).toMatchObject({
      kind: 'allow',
      plan: { kind: 'public', address: 'aiCli.startSession' },
    })
  })

  it('requires first-party eligibility for Plans window navigation', () => {
    const plansBinding = { ...binding, pluginId: 'navide.plans' }
    const plansPolicy = manifestV2CapabilityPolicy({ system: ['ui'] })
    const plansCall = call({
      pluginId: 'navide.plans',
      ns: 'ui',
      method: 'openPlansWindow',
      args: { path: '.agent-team/plans/example.html' },
    })

    expect(planPublicCapabilityCall(plansCall, plansPolicy, context({
      runtimeBinding: plansBinding,
      userGrant: { packageVersion: '1.0.0', system: ['ui'] },
      publisherEligible: true,
    }))).toMatchObject({ kind: 'allow', plan: { address: 'ui.openPlansWindow' } })
    expect(planPublicCapabilityCall(plansCall, plansPolicy, context({
      runtimeBinding: plansBinding,
      userGrant: { packageVersion: '1.0.0', system: ['ui'] },
      publisherEligible: false,
    }))).toMatchObject({ kind: 'deny', response: { error: { code: 'CAPABILITY_DENIED' } } })
  })

  it.each([
    ['shareCaps', {}],
    ['shareCreate', { path: '.agent-team/plans/example.html' }],
    ['shareChatTargets', {}],
  ])('requires first-party eligibility for share links: ui.%s', (method, args) => {
    const plansBinding = { ...binding, pluginId: 'navide.plans' }
    const plansPolicy = manifestV2CapabilityPolicy({ system: ['ui'] })
    const shareCall = call({ pluginId: 'navide.plans', ns: 'ui', method, args })

    expect(planPublicCapabilityCall(shareCall, plansPolicy, context({
      runtimeBinding: plansBinding,
      userGrant: { packageVersion: '1.0.0', system: ['ui'] },
      publisherEligible: true,
    }))).toMatchObject({ kind: 'allow', plan: { address: `ui.${method}` } })
    expect(planPublicCapabilityCall(shareCall, plansPolicy, context({
      runtimeBinding: plansBinding,
      userGrant: { packageVersion: '1.0.0', system: ['ui'] },
      publisherEligible: false,
    }))).toMatchObject({ kind: 'deny', response: { error: { code: 'CAPABILITY_DENIED' } } })
  })

  it.each([
    ['openPath', { path: 'run.command' }],
    ['openTempFile', { name: 'x.bat', content: 'calc' }],
    ['writeKeybindings', { content: '[]' }],
    ['listGitAccounts', {}],
    ['getGitAccountBinding', {}],
    ['addGitAccount', { label: 'l', host: 'github.com', username: 'u', token: 't' }],
    ['bindGitAccount', { accountId: 'a' }],
    ['unbindGitAccount', {}],
  ])('keeps ui.%s (launches files or reaches credentials) to first-party publishers', (method, args) => {
    const uiBinding = { ...binding, pluginId: 'acme.ui' }
    const uiPolicy = manifestV2CapabilityPolicy({ system: ['ui'] })
    const uiCall = call({ pluginId: 'acme.ui', ns: 'ui', method, args })
    const uiContext = (publisherEligible: boolean) => context({
      runtimeBinding: uiBinding,
      userGrant: { packageVersion: '1.0.0', system: ['ui'] },
      publisherEligible,
    })
    expect(planPublicCapabilityCall(uiCall, uiPolicy, uiContext(true)))
      .toMatchObject({ kind: 'allow', plan: { address: `ui.${method}` } })
    expect(planPublicCapabilityCall(uiCall, uiPolicy, uiContext(false)))
      .toMatchObject({ kind: 'deny', response: { error: { code: 'CAPABILITY_DENIED' } } })
  })

  it('requires a Host-allowlisted AI CLI profile', () => {
    expect(
      planPublicCapabilityCall(
        call({ args: { profileId: 'unregistered', cols: 100, rows: 30 } }),
        policy,
        context()
      )
    ).toMatchObject({ kind: 'deny', response: { error: { code: 'CAPABILITY_DENIED' } } })
  })

  it('denies shell.run when the shell declaration is omitted', () => {
    const noShellPolicy = manifestV2CapabilityPolicy({ system: ['fs'] })
    expect(
      planPublicCapabilityCall(
        call({ ns: 'shell', method: 'run', args: { command: 'git status' } }),
        noShellPolicy,
        context({ userGrant: { packageVersion: '1.0.0', system: ['fs'] } })
      )
    ).toMatchObject({ kind: 'deny', response: { error: { code: 'CAPABILITY_DENIED' } } })
  })

  it('records the approved Host-maintained shell executables', () => {
    expect(HOST_SHELL_EXECUTABLE_ALLOWLIST).toEqual(['git', 'gh', 'glab'])
    // The Settings copy tells the user which commands a denylist can still
    // reach, and reads that list out of the snapshot's Host default policy.
    // That is only truthful while the default policy carries the very list the
    // denylist enforcement point intersects against.
    expect(HOST_DEFAULT_EXECUTION_POLICY.shell).toEqual([...HOST_SHELL_EXECUTABLE_ALLOWLIST])
    expect(
      planPublicCapabilityCall(
        call({ ns: 'shell', method: 'run', args: { command: 'git status' } }),
        policy,
        context()
      )
    ).toMatchObject({ kind: 'allow', plan: { address: 'shell.run', shellMode: 'allowlist' } })
  })

  it('gives an official Git package no identity-based shell bypass', () => {
    const officialBinding = { ...binding, pluginId: 'navide.git' }
    const officialCall = call({
      pluginId: 'navide.git',
      ns: 'shell',
      method: 'run',
      args: { command: 'git status' },
    })
    expect(
      planPublicCapabilityCall(
        officialCall,
        manifestV2CapabilityPolicy({}),
        context({ runtimeBinding: officialBinding })
      )
    ).toMatchObject({ kind: 'deny', response: { error: { code: 'CAPABILITY_DENIED' } } })
    expect(
      planPublicCapabilityCall(
        officialCall,
        policy,
        context({ runtimeBinding: officialBinding, userGrant: null })
      )
    ).toMatchObject({ kind: 'deny', response: { error: { code: 'CAPABILITY_DENIED' } } })
  })

  it.each([
    ['unknown executable', 'curl https://example.com'],
    ['wrapper', 'env git status'],
    ['absolute path substitution', '/usr/bin/git status'],
    ['relative path substitution', './git status'],
    ['command substitution', 'git $(echo status)'],
    ['redirection', 'git status > output.txt'],
    ['alias', 'g status'],
    ['unallowlisted pipeline segment', 'git status | cat'],
    ['unallowlisted command-chain segment', 'git status && echo done'],
  ])('fails closed for %s', (_case, command) => {
    expect(
      planPublicCapabilityCall(
        call({ ns: 'shell', method: 'run', args: { command } }),
        policy,
        context()
      )
    ).toMatchObject({ kind: 'deny', response: { error: { code: 'CAPABILITY_DENIED' } } })
  })

  it.each([
    ['parenthesized command', '(rm -rf .)'],
    ['braced command', '{ rm -rf .; }'],
    ['negated command', '! rm -rf .'],
    ['assignment-prefixed command', 'RM=1 rm x'],
  ])('fails closed for denylist shell syntax: %s', (_case, command) => {
    const denylist: ExecutionPolicySnapshot = {
      policy: { schemaVersion: 1, mode: 'denylist', system: [], shell: ['rm'] },
      revision: 1,
      state: 'user',
    }
    const agent = { kind: 'agent', source: 'mcp', id: 'agent-1' } as const

    expect(shellTopLevelExecutables(command)).toBeNull()
    expect(executionPolicyAllows(agent, denylist, 'shell', command)).toBe(false)
  })

  const gitDenylist: ExecutionPolicySnapshot = {
    policy: { schemaVersion: 1, mode: 'denylist', system: [], shell: ['git'] },
    revision: 1,
    state: 'user',
  }
  const denylistAgent = { kind: 'agent', source: 'mcp', id: 'agent-1' } as const

  it.each([
    ['sh -c', 'sh -c "git push --force"'],
    ['bash -c', 'bash -c "git push --force"'],
    ['zsh -c', "zsh -c 'git push --force'"],
    ['dash -c', "dash -c 'git push --force'"],
    ['bash -lc', 'bash -lc "git push --force"'],
    ['sh -ic', 'sh -ic "git push --force"'],
    ['env', 'env git push --force'],
    ['sudo', 'sudo git push --force'],
    ['nice', 'nice git push --force'],
    ['nohup', 'nohup git push --force'],
    ['xargs', 'xargs git push --force'],
    ['command', 'command git push --force'],
    ['time', 'time git push --force'],
    ['doas', 'doas git push --force'],
    ['env assignment prefix', 'env GIT_DIR=/tmp/x git push --force'],
    ['nested forwarding wrappers', 'sudo env nice git push --force'],
    ['wrapper inside an interpreter', 'sh -c "env git push --force"'],
    ['interpreter inside a wrapper', 'env sh -c "git push --force"'],
    ['wrapper in a later chain segment', 'echo ok && sudo git push --force'],
  ])('blocks a denylisted executable hidden behind %s', (_case, command) => {
    expect(executionPolicyAllows(denylistAgent, gitDenylist, 'shell', command)).toBe(false)
  })

  it.each([
    ['interpreter command built by expansion', 'sh -c "$CMD"'],
    ['interpreter running a script operand', 'sh script.sh'],
    ['interpreter with no inline command', 'bash'],
    ['interpreter with a missing -c argument', 'sh -c'],
    ['interpreter after end of options', 'sh -- run.sh'],
    ['xargs reading from standard input', 'xargs'],
    ['wrapper option that may consume its argument', 'nice -n 10 echo hi'],
    ['wrapper with an unresolvable target', 'env $CMD'],
    ['wrapper target given by path', 'sudo /usr/bin/git push'],
    ['wrapper nesting beyond the depth cap', `${'env '.repeat(12)}echo hi`],
  ])('fails closed when a wrapper target is undeterminable: %s', (_case, command) => {
    expect(shellTopLevelExecutables(command)).toBeNull()
    expect(executionPolicyAllows(denylistAgent, gitDenylist, 'shell', command)).toBe(false)
  })

  it.each([
    ['timeout', 'timeout 5 git push --force'],
    ['setsid', 'setsid git push --force'],
    ['stdbuf', 'stdbuf -o0 git push --force'],
    ['ionice', 'ionice -c3 git push --force'],
    ['chroot', 'chroot / git push --force'],
    ['script', 'script -q /dev/null git push --force'],
    ['watch', 'watch git push --force'],
    ['busybox', 'busybox sh -c "git push --force"'],
    ['ksh -c', 'ksh -c "git push --force"'],
    ['fish -c', 'fish -c "git push --force"'],
    ['perl -e', 'perl -e "system(q(git push --force))"'],
    ['python3 -c', 'python3 -c "import os; os.system(\'git push --force\')"'],
    ['npx', 'npx git-push-force'],
  ])('denies a command whose real executable the Host cannot resolve: %s', (_case, command) => {
    // The leading token is not a Host-known executable, so it may itself be a
    // wrapper for the denied one. "Absent from the denylist" is not a grant.
    expect(executionPolicyAllows(denylistAgent, gitDenylist, 'shell', command)).toBe(false)
  })

  it('leaves no unresolvable-wrapper form allowed under a denylist', () => {
    const commands = [
      'timeout 5 git push --force',
      'setsid git push --force',
      'stdbuf -o0 git push --force',
      'busybox sh -c "git push --force"',
      'ksh -c "git push --force"',
      'perl -e "system(q(git push --force))"',
      'npx git-push-force',
    ]
    const allowed = commands.filter((command) =>
      executionPolicyAllows(denylistAgent, gitDenylist, 'shell', command)
    )
    expect(allowed).toEqual([])
    expect(commands.filter((command) =>
      !executionPolicyAllows(denylistAgent, gitDenylist, 'shell', command)
    )).toHaveLength(commands.length)
  })

  it('still allows Host-known executables a denylist does not name', () => {
    expect(executionPolicyAllows(denylistAgent, gitDenylist, 'shell', 'gh pr list')).toBe(true)
    expect(executionPolicyAllows(denylistAgent, gitDenylist, 'shell', 'gh pr list && glab mr list')).toBe(true)
    expect(executionPolicyAllows(denylistAgent, gitDenylist, 'shell', 'git status')).toBe(false)
  })

  it('reports the wrapper and the executable it runs', () => {
    expect(shellTopLevelExecutables('sh -c "git status"')).toEqual(['sh', 'git'])
    expect(shellTopLevelExecutables('env git status')).toEqual(['env', 'git'])
    expect(shellTopLevelExecutables('sudo env nice git status')).toEqual(['sudo', 'env', 'nice', 'git'])
  })

  it('keeps wrapped commands out of the Host allowlist path', () => {
    // `sh` is not Host-allowlisted, so a wrapped command stays denied exactly
    // as it was before wrappers were resolved: never an easier path than
    // running the allowlisted executable directly.
    expect(
      planPublicCapabilityCall(
        call({ ns: 'shell', method: 'run', args: { command: 'sh -c "git status"' } }),
        policy,
        context()
      )
    ).toMatchObject({ kind: 'deny', response: { error: { code: 'CAPABILITY_DENIED' } } })
  })

  it('still allows ordinary quoted commands', () => {
    expect(shellTopLevelExecutables('git commit -m "fix(ui): x"')).toEqual(['git'])
    // `echo ok` used to pass this denylist purely because `echo` was absent
    // from it. It no longer does: a denylist is enforced over the Host's
    // resolvable vocabulary, since an unknown leading token may be a wrapper
    // for the denied executable. A Host-known, undenied executable still runs.
    expect(executionPolicyAllows(denylistAgent, gitDenylist, 'shell', 'echo ok')).toBe(false)
    expect(executionPolicyAllows(denylistAgent, gitDenylist, 'shell', 'gh pr list')).toBe(true)
    expect(
      planPublicCapabilityCall(
        call({ ns: 'shell', method: 'run', args: { command: 'git commit -m "fix(ui): x"' } }),
        policy,
        context()
      )
    ).toMatchObject({ kind: 'allow', plan: { address: 'shell.run', shellMode: 'allowlist' } })
  })

  it('rejects Plugin-supplied identity and raw execution fields', () => {
    const result = planPublicCapabilityCall(
      call({ args: { profileId: 'codex', cols: 100, rows: 30, workspaceId: 'spoofed', executable: '/bin/sh' } }),
      policy,
      context()
    )
    expect(result).toMatchObject({ kind: 'deny', response: { error: { code: 'INVALID_ARGUMENT' } } })
  })

  it('checks every top-level executable in a shell pipeline or chain', () => {
    expect(shellTopLevelExecutables('git status && echo ok | git diff')).toEqual(['git', 'echo', 'git'])
    expect(shellTopLevelExecutables('git status |& gh pr list')).toEqual(['git', 'gh'])
    expect(
      planPublicCapabilityCall(
        call({ ns: 'shell', method: 'run', args: { command: 'git status && rm -rf .' } }),
        policy,
        context()
      )
    ).toMatchObject({ kind: 'deny', response: { error: { code: 'CAPABILITY_DENIED' } } })
  })

  it('rejects shell expansion and redirection before allowlist evaluation', () => {
    expect(shellTopLevelExecutables('git $(echo unsafe)')).toBeNull()
    expect(shellTopLevelExecutables('git > output.txt')).toBeNull()
    expect(shellTopLevelExecutables('./git status')).toBeNull()
    expect(
      planPublicCapabilityCall(
        call({ ns: 'shell', method: 'run', args: { command: 'git $(/bin/sh -c unsafe)' } }),
        policy,
        context()
      )
    ).toMatchObject({ kind: 'deny', response: { error: { code: 'CAPABILITY_DENIED' } } })
  })

  it('requires a separate high-risk confirmation for full shell mode', () => {
    const fullPolicy = manifestV2CapabilityPolicy({ shell: 'full' })
    const fullContext = context({
      publisherEligible: false,
      userGrant: { packageVersion: '1.0.0', system: [], shell: 'full' },
    })
    const denied = planPublicCapabilityCall(
      call({ ns: 'shell', method: 'run', args: { command: 'arbitrary --command' } }),
      fullPolicy,
      fullContext
    )
    expect(denied).toMatchObject({ kind: 'deny', response: { error: { code: 'CAPABILITY_DENIED' } } })
    expect(
      planPublicCapabilityCall(
        call({ ns: 'shell', method: 'run', args: { command: 'arbitrary --command' } }),
        fullPolicy,
        context({
          publisherEligible: false,
          userGrant: { packageVersion: '1.0.0', system: [], shell: 'full', highRiskShellConfirmed: true },
        })
      )
    ).toMatchObject({ kind: 'allow', plan: { address: 'shell.run', shellMode: 'full' } })
  })

  it('routes AI CLI events only to the authenticated session audience', () => {
    const session = { ...binding, instanceId: 'instance-1', audience: 'audience-1' }
    const allowed = context({ sessionBindings: new Map([['session-1', session]]) })
    expect(
      isPublicCapabilityEventAllowed(
        policy,
        'aiCli.output',
        { sessionId: 'session-1', data: 'ok' },
        allowed,
        'acme.ai-cli',
        session
      )
    ).toBe(true)
    expect(
      isPublicCapabilityEventAllowed(
        policy,
        'aiCli.output',
        { sessionId: 'session-1', data: 'ok', exitCode: 0 },
        allowed,
        'acme.ai-cli'
      )
    ).toBe(false)
    expect(
      isPublicCapabilityEventAllowed(
        policy,
        'aiCli.output',
        { sessionId: 'session-1', data: 'ok' },
        context({ runtimeBinding: { ...binding, audience: 'other-audience' }, sessionBindings: new Map([['session-1', session]]) }),
        'acme.ai-cli'
      )
    ).toBe(false)
  })

  it('requires the package-version grant before routing public events', () => {
    expect(
      isPublicCapabilityEventAllowed(
        policy,
        'aiCli.output',
        { sessionId: 'session-1', data: 'ok' },
        context({
          userGrant: null,
          sessionBindings: new Map([['session-1', binding]]),
        }),
        'acme.ai-cli'
      )
    ).toBe(false)
  })

  it('requires a Host-bound workspace source for workspace events', () => {
    const filesPolicy = manifestV2CapabilityPolicy({ system: ['fs'] })
    const filesContext = context({
      userGrant: { packageVersion: '1.0.0', system: ['fs'] },
    })
    const payload = { changes: [{ path: 'README.md', kind: 'changed' }] }
    expect(
      isPublicCapabilityEventAllowed(
        filesPolicy,
        'workspace.filesChanged',
        payload,
        filesContext,
        'acme.ai-cli'
      )
    ).toBe(false)
    expect(
      isPublicCapabilityEventAllowed(
        filesPolicy,
        'workspace.filesChanged',
        payload,
        filesContext,
        'acme.ai-cli',
        { ...binding, pluginId: HOST_EVENT_SOURCE_PLUGIN_ID, instanceId: null, audience: null }
      )
    ).toBe(true)
    expect(
      isPublicCapabilityEventAllowed(
        filesPolicy,
        'workspace.filesChanged',
        payload,
        filesContext,
        'acme.ai-cli',
        {
          ...binding,
          pluginId: HOST_EVENT_SOURCE_PLUGIN_ID,
          workspaceId: 'other-workspace',
          instanceId: null,
          audience: null,
        }
      )
    ).toBe(false)
    expect(
      isPublicCapabilityEventAllowed(
        filesPolicy,
        'workspace.filesChanged',
        payload,
        filesContext,
        'acme.ai-cli',
        { ...binding, pluginId: 'acme.other', instanceId: null, audience: null }
      )
    ).toBe(false)
    expect(
      isPublicCapabilityEventAllowed(
        filesPolicy,
        'workspace.filesChanged',
        payload,
        filesContext,
        'acme.ai-cli',
        { ...binding, pluginId: HOST_EVENT_SOURCE_PLUGIN_ID, instanceId: 'view-1', audience: null }
      )
    ).toBe(false)
    expect(
      isPublicCapabilityEventAllowed(
        filesPolicy,
        'workspace.filesChanged',
        payload,
        filesContext,
        'acme.other',
        { ...binding, pluginId: HOST_EVENT_SOURCE_PLUGIN_ID, instanceId: null, audience: null }
      )
    ).toBe(false)
  })

  it('requires the exact instance binding for AI CLI events, not the package context binding', () => {
    const session = { ...binding, instanceId: 'instance-1', audience: 'audience-1' }
    const allowed = context({ sessionBindings: new Map([['session-1', session]]) })
    expect(
      isPublicCapabilityEventAllowed(
        policy,
        'aiCli.output',
        { sessionId: 'session-1', data: 'ok' },
        allowed,
        'acme.ai-cli',
        { ...binding, instanceId: null, audience: null }
      )
    ).toBe(false)
  })
})

describe('backendResponseToCapability', () => {
  const resp = (over: Partial<WsResponse> = {}): WsResponse => ({
    id: 'x',
    type: 'fs.read_file.result',
    ok: true,
    payload: { content: 'hi' },
    error: null,
    timestamp: '',
    ...over,
  })

  it('wraps a successful backend response as a capability success', () => {
    expect(backendResponseToCapability('r1', resp())).toEqual({
      reqId: 'r1',
      ok: true,
      result: { content: 'hi' },
    })
  })

  it('maps a backend error to BACKEND_ERROR carrying the message', () => {
    const cap = backendResponseToCapability('r1', resp({
      ok: false,
      payload: null,
      error: { code: 'ENOENT', message: 'no such file' },
    }))
    expect(cap.ok).toBe(false)
    expect(cap.error).toEqual({ code: 'BACKEND_ERROR', message: 'no such file' })
  })

  it('preserves a stable resource-limit code from the backend', () => {
    const cap = backendResponseToCapability('r1', resp({
      ok: false,
      payload: null,
      error: { code: 'RESOURCE_LIMIT', message: 'too many calls' },
    }))

    expect(cap).toEqual({
      reqId: 'r1',
      ok: false,
      error: { code: 'RESOURCE_LIMIT', message: 'too many calls' },
    })
  })
})

describe('terminalSessionsFromResponse', () => {
  it('yields the new session id from a terminal.create response', () => {
    expect(
      terminalSessionsFromResponse('terminal.create', { terminal_session_id: 't-1', pid: 42 })
    ).toEqual(['t-1'])
  })

  it('yields every alive id from a terminal.reattach response', () => {
    expect(
      terminalSessionsFromResponse('terminal.reattach', { alive: ['t-1', 't-2'], dead: ['t-3'] })
    ).toEqual(['t-1', 't-2'])
  })

  it('yields nothing for other WS types or malformed payloads', () => {
    expect(terminalSessionsFromResponse('terminal.input', { terminal_session_id: 't-1' })).toEqual([])
    expect(terminalSessionsFromResponse('terminal.create', null)).toEqual([])
    expect(terminalSessionsFromResponse('terminal.create', { terminal_session_id: 7 })).toEqual([])
    expect(terminalSessionsFromResponse('terminal.reattach', { alive: 'nope' })).toEqual([])
    expect(terminalSessionsFromResponse('terminal.reattach', { alive: ['ok', 7, ''] })).toEqual(['ok'])
  })
})

describe('terminalSessionIdOf', () => {
  it('extracts the terminal_session_id, tolerating junk', () => {
    expect(terminalSessionIdOf({ terminal_session_id: 't-1', data: 'x' })).toBe('t-1')
    expect(terminalSessionIdOf({ terminal_session_id: 5 })).toBe('')
    expect(terminalSessionIdOf(null)).toBe('')
    expect(terminalSessionIdOf('t-1')).toBe('')
  })
})

describe('createTerminalOutputBatcher', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  function payload(id: string, data: string, sequence: number): Record<string, unknown> {
    return { terminal_session_id: id, pane_id: 'p', sequence, data, stream: 'stdout' }
  }

  it('coalesces a burst into ONE delivery, concatenating data in order', () => {
    const delivered: Array<{ id: string; payload: Record<string, unknown> }> = []
    const batcher = createTerminalOutputBatcher((id, p) => delivered.push({ id, payload: p }), 12)
    batcher.push('t-1', payload('t-1', 'he', 1))
    batcher.push('t-1', payload('t-1', 'll', 2))
    batcher.push('t-1', payload('t-1', 'o', 3))
    expect(delivered).toEqual([])
    vi.advanceTimersByTime(12)
    expect(delivered).toHaveLength(1)
    // data is the concatenation; the other fields (incl. sequence) come from
    // the LAST queued payload — the batch covers exactly the events up to it.
    expect(delivered[0]).toEqual({
      id: 't-1',
      payload: { terminal_session_id: 't-1', pane_id: 'p', sequence: 3, data: 'hello', stream: 'stdout' },
    })
  })

  it('keeps sessions independent (per-session batches and timers)', () => {
    const delivered: string[] = []
    const batcher = createTerminalOutputBatcher((id, p) => delivered.push(`${id}:${p.data}`), 12)
    batcher.push('t-1', payload('t-1', 'a', 1))
    vi.advanceTimersByTime(6)
    batcher.push('t-2', payload('t-2', 'b', 1))
    vi.advanceTimersByTime(6)
    expect(delivered).toEqual(['t-1:a'])
    vi.advanceTimersByTime(6)
    expect(delivered).toEqual(['t-1:a', 't-2:b'])
  })

  it('flushSession delivers pending output immediately (ordering barrier before exit)', () => {
    const delivered: string[] = []
    const batcher = createTerminalOutputBatcher((id, p) => delivered.push(String(p.data)), 12)
    batcher.push('t-1', payload('t-1', 'bye', 9))
    batcher.flushSession('t-1')
    expect(delivered).toEqual(['bye'])
    // The timer was cleared — no double delivery.
    vi.advanceTimersByTime(20)
    expect(delivered).toEqual(['bye'])
  })

  it('a new push after a flush starts a fresh batch', () => {
    const delivered: string[] = []
    const batcher = createTerminalOutputBatcher((id, p) => delivered.push(String(p.data)), 12)
    batcher.push('t-1', payload('t-1', 'one', 1))
    vi.advanceTimersByTime(12)
    batcher.push('t-1', payload('t-1', 'two', 2))
    vi.advanceTimersByTime(12)
    expect(delivered).toEqual(['one', 'two'])
  })

  it('dropSession discards pending output without delivering', () => {
    const delivered: string[] = []
    const batcher = createTerminalOutputBatcher((id, p) => delivered.push(String(p.data)), 12)
    batcher.push('t-1', payload('t-1', 'gone', 1))
    batcher.dropSession('t-1')
    vi.advanceTimersByTime(20)
    expect(delivered).toEqual([])
  })

  it('flushAll drains every pending session', () => {
    const delivered: string[] = []
    const batcher = createTerminalOutputBatcher((id) => delivered.push(id), 12)
    batcher.push('t-1', payload('t-1', 'a', 1))
    batcher.push('t-2', payload('t-2', 'b', 1))
    batcher.flushAll()
    expect(delivered.sort()).toEqual(['t-1', 't-2'])
  })
})

// ── Issue 16 — Host-managed plugin/workspace storage partitions ──────────────
//
// Storage is not a declared Manifest permission: a package reads/writes its
// partition only through a Host-managed grant, and the Host derives every
// partition identity (pluginId, currentWorkspaceId) from the authenticated
// runtime binding. The Plugin chooses only a partition class and a key.

type StoragePlan = NonNullable<PublicCapabilityExecutionPlan['storage']>

function asStorage(result: PublicCapabilityDecision, label: string): StoragePlan {
  if (result.kind !== 'allow') {
    throw new Error(`${label}: expected allow, got ${JSON.stringify(result.response.error)}`)
  }
  const storage = result.plan.storage
  if (!storage) {
    throw new Error(`${label}: expected a storage plan`)
  }
  return storage
}

/** Read a planning result's storage sub-plan, or assert it exists. */
function storagePlan(result: PublicCapabilityDecision, label: string): StoragePlan {
  return asStorage(result, label)
}

describe('Issue 16 broker Host-managed storage partitions', () => {
  const pluginId = 'acme.plugin'
  const workspaceId = 'workspace-1'
  const binding = {
    pluginId,
    packageVersion: '1.0.0',
    workspaceId,
    instanceId: 'instance-1',
    audience: null,
  } as const
  /** Package versions bound to each versioned storage snapshot. */
  const storageSnapshots = new Map<StorageSnapshotTier, string>([
    ['candidate', '2.0.0'],
    ['active', '1.0.0'],
    ['previous', '0.9.0'],
  ])

  const call = (
    method: 'get' | 'set' | 'delete',
    scope: 'plugin' | 'workspace',
    extra: Record<string, unknown> = {},
    callerPluginId = pluginId
  ): CapabilityCall => ({
    pluginId: callerPluginId,
    ns: 'storage',
    method,
    args: {
      scope,
      key: 'key-1',
      ...(method === 'set' ? { value: { enabled: true } } : {}),
      ...extra,
    },
    reqId: 'storage-req',
  })

  const context = (overrides: Partial<HostCapabilityContext> = {}): HostCapabilityContext => ({
    publisherEligible: true,
    userGrant: { packageVersion: '1.0.0', system: [], storage: true },
    runtimeBinding: binding,
    storageSnapshots,
    storageSnapshotTier: 'active',
    ...overrides,
  })

  const policy = (): Extract<PluginCapabilityPolicy, { kind: 'manifest-v2' }> =>
    manifestV2CapabilityPolicy({ system: [] })

  it('allows storage and derives the plugin partition from the binding', () => {
    const result = planPublicCapabilityCall(call('get', 'plugin'), policy(), context())
    expect(result).toMatchObject({ kind: 'allow' })
    if (result.kind !== 'allow') return
    expect(storagePlan(result, 'plugin-scope get')).toMatchObject({
      partition: { pluginId, workspaceId: null, key: 'key-1' },
      snapshot: { tier: 'active', packageVersion: '1.0.0' },
    })
  })

  it('sets and deletes route the same Host-derived partition', () => {
    const set = planPublicCapabilityCall(call('set', 'workspace'), policy(), context())
    const del = planPublicCapabilityCall(call('delete', 'plugin'), policy(), context())
    expect(set.kind).toBe('allow')
    expect(del.kind).toBe('allow')
    if (set.kind !== 'allow' || del.kind !== 'allow') return
    expect(storagePlan(set, 'set')).toMatchObject({
      partition: { pluginId, workspaceId, key: 'key-1' },
      snapshot: { tier: 'active', packageVersion: '1.0.0' },
    })
    expect(storagePlan(del, 'delete')).toMatchObject({
      partition: { pluginId, workspaceId: null, key: 'key-1' },
    })
  })

  it('shares the plugin partition across live views and the backend of that plugin', () => {
    // Two views of the same plugin, different workspaceId/instanceId, still share
    // the plugin partition because identity is Host-derived from pluginId plus
    // the selected package-version/tier snapshot and key.
    const viewA = planPublicCapabilityCall(
      call('get', 'plugin'),
      policy(),
      context({
        runtimeBinding: { ...binding, workspaceId: 'workspace-9', instanceId: 'instance-99' },
      })
    )
    const viewB = planPublicCapabilityCall(
      call('get', 'plugin'),
      policy(),
      context({ runtimeBinding: { ...binding, instanceId: 'instance-other' } })
    )
    expect(viewA.kind).toBe('allow')
    expect(viewB.kind).toBe('allow')
    if (viewA.kind !== 'allow' || viewB.kind !== 'allow') return
    const a = storagePlan(viewA, 'viewA')
    const b = storagePlan(viewB, 'viewB')
    expect(a.partition).toEqual({ pluginId, workspaceId: null, key: 'key-1' })
    expect(b.partition).toEqual(a.partition)
  })

  it('keeps workspace partitions isolated across plugins and across workspaces', () => {
    const self = planPublicCapabilityCall(call('get', 'workspace'), policy(), context())
    const otherPlugin = planPublicCapabilityCall(
      call('get', 'workspace', {}, 'other.plugin'),
      policy(),
      context({ runtimeBinding: { ...binding, pluginId: 'other.plugin' } })
    )
    const otherWorkspace = planPublicCapabilityCall(
      call('get', 'workspace'),
      policy(),
      context({ runtimeBinding: { ...binding, workspaceId: 'workspace-2' } })
    )
    expect(self.kind).toBe('allow')
    expect(otherPlugin.kind).toBe('allow')
    expect(otherWorkspace.kind).toBe('allow')
    if (self.kind !== 'allow' || otherPlugin.kind !== 'allow' || otherWorkspace.kind !== 'allow') return
    const selfPartition = storagePlan(self, 'self').partition
    expect(storagePlan(otherPlugin, 'other plugin').partition).toEqual({
      ...selfPartition,
      pluginId: 'other.plugin',
    })
    expect(storagePlan(otherWorkspace, 'other workspace').partition).toEqual({
      ...selfPartition,
      workspaceId: 'workspace-2',
    })
    expect(storagePlan(otherWorkspace, 'other workspace').partition).not.toEqual(selfPartition)
  })

  it('fails closed without a workspace binding and never falls back to plugin scope', () => {
    const result = planPublicCapabilityCall(
      call('get', 'workspace'),
      policy(),
      context({ runtimeBinding: { ...binding, workspaceId: null } })
    )
    expect(result).toMatchObject({
      kind: 'deny',
      response: { error: { code: 'WORKSPACE_SCOPE_VIOLATION' } },
    })
    // A workspace request that cannot be bound must NOT silently become a plugin
    // partition — a denied result has no execution plan.
  })

  it('rejects caller-supplied partition identities in the request', () => {
    const spoofed = planPublicCapabilityCall(
      call('get', 'plugin', { pluginId: 'attacker', workspaceId: 'ws', packageVersion: '9.9.9' }),
      policy(),
      context()
    )
    expect(spoofed).toMatchObject({
      kind: 'deny',
      response: { error: { code: 'INVALID_ARGUMENT' } },
    })
  })

  it('reports stable quota errors for oversized keys and values', () => {
    const oversizedKey = planPublicCapabilityCall(
      call('get', 'plugin', { key: 'x'.repeat(STORAGE_LIMITS.maxKeyBytes + 1) }),
      policy(),
      context()
    )
    const oversizedValue = planPublicCapabilityCall(
      call('set', 'plugin', { value: 'x'.repeat(STORAGE_LIMITS.maxValueBytes) }),
      policy(),
      context()
    )
    expect(oversizedKey).toMatchObject({
      kind: 'deny',
      response: { error: { code: 'STORAGE_QUOTA_EXCEEDED' } },
    })
    expect(oversizedValue).toMatchObject({
      kind: 'deny',
      response: { error: { code: 'STORAGE_QUOTA_EXCEEDED' } },
    })
  })

  it('requires a Host-managed storage grant before planning a partition', () => {
    const noGrant = planPublicCapabilityCall(
      call('set', 'plugin'),
      policy(),
      context({ userGrant: { packageVersion: '1.0.0', system: [] } })
    )
    expect(noGrant).toMatchObject({
      kind: 'deny',
      response: { error: { code: 'CAPABILITY_DENIED' } },
    })
  })

  it('selects the storage snapshot whose package version matches the binding', () => {
    const active = planPublicCapabilityCall(call('get', 'plugin'), policy(), context())
    const candidate = planPublicCapabilityCall(
      call('get', 'plugin'),
      policy(),
      context({
        runtimeBinding: { ...binding, packageVersion: '2.0.0' },
        userGrant: { packageVersion: '2.0.0', system: [], storage: true },
        storageSnapshotTier: 'candidate',
      })
    )
    const previous = planPublicCapabilityCall(
      call('get', 'plugin'),
      policy(),
      context({
        runtimeBinding: { ...binding, packageVersion: '0.9.0' },
        userGrant: { packageVersion: '0.9.0', system: [], storage: true },
        storageSnapshotTier: 'previous',
      })
    )
    expect(active.kind).toBe('allow')
    expect(candidate.kind).toBe('allow')
    expect(previous.kind).toBe('allow')
    if (active.kind !== 'allow' || candidate.kind !== 'allow' || previous.kind !== 'allow') return
    expect(storagePlan(active, 'active')).toMatchObject({
      snapshot: { tier: 'active', packageVersion: '1.0.0' },
    })
    expect(storagePlan(candidate, 'candidate')).toMatchObject({
      snapshot: { tier: 'candidate', packageVersion: '2.0.0' },
    })
    expect(storagePlan(previous, 'previous')).toMatchObject({
      snapshot: { tier: 'previous', packageVersion: '0.9.0' },
    })
  })

  it('fails closed when no storage snapshot matches the binding package version', () => {
    const result = planPublicCapabilityCall(
      call('get', 'plugin'),
      policy(),
      context({ runtimeBinding: { ...binding, packageVersion: '9.9.9' } })
    )
    expect(result).toMatchObject({
      kind: 'deny',
      response: { error: { code: 'CAPABILITY_DENIED' } },
    })
  })

  it('allows duplicate package versions across tiers when the selected tier matches', () => {
    const duplicateVersions = new Map<StorageSnapshotTier, string>([
      ['candidate', '1.0.0'],
      ['active', '1.0.0'],
    ])
    const result = planPublicCapabilityCall(
      call('get', 'plugin'),
      policy(),
      context({ storageSnapshots: duplicateVersions, storageSnapshotTier: 'candidate' })
    )
    expect(result).toMatchObject({
      kind: 'allow',
      plan: { storage: { snapshot: { tier: 'candidate', packageVersion: '1.0.0', pluginId } } },
    })
  })

  it('fails closed when the selected tier is absent or bound to another version', () => {
    expect(
      planPublicCapabilityCall(
        call('get', 'plugin'),
        policy(),
        context({ storageSnapshotTier: 'candidate', storageSnapshots: new Map([['active', '1.0.0']]) })
      )
    ).toMatchObject({ kind: 'deny', response: { error: { code: 'CAPABILITY_DENIED' } } })
    expect(
      planPublicCapabilityCall(
        call('get', 'plugin'),
        policy(),
        context({ storageSnapshotTier: 'candidate', storageSnapshots: new Map([['candidate', '2.0.0']]) })
      )
    ).toMatchObject({ kind: 'deny', response: { error: { code: 'CAPABILITY_DENIED' } } })
  })

  it('rejects a raw storage path as partition identity', () => {
    const result = planPublicCapabilityCall(
      call('get', 'plugin', { path: '/etc/secrets.json' }),
      policy(),
      context()
    )
    expect(result).toMatchObject({
      kind: 'deny',
      response: { error: { code: 'INVALID_ARGUMENT' } },
    })
  })
})

describe('agent initiator caller (plan B1-b)', () => {
  const base = { kind: 'agent', source: 'mcp', id: 'a-1' }
  it('keeps the three-key agent and the user initiators exactly as before', () => {
    expect(isAuthenticatedInitiator(base)).toBe(true)
    expect(isAuthenticatedInitiator({ kind: 'user', id: 'u' })).toBe(true)
    expect(isAuthenticatedInitiator({ kind: 'user', id: 'u', caller: null })).toBe(false)
  })

  it('accepts a pane caller verified to the pane, and external or host callers verified to their kind', () => {
    expect(isAuthenticatedInitiator({ ...base, caller: { kind: 'pane', paneId: 'p-1', workspace: '/w', verifiedTo: 'pane' } })).toBe(true)
    expect(isAuthenticatedInitiator({ ...base, caller: { kind: 'pane', paneId: 'p-1', workspace: null, verifiedTo: 'pane' } })).toBe(true)
    expect(isAuthenticatedInitiator({ ...base, caller: { kind: 'external', paneId: null, workspace: null, verifiedTo: 'caller-kind' } })).toBe(true)
    expect(isAuthenticatedInitiator({ ...base, caller: { kind: 'host', paneId: null, workspace: null, verifiedTo: 'caller-kind' } })).toBe(true)
  })

  it('refuses a caller that claims more than it can prove', () => {
    for (const caller of [
      { kind: 'external', paneId: 'p-1', workspace: null, verifiedTo: 'caller-kind' },
      { kind: 'external', paneId: null, workspace: null, verifiedTo: 'pane' },
      { kind: 'pane', paneId: '', workspace: null, verifiedTo: 'pane' },
      { kind: 'pane', paneId: 'p-1', workspace: null, verifiedTo: 'caller-kind' },
      { kind: 'pane', paneId: 'p-1', workspace: null, verifiedTo: 'pane', model: 'x' },
      { kind: 'user', paneId: null, workspace: null, verifiedTo: 'caller-kind' },
      null,
    ]) {
      expect(isAuthenticatedInitiator({ ...base, caller })).toBe(false)
    }
  })
})

describe('agent initiator pane', () => {
  const base = { kind: 'agent', source: 'mcp', id: 'a-1' }
  const caller = { kind: 'pane', paneId: 'p-1', workspace: '/w', verifiedTo: 'pane' }

  it('accepts the calling pane name or id next to the agent keys, with or without a caller', () => {
    expect(isAuthenticatedInitiator({ ...base, pane: 'Reviewer' })).toBe(true)
    expect(isAuthenticatedInitiator({ ...base, pane: 'p-1', caller })).toBe(true)
    expect(isAuthenticatedInitiator({ ...base, pane: 'x'.repeat(200) })).toBe(true)
  })

  it('refuses an empty, oversized or non-string pane, a pane on a user, and any other extra key', () => {
    for (const pane of ['', '   ', 'x'.repeat(201), 7, null, { id: 'p-1' }]) {
      expect(isAuthenticatedInitiator({ ...base, pane })).toBe(false)
    }
    expect(isAuthenticatedInitiator({ kind: 'user', id: 'u', pane: 'Reviewer' })).toBe(false)
    expect(isAuthenticatedInitiator({ ...base, pane: 'Reviewer', token: 't' })).toBe(false)
    expect(isAuthenticatedInitiator({ ...base, pane: 'Reviewer', caller: null })).toBe(false)
  })
})
