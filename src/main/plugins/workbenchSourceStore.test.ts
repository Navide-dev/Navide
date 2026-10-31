import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ExecutionPolicySourceStore } from './executionPolicySourceStore'
import { WORKBENCH_SOURCES_DIRECTORY, WorkbenchSourceStore } from './workbenchSourceStore'
import { parseProjectWorkbench } from '../../shared/projectWorkbench'

// A file swapped between open and the end of the read shows as a different
// size on the later fstat. Keyed on inode, so state files read alongside it
// are left alone.
const fsHook = vi.hoisted(() => ({ ino: 0, calls: 0 }))
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>()
  const fstatSync: typeof real.fstatSync = ((fd: number, ...rest: []) => {
    const stats = real.fstatSync(fd, ...rest)
    if (fsHook.ino === 0 || stats.ino !== fsHook.ino) return stats
    fsHook.calls += 1
    return fsHook.calls >= 2 ? Object.assign(Object.create(stats), { size: stats.size + 1 }) : stats
  }) as typeof real.fstatSync
  return { ...real, default: { ...real, fstatSync }, fstatSync }
})

const POLICY = { schemaVersion: 1, mode: 'allowlist', system: ['fs'], shell: ['git'] }
const FILE = {
  schemaVersion: 1,
  layoutMode: 'grid',
  plugins: [{ id: 'acme.runner', version: '^1.0.0' }],
  buttons: [{ id: 'a', label: 'Open', steps: [{ action: 'ui.window.openPlans' }] }],
}

let root: string
let userData: string
let repo: string
let store: WorkbenchSourceStore

const write = (value: unknown, name = 'workbench.json'): void => {
  mkdirSync(join(repo, '.navide'), { recursive: true })
  writeFileSync(join(repo, '.navide', name), typeof value === 'string' ? value : JSON.stringify(value))
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'workbench-sources-'))
  userData = join(root, 'userData')
  repo = join(root, 'repo')
  mkdirSync(userData)
  mkdirSync(repo)
  store = new WorkbenchSourceStore(userData)
  fsHook.ino = 0
  fsHook.calls = 0
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('a repository with no file', () => {
  it('reads as none and writes nothing anywhere', () => {
    expect(store.inspect(repo)).toEqual({
      status: 'none', fingerprint: null, recommendation: null, active: null, shouldNotify: false,
    })
    expect(readdirSync(userData)).toEqual([])
    expect(readdirSync(repo)).toEqual([])
  })

  it('stays none with the .navide folder present for something else', () => {
    write({ schema: 'navide-devmap/1' }, 'devmap.json')
    expect(store.inspect(repo).status).toBe('none')
  })
})

describe('reviewing and accepting', () => {
  it('applies nothing until accepted', () => {
    write(FILE)
    const snapshot = store.inspect(repo)
    expect(snapshot.status).toBe('pending')
    expect(snapshot.recommendation).toEqual(FILE)
    expect(snapshot.active).toBeNull()
    expect(snapshot.shouldNotify).toBe(true)
  })

  it('inspecting changes nothing, in the repository or in userData', () => {
    write(FILE)
    const before = readFileSync(join(repo, '.navide', 'workbench.json'), 'utf8')
    store.inspect(repo)
    expect(readFileSync(join(repo, '.navide', 'workbench.json'), 'utf8')).toBe(before)
    expect(readdirSync(userData)).toEqual([])
  })

  it('applies what was accepted, across a restart', () => {
    write(FILE)
    const { fingerprint } = store.inspect(repo)
    expect(store.accept(repo, fingerprint!).ok).toBe(true)
    const again = new WorkbenchSourceStore(userData).inspect(repo)
    expect(again.status).toBe('accepted')
    expect(again.active).toEqual(FILE)
    expect(again.shouldNotify).toBe(false)
  })

  it('refuses a fingerprint that is not the file on disk', () => {
    write(FILE)
    const { fingerprint } = store.inspect(repo)
    write({ ...FILE, layoutMode: 'spotlight' })
    const result = store.accept(repo, fingerprint!)
    expect(result).toMatchObject({ ok: false, reason: 'stale' })
    expect(store.inspect(repo).active).toBeNull()
  })

  it('never writes to the repository', () => {
    write(FILE)
    const { fingerprint } = store.inspect(repo)
    store.accept(repo, fingerprint!)
    store.revoke(repo)
    expect(readdirSync(join(repo, '.navide'))).toEqual(['workbench.json'])
  })

  it('stops applying on revoke', () => {
    write(FILE)
    store.accept(repo, store.inspect(repo).fingerprint!)
    store.revoke(repo)
    expect(store.inspect(repo)).toMatchObject({ status: 'pending', active: null })
  })

  it('keeps state owner-only', () => {
    write(FILE)
    store.accept(repo, store.inspect(repo).fingerprint!)
    if (process.platform === 'win32') return
    const file = join(userData, WORKBENCH_SOURCES_DIRECTORY, 'sources.json')
    expect(statSync(file).mode & 0o077).toBe(0)
  })

  it('keeps repositories apart', () => {
    write(FILE)
    store.accept(repo, store.inspect(repo).fingerprint!)
    const other = join(root, 'other')
    mkdirSync(join(other, '.navide'), { recursive: true })
    writeFileSync(join(other, '.navide', 'workbench.json'), JSON.stringify(FILE))
    expect(store.inspect(other).status).toBe('pending')
  })
})

