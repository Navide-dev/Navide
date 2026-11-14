// Which version of a repository's .navide/workbench.json the user accepted.
//
// The repository file is untrusted: reading it changes nothing, it applies only
// once the user accepts the exact content they reviewed, and any later change
// takes it out of effect. Acceptance lives in userData, never in the repository.
//
// The file is read the way ExecutionPolicySourceStore reads its own. That read
// is copied, not shared, so this feature cannot disturb the policy store;
// workbenchSourceStore.test.ts holds the two to the same verdicts.
import { createHash } from 'node:crypto'
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
} from 'node:fs'
import { join } from 'node:path'
import { canonicalExistingDirectory, resolveWorkspaceRelativePath } from './workspacePathPolicy'
import { OwnerOnlyJsonPersistence } from './ownerOnlyJsonPersistence'
import {
  parseProjectWorkbench,
  type ProjectWorkbench,
  type ProjectWorkbenchResult,
  type ProjectWorkbenchSnapshot,
} from '../../shared/projectWorkbench'

export const REPOSITORY_WORKBENCH_PATH = '.navide/workbench.json'
export const WORKBENCH_SOURCES_DIRECTORY = 'workbench-sources'
export const WORKBENCH_SOURCES_FILE = 'sources.json'

const REPOSITORY_DIRECTORY = '.navide'
const REPOSITORY_FILE = 'workbench.json'
const MAX_REPOSITORY_BYTES = 256 * 1024
const MAX_STATE_BYTES = 256 * 1024
const NO_FOLLOW_FLAG = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW
const FINGERPRINT = /^[0-9a-f]{64}$/

type Recommendation =
  | { state: 'missing' | 'invalid' | 'unavailable' }
  | { state: 'valid'; workbench: ProjectWorkbench; fingerprint: string }

type FileRead = { kind: 'text'; value: string } | { kind: 'missing' | 'invalid' | 'unavailable' }

interface WorkspaceSelection {
  accepted?: string
  notified?: string
}

interface SourcesState {
  schemaVersion: 1
  workspaces: Record<string, WorkspaceSelection>
}

/** `unreadable`: there may be state, and it could not be read. Reads as nothing
 *  accepted, and must not be written over: that would lose what is in it. */
type StateRead = { kind: 'ready'; state: SourcesState } | { kind: 'unreadable' }

class FileTooLargeError extends Error {}

function isMissingError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

function isUnavailableError(error: unknown): boolean {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : ''
  return ['EACCES', 'EBUSY', 'EIO', 'EMFILE', 'ENFILE', 'ENOSPC', 'EPERM', 'ETIMEDOUT'].includes(code)
}

function sameFileSnapshot(
  left: { dev: number; ino: number; mode: number; size: number },
  right: { dev: number; ino: number; mode: number; size: number },
): boolean {
  return left.dev === right.dev && left.ino === right.ino &&
    left.mode === right.mode && left.size === right.size
}

function readBoundedUtf8(fd: number, initialSize: number, maximumBytes: number): string {
  if (!Number.isSafeInteger(initialSize) || initialSize < 0 || initialSize > maximumBytes) {
    throw new FileTooLargeError()
  }
  const chunks: Buffer[] = []
  const buffer = Buffer.alloc(Math.min(64 * 1024, maximumBytes + 1))
  let total = 0
  while (true) {
    const count = readSync(fd, buffer, 0, buffer.length, null)
    if (count === 0) break
    total += count
    if (total > maximumBytes) throw new FileTooLargeError()
    chunks.push(Buffer.from(buffer.subarray(0, count)))
  }
  return Buffer.concat(chunks, total).toString('utf8')
}

