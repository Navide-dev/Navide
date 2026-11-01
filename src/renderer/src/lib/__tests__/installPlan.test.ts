import { describe, expect, it } from 'vitest'
import { manualPrerequisites, missingProviders, orderInstalls, providerFor } from '../installPlan'
import type { OnboardDep } from '../../composables/useOnboarding'

const base = {
  description: '', version: '', min_version: '', optional: false, needs_terminal: false,
  can_install: true, docs_url: '', binary_path: '', resolved_path: '', install_method: '',
  update_cmd: '', doctor_cmd: '', autoupdate_env: '', autoupdate_policy: '',
} as const

function dep(over: Partial<OnboardDep> & { id: string }): OnboardDep {
  return {
    ...base,
    label: over.id,
    group: 'agent_cli',
    status: 'missing',
    ...over,
  } as OnboardDep
}

/** A bare Mac: nothing installed, Claude needs npm, Node needs brew. */
function bareMac() {
  const homebrew = dep({ id: 'homebrew', group: 'foundation', requirements: [{ name: 'curl', ok: true }] })
  const node = dep({ id: 'node', group: 'foundation', requirements: [{ name: 'brew', ok: false }] })
  const claude = dep({ id: 'claude', requirements: [{ name: 'npm', ok: false }] })
  return { homebrew, node, claude, all: [homebrew, node, claude] }
}

describe('providerFor', () => {
  it('maps bootstrap binaries to the dep that installs them', () => {
    const { all, homebrew, node } = bareMac()
    expect(providerFor('brew', all)).toBe(homebrew)
    expect(providerFor('npm', all)).toBe(node)
  })

  it('has no provider for binaries the registry does not ship', () => {
    // curl is part of macOS; the backend's bootstrap gate reports it instead.
    expect(providerFor('curl', bareMac().all)).toBeUndefined()
  })
})

describe('missingProviders', () => {
  it('lists only prerequisites that are both unmet and installable here', () => {
    const { claude, node, all } = bareMac()
    expect(missingProviders(claude, all)).toEqual([node])
  })

  it('ignores prerequisites that are already satisfied', () => {
    const all = [dep({ id: 'claude', requirements: [{ name: 'npm', ok: true }] }), dep({ id: 'node', group: 'foundation' })]
    expect(missingProviders(all[0], all)).toEqual([])
  })

  it('ignores a provider that is already installed', () => {
    const node = dep({ id: 'node', group: 'foundation', status: 'ok' })
    const claude = dep({ id: 'claude', requirements: [{ name: 'npm', ok: false }] })
    expect(missingProviders(claude, [node, claude])).toEqual([])
  })

  it('treats a dep with no requirements as unblocked', () => {
    expect(missingProviders(dep({ id: 'grok' }), [])).toEqual([])
  })
})