describe('when the file changes after acceptance', () => {
  beforeEach(() => {
    write(FILE)
    store.accept(repo, store.inspect(repo).fingerprint!)
  })

  it('goes stale and applies nothing', () => {
    write({ ...FILE, buttons: [{ id: 'a', label: 'Open', steps: [{ action: 'workbench.action.closeActivePane' }] }] })
    expect(store.inspect(repo)).toMatchObject({ status: 'stale', active: null, shouldNotify: true })
  })

  it('applies nothing when the file breaks', () => {
    write('{ not json')
    expect(store.inspect(repo)).toMatchObject({ status: 'invalid', active: null })
  })

  it('applies nothing when the file goes away', () => {
    rmSync(join(repo, '.navide', 'workbench.json'))
    expect(store.inspect(repo)).toMatchObject({ status: 'none', active: null })
  })

  it('keeps acceptance through a change of formatting alone', () => {
    write(JSON.stringify(FILE, null, 4))
    expect(store.inspect(repo).status).toBe('accepted')
  })

  it('applies again once the accepted content is back', () => {
    write({ ...FILE, layoutMode: 'auto' })
    expect(store.inspect(repo).status).toBe('stale')
    write(FILE)
    expect(store.inspect(repo).status).toBe('accepted')
  })
})

describe('the reminder', () => {
  it('fires once for each content', () => {
    write(FILE)
    const { fingerprint, shouldNotify } = store.inspect(repo)
    expect(shouldNotify).toBe(true)
    store.markNotified(repo, fingerprint!)
    expect(store.inspect(repo).shouldNotify).toBe(false)
    write({ ...FILE, layoutMode: 'auto' })
    expect(store.inspect(repo).shouldNotify).toBe(true)
  })
})

describe('host state it cannot trust', () => {
  it('reads corrupt state as nothing accepted', () => {
    write(FILE)
    const fingerprint = store.inspect(repo).fingerprint!
    store.accept(repo, fingerprint)
    const file = join(userData, WORKBENCH_SOURCES_DIRECTORY, 'sources.json')
    chmodSync(file, 0o600)
    writeFileSync(file, 'nonsense')
    expect(store.inspect(repo)).toMatchObject({ status: 'pending', active: null })
  })
})

describe('state it could not read', () => {
  const stateFile = () => join(userData, WORKBENCH_SOURCES_DIRECTORY, 'sources.json')
  const corrupt = (content: string): void => {
    write(FILE)
    store.accept(repo, store.inspect(repo).fingerprint!)
    writeFileSync(stateFile(), content, { mode: 0o600 })
  }

  it.each([['not JSON', 'nonsense'], ['another schema', '{"schemaVersion":2,"workspaces":{}}']])(
    'refuses to write over %s', (_name, content) => {
      corrupt(content)
      const fingerprint = store.inspect(repo).fingerprint!
      expect(store.accept(repo, fingerprint)).toMatchObject({ ok: false, reason: 'source-state-corrupt' })
      expect(store.revoke(repo)).toMatchObject({ ok: false, reason: 'source-state-corrupt' })
      expect(store.markNotified(repo, fingerprint)).toMatchObject({ ok: false, reason: 'source-state-corrupt' })
      expect(readFileSync(stateFile(), 'utf8')).toBe(content)
    },
  )

  it('refuses to write when the state file cannot be read right now', () => {
    if (process.platform === 'win32') return
    corrupt('{"schemaVersion":1,"workspaces":{}}')
    chmodSync(join(userData, WORKBENCH_SOURCES_DIRECTORY), 0o000)
    const result = store.accept(repo, store.inspect(repo).fingerprint!)
    chmodSync(join(userData, WORKBENCH_SOURCES_DIRECTORY), 0o700)
    expect(result).toMatchObject({ ok: false })
    expect(readFileSync(stateFile(), 'utf8')).toBe('{"schemaVersion":1,"workspaces":{}}')
  })
})