function readRepositoryFile(file: string, canonicalFile: string): FileRead {
  let fileEntry
  try {
    fileEntry = lstatSync(file)
  } catch (error) {
    if (isMissingError(error)) return { kind: 'missing' }
    return { kind: isUnavailableError(error) ? 'unavailable' : 'invalid' }
  }
  if (!fileEntry.isFile() || fileEntry.isSymbolicLink()) return { kind: 'invalid' }

  let fd: number | undefined
  let result: FileRead = { kind: 'invalid' }
  try {
    fd = openSync(canonicalFile, constants.O_RDONLY | constants.O_NONBLOCK | NO_FOLLOW_FLAG)
    const opened = fstatSync(fd)
    if (!opened.isFile() || opened.isSymbolicLink() || !sameFileSnapshot(fileEntry, opened)) {
      throw new Error('workbench.json changed while opening')
    }
    const value = readBoundedUtf8(fd, opened.size, MAX_REPOSITORY_BYTES)
    if (!sameFileSnapshot(opened, fstatSync(fd))) throw new Error('workbench.json changed while reading')
    result = { kind: 'text', value }
  } catch (error) {
    result = { kind: isUnavailableError(error) ? 'unavailable' : 'invalid' }
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        result = { kind: 'unavailable' }
      }
    }
  }
  return result
}

function readRecommendation(workspace: string): Recommendation {
  const directory = join(workspace, REPOSITORY_DIRECTORY)
  let directoryEntry
  try {
    directoryEntry = lstatSync(directory)
  } catch (error) {
    if (isMissingError(error)) return { state: 'missing' }
    return { state: isUnavailableError(error) ? 'unavailable' : 'invalid' }
  }
  if (!directoryEntry.isDirectory() || directoryEntry.isSymbolicLink()) return { state: 'invalid' }

  const file = join(directory, REPOSITORY_FILE)
  let fileEntry
  try {
    fileEntry = lstatSync(file)
  } catch (error) {
    if (isMissingError(error)) return { state: 'missing' }
    return { state: isUnavailableError(error) ? 'unavailable' : 'invalid' }
  }
  if (!fileEntry.isFile() || fileEntry.isSymbolicLink()) return { state: 'invalid' }

  const canonicalFile = resolveWorkspaceRelativePath(workspace, REPOSITORY_WORKBENCH_PATH)
  if (!canonicalFile) return { state: 'invalid' }

  const read = readRepositoryFile(file, canonicalFile)
  if (read.kind !== 'text') return { state: read.kind }
  try {
    const workbench = parseProjectWorkbench(read.value)
    // Over the parsed value, as the policy's fingerprint is: reformatting the
    // file changes nothing the user reviewed, and the review shows this value.
    const fingerprint = createHash('sha256').update(JSON.stringify(workbench), 'utf8').digest('hex')
    return { state: 'valid', workbench, fingerprint }
  } catch {
    return { state: 'invalid' }
  }
}

function parseState(value: unknown): SourcesState | null {
  if (typeof value !== 'object' || value === null) return null
  const { schemaVersion, workspaces } = value as Partial<SourcesState>
  if (schemaVersion !== 1 || typeof workspaces !== 'object' || workspaces === null) return null
  return { schemaVersion: 1, workspaces }
}

export class WorkbenchSourceStore {
  private readonly persistence: OwnerOnlyJsonPersistence
  private readonly stateFile: string

  constructor(userDataPath: string) {
    const directory = join(userDataPath, WORKBENCH_SOURCES_DIRECTORY)
    this.persistence = new OwnerOnlyJsonPersistence(directory, MAX_STATE_BYTES, MAX_STATE_BYTES)
    this.stateFile = join(directory, WORKBENCH_SOURCES_FILE)
  }

  /** Reading is free of effects: it writes nothing and applies nothing. */
  inspect(workspacePath: string): ProjectWorkbenchSnapshot {
    const workspace = canonicalExistingDirectory(workspacePath)
    if (!workspace) return this.snapshot({ state: 'missing' }, {})
    const read = this.readState()
    const selection = read.kind === 'ready' ? read.state.workspaces[workspace] ?? {} : {}
    return this.snapshot(readRecommendation(workspace), selection)
  }