describe('orderInstalls', () => {
  it('walks the whole chain prerequisites-first', () => {
    // The point of the whole module: picking Claude Code on a bare Mac must
    // produce Homebrew → Node → Claude, not "install Claude" then exit 127.
    const { claude, all } = bareMac()
    expect(orderInstalls([claude], all).map((d) => d.id)).toEqual(['homebrew', 'node', 'claude'])
  })

  it('pulls in prerequisites that were not among the targets', () => {
    const { claude, all } = bareMac()
    const plan = orderInstalls([claude], all)
    expect(plan).toHaveLength(3)
    expect(plan.map((d) => d.id)).toContain('homebrew')
  })

  it('stops at the first satisfied link in the chain', () => {
    const homebrew = dep({ id: 'homebrew', group: 'foundation', status: 'ok' })
    const node = dep({ id: 'node', group: 'foundation', requirements: [{ name: 'brew', ok: true }] })
    const claude = dep({ id: 'claude', requirements: [{ name: 'npm', ok: false }] })
    expect(orderInstalls([claude], [homebrew, node, claude]).map((d) => d.id)).toEqual(['node', 'claude'])
  })

  it('drops deps that are installed or cannot be installed from here', () => {
    const installed = dep({ id: 'codex', status: 'ok' })
    const manual = dep({ id: 'cursor', can_install: false })
    const claude = dep({ id: 'claude' })
    expect(orderInstalls([installed, manual, claude], []).map((d) => d.id)).toEqual(['claude'])
  })

  it('lists each dep once even when several targets share a prerequisite', () => {
    const { homebrew, node, all } = bareMac()
    const qwen = dep({ id: 'qwen', requirements: [{ name: 'npm', ok: false }] })
    const claude = all[2]
    const plan = orderInstalls([claude, qwen], [homebrew, node, claude, qwen])
    expect(plan.map((d) => d.id)).toEqual(['homebrew', 'node', 'claude', 'qwen'])
  })

  it('preserves the order the targets were given in', () => {
    const a = dep({ id: 'grok' })
    const b = dep({ id: 'kimi' })
    expect(orderInstalls([b, a], [a, b]).map((d) => d.id)).toEqual(['kimi', 'grok'])
  })

  it('survives a circular prerequisite declaration', () => {
    // Not reachable from the real registry, but a bad edit must not hang the UI.
    const brewDep = dep({ id: 'homebrew', group: 'foundation', requirements: [{ name: 'npm', ok: false }] })
    const nodeDep = dep({ id: 'node', group: 'foundation', requirements: [{ name: 'brew', ok: false }] })
    const plan = orderInstalls([nodeDep], [brewDep, nodeDep])
    expect(plan.map((d) => d.id).sort()).toEqual(['homebrew', 'node'])
  })

  it('returns nothing when there is nothing left to install', () => {
    expect(orderInstalls([dep({ id: 'claude', status: 'ok' })], [])).toEqual([])
  })
})

describe('manualPrerequisites', () => {
  it('has nothing to say when the whole chain can run', () => {
    const { claude, all } = bareMac()
    expect(manualPrerequisites(claude, all)).toEqual([])
  })

  it('has nothing to say when every requirement is met', () => {
    const claude = dep({ id: 'claude', requirements: [{ name: 'npm', ok: true }] })
    expect(manualPrerequisites(claude, [claude])).toEqual([])
  })

  it('names a provider with no install command, with its docs', () => {
    const node = dep({ id: 'node', label: 'Node.js', can_install: false, docs_url: 'https://nodejs.org' })
    const claude = dep({ id: 'claude', requirements: [{ name: 'npm', ok: false }] })
    expect(manualPrerequisites(claude, [node, claude])).toEqual([{ name: 'Node.js', url: 'https://nodejs.org' }])
  })

  it('names a binary no dep provides, with no url to offer', () => {
    const aider = dep({ id: 'aider', requirements: [{ name: 'curl', ok: false }] })
    expect(manualPrerequisites(aider, [aider])).toEqual([{ name: 'curl', url: '' }])
  })

  it('reports a link that cannot run as itself, further down the chain', () => {
    // brew install node on a machine that could not get Homebrew: the user needs
    // Homebrew, whose own installer is what needs the missing curl.
    const homebrew = dep({ id: 'homebrew', label: 'Homebrew', docs_url: 'https://brew.sh',
      requirements: [{ name: 'curl', ok: false }] })
    const node = dep({ id: 'node', requirements: [{ name: 'brew', ok: false }] })
    const claude = dep({ id: 'claude', requirements: [{ name: 'npm', ok: false }] })
    expect(manualPrerequisites(claude, [homebrew, node, claude])).toEqual([
      { name: 'Homebrew', url: 'https://brew.sh' },
    ])
  })

  it('ignores a provider that is already installed', () => {
    const node = dep({ id: 'node', status: 'ok', can_install: false })
    const claude = dep({ id: 'claude', requirements: [{ name: 'npm', ok: false }] })
    expect(manualPrerequisites(claude, [node, claude])).toEqual([])
  })

  it('lists a shared blocker once and survives a circular declaration', () => {
    const a = dep({ id: 'homebrew', requirements: [{ name: 'npm', ok: false }, { name: 'curl', ok: false }] })
    const b = dep({ id: 'node', requirements: [{ name: 'brew', ok: false }, { name: 'curl', ok: false }] })
    expect(manualPrerequisites(b, [a, b]).map((m) => m.name)).toEqual(['homebrew', 'curl'])
  })
})
