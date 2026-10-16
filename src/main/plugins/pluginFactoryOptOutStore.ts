import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { fsyncFileSync, syncDirectorySync } from './fsSync'

const OPT_OUTS_FILE = '.navide-factory-plugin-opt-outs.json'

interface PersistedFactoryOptOutState {
  schemaVersion: 1
  pluginIds: string[]
}

interface ParsedFactoryOptOutState {
  state: PersistedFactoryOptOutState
  valid: boolean
}

function parseState(path: string): ParsedFactoryOptOutState {
  if (!existsSync(path)) {
    return { state: { schemaVersion: 1, pluginIds: [] }, valid: true }
  }
  try {
    const entry = lstatSync(path)
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('unsafe opt-out store')
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid state')
    const state = parsed as Record<string, unknown>
    if (
      state.schemaVersion !== 1 ||
      !Array.isArray(state.pluginIds) ||
      state.pluginIds.some((id) => typeof id !== 'string' || id.length === 0)
    ) {
      throw new Error('invalid state')
    }
    return {
      state: { schemaVersion: 1, pluginIds: [...new Set(state.pluginIds)] },
      valid: true,
    }
  } catch {
    return { state: { schemaVersion: 1, pluginIds: [] }, valid: false }
  }
}

export class PluginFactoryOptOutStore {
  private readonly file: string

  constructor(private readonly root: string, fileName = OPT_OUTS_FILE) {
    this.file = join(root, fileName)
  }

  has(pluginId: string): boolean {
    const parsed = parseState(this.file)
    if (!parsed.valid) {
      console.warn(`[plugins] invalid factory opt-out state at ${this.file}; ignoring it`)
      return false
    }
    return parsed.state.pluginIds.includes(pluginId)
  }

  add(pluginId: string): void {
    if (!pluginId) throw new Error('invalid plugin id')
    const parsed = parseState(this.file)
    const state = parsed.state
    if (state.pluginIds.includes(pluginId)) return
    state.pluginIds.push(pluginId)
    this.write(state)
  }

  remove(pluginId: string): void {
    const parsed = parseState(this.file)
    if (!parsed.valid) {
      this.write({ schemaVersion: 1, pluginIds: [] })
      return
    }
    const state = parsed.state
    const pluginIds = state.pluginIds.filter((id) => id !== pluginId)
    if (pluginIds.length === state.pluginIds.length) return
    this.write({ schemaVersion: 1, pluginIds })
  }

  private write(state: PersistedFactoryOptOutState): void {
    mkdirSync(this.root, { recursive: true, mode: 0o700 })
    const temporary = `${this.file}.${randomUUID()}.tmp`
    try {
      writeFileSync(temporary, `${JSON.stringify(state)}\n`, { encoding: 'utf8', mode: 0o600 })
      chmodSync(temporary, 0o600)
      fsyncFileSync(temporary)
      renameSync(temporary, this.file)
      chmodSync(this.file, 0o600)
      syncDirectorySync(this.root)
    } finally {
      rmSync(temporary, { force: true })
    }
  }
}