  /** Accepts exactly what the user reviewed: a file that changed meanwhile is
   *  refused, so a review can never stand in for content nobody saw. */
  accept(workspacePath: string, expectedFingerprint: string): ProjectWorkbenchResult {
    const workspace = canonicalExistingDirectory(workspacePath)
    if (!workspace) return { ok: false, reason: 'unavailable', snapshot: this.inspect(workspacePath) }
    const recommendation = readRecommendation(workspace)
    if (recommendation.state !== 'valid' || recommendation.fingerprint !== expectedFingerprint) {
      return { ok: false, reason: 'stale', snapshot: this.inspect(workspace) }
    }
    return this.update(workspace, { accepted: expectedFingerprint, notified: expectedFingerprint })
  }

  /** Stop applying this repository's suggestions. The repository is not touched. */
  revoke(workspacePath: string): ProjectWorkbenchResult {
    const workspace = canonicalExistingDirectory(workspacePath)
    if (!workspace) return { ok: false, reason: 'unavailable', snapshot: this.inspect(workspacePath) }
    const read = this.readState()
    // Nothing accepted, nothing to undo: a project with no file leaves no trace.
    if (read.kind === 'ready' && !read.state.workspaces[workspace]?.accepted) {
      return { ok: true, snapshot: this.inspect(workspace) }
    }
    return this.update(workspace, { accepted: undefined })
  }

  /** The reminder for this exact content has been shown. */
  markNotified(workspacePath: string, fingerprint: string): ProjectWorkbenchResult {
    const workspace = canonicalExistingDirectory(workspacePath)
    if (!workspace) return { ok: false, reason: 'unavailable', snapshot: this.inspect(workspacePath) }
    if (!FINGERPRINT.test(fingerprint)) return { ok: false, reason: 'stale', snapshot: this.inspect(workspace) }
    const recommendation = readRecommendation(workspace)
    if (recommendation.state !== 'valid' || recommendation.fingerprint !== fingerprint) {
      return { ok: false, reason: 'stale', snapshot: this.inspect(workspace) }
    }
    return this.update(workspace, { notified: fingerprint })
  }

  private snapshot(recommendation: Recommendation, selection: WorkspaceSelection): ProjectWorkbenchSnapshot {
    const closed = { fingerprint: null, recommendation: null, active: null, shouldNotify: false }
    if (recommendation.state !== 'valid') {
      return { status: recommendation.state === 'missing' ? 'none' : recommendation.state, ...closed }
    }
    const { workbench, fingerprint } = recommendation
    const open = { fingerprint, recommendation: workbench }
    if (selection.accepted === fingerprint) {
      return { status: 'accepted', ...open, active: workbench, shouldNotify: false }
    }
    return {
      status: selection.accepted ? 'stale' : 'pending',
      ...open,
      active: null,
      shouldNotify: selection.notified !== fingerprint,
    }
  }

  private readState(): StateRead {
    const empty: StateRead = { kind: 'ready', state: { schemaVersion: 1, workspaces: {} } }
    const directory = this.persistence.ensureDirectory(false)
    if (directory === 'missing') return empty
    if (directory !== 'ready') return { kind: 'unreadable' }
    const read = this.persistence.read(this.stateFile, 'workbench sources')
    if (read.kind === 'missing') return empty
    const state = read.kind === 'present' ? parseState(read.value) : null
    return state ? { kind: 'ready', state } : { kind: 'unreadable' }
  }

  private update(workspace: string, change: Partial<WorkspaceSelection>): ProjectWorkbenchResult {
    const read = this.readState()
    if (read.kind !== 'ready') return { ok: false, reason: 'source-state-corrupt', snapshot: this.inspect(workspace) }
    const { state } = read
    const next: WorkspaceSelection = { ...state.workspaces[workspace], ...change }
    if (next.accepted === undefined) delete next.accepted
    state.workspaces[workspace] = next
    try {
      if (this.persistence.ensureDirectory() !== 'ready') throw new Error('workbench sources directory is unavailable')
      this.persistence.write(this.stateFile, state)
    } catch {
      return { ok: false, reason: 'unavailable', snapshot: this.inspect(workspace) }
    }
    return { ok: true, snapshot: this.inspect(workspace) }
  }
}