describe('a project with no file leaves no trace', () => {
  it('revoke writes nothing', () => {
    expect(store.revoke(repo).ok).toBe(true)
    expect(readdirSync(userData)).toEqual([])
  })

  it('markNotified writes nothing', () => {
    expect(store.markNotified(repo, 'a'.repeat(64))).toMatchObject({ ok: false, reason: 'stale' })
    expect(readdirSync(userData)).toEqual([])
  })

  it('markNotified takes only a fingerprint, and only the one on disk', () => {
    write(FILE)
    expect(store.markNotified(repo, '../not-one').ok).toBe(false)
    expect(store.markNotified(repo, 'a'.repeat(64)).ok).toBe(false)
    expect(readdirSync(userData)).toEqual([])
  })

  it('revoke still undoes an acceptance whose file has gone', () => {
    write(FILE)
    store.accept(repo, store.inspect(repo).fingerprint!)
    rmSync(join(repo, '.navide', 'workbench.json'))
    expect(store.revoke(repo).ok).toBe(true)
    write(FILE)
    expect(store.inspect(repo).status).toBe('pending')
  })
})

// The read is a copy of ExecutionPolicySourceStore's, kept apart so this feature
// cannot disturb it. These hold the two to one verdict on the same hostile file.
describe('the same verdict as ExecutionPolicySourceStore', () => {
  const verdicts = (): { policy: string; workbench: string } => ({
    policy: new ExecutionPolicySourceStore(join(root, 'policyData')).inspectRepository(repo).state,
    workbench: store.inspect(repo).status,
  })
  const both = (make: (name: string, content: string) => void): void => {
    make('execution-policy.json', JSON.stringify(POLICY))
    make('workbench.json', JSON.stringify(FILE))
  }

  beforeEach(() => mkdirSync(join(root, 'policyData')))

  it('accepts a normal file', () => {
    both((name, content) => write(content, name))
    expect(verdicts()).toEqual({ policy: 'valid', workbench: 'pending' })
  })

  it('refuses a symlinked file', () => {
    if (process.platform === 'win32') return
    mkdirSync(join(repo, '.navide'))
    both((name, content) => {
      const target = join(root, `target-${name}`)
      writeFileSync(target, content)
      symlinkSync(target, join(repo, '.navide', name))
    })
    expect(verdicts()).toEqual({ policy: 'invalid', workbench: 'invalid' })
  })

  it('refuses a symlinked .navide folder', () => {
    if (process.platform === 'win32') return
    const target = join(root, 'elsewhere')
    mkdirSync(target)
    both((name, content) => writeFileSync(join(target, name), content))
    symlinkSync(target, join(repo, '.navide'))
    expect(verdicts()).toEqual({ policy: 'invalid', workbench: 'invalid' })
  })

  it('refuses a file over 256 KiB', () => {
    both((name) => write(' '.repeat(256 * 1024 + 1), name))
    expect(verdicts()).toEqual({ policy: 'invalid', workbench: 'invalid' })
  })

  it('refuses a file swapped while it is being read', () => {
    both((name, content) => write(content, name))
    const swap = (name: string): void => {
      fsHook.ino = statSync(join(repo, '.navide', name)).ino
      fsHook.calls = 0
    }
    swap('execution-policy.json')
    const policy = new ExecutionPolicySourceStore(join(root, 'policyData')).inspectRepository(repo).state
    swap('workbench.json')
    const workbench = store.inspect(repo).status
    expect({ policy, workbench }).toEqual({ policy: 'invalid', workbench: 'invalid' })
  })
})

describe('parseProjectWorkbench', () => {
  it('reads a file with nothing in it', () => {
    expect(parseProjectWorkbench('{"schemaVersion":1}')).toEqual({ schemaVersion: 1 })
  })

  it.each([
    ['not JSON', 'nope'],
    ['a wrong version', '{"schemaVersion":2}'],
    ['an unknown field', '{"schemaVersion":1,"shell":"rm -rf /"}'],
    ['a layout mode that does not exist', '{"schemaVersion":1,"layoutMode":"huge"}'],
    ['a plugin id that is not one', '{"schemaVersion":1,"plugins":[{"id":"../evil"}]}'],
    ['a label with markup', '{"schemaVersion":1,"buttons":[{"id":"a","label":"<b>","steps":[{"action":"x"}]}]}'],
    ['a button with no steps', '{"schemaVersion":1,"buttons":[{"id":"a","label":"Go","steps":[]}]}'],
    ['a step with args', '{"schemaVersion":1,"buttons":[{"id":"a","label":"Go","steps":[{"action":"ui.settings.yolo","args":{"yolo":true}}]}]}'],
    ['a duplicate button id', '{"schemaVersion":1,"buttons":[{"id":"a","label":"A","steps":[{"action":"x"}]},{"id":"a","label":"B","steps":[{"action":"x"}]}]}'],
  ])('refuses %s', (_name, content) => {
    expect(() => parseProjectWorkbench(content)).toThrow()
  })
})
