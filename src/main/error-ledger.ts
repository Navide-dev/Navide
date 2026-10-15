import { appendFileSync, mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The main process's end of the on-disk error ledger
 * (`<data dir>/logs/errors.jsonl`), which the backend owns: same JSON-lines
 * format as `backend/agent_team_backend/error_ledger.py`, read back by the
 * `ui_diagnostics` MCP tool as `persisted`. Main only appends; rotation is the
 * backend's. Main still writes while the backend is down, which is when a
 * backend crash needs recording most.
 */

/** Past this size main stops appending: the backend rotates at 512 KB, so a
 *  file this large means nobody is rotating it. Keeps a fault loop bounded. */
export const MAIN_LEDGER_SKIP_BYTES = 4 * 1024 * 1024
const MAX_MESSAGE = 2000

let configuredDataDir: string | null = null

/** The data dir for callers that do not know it (plugin hosts); index.ts sets
 *  it at startup. Null turns those callers' recording off. */
export function setMainLedgerDataDir(dir: string | null): void {
  configuredDataDir = dir
}

/** Append one main-process fault. Best effort: returns false instead of
 *  throwing, since a ledger that fails must not turn one fault into two. */
export function recordMainFault(code: string, message: string, dataDir: string | null = configuredDataDir): boolean {
  if (!dataDir) return false
  try {
    const dir = join(dataDir, 'logs')
    const path = join(dir, 'errors.jsonl')
    mkdirSync(dir, { recursive: true })
    try {
      if (statSync(path).size > MAIN_LEDGER_SKIP_BYTES) return false
    } catch {
      /* no ledger yet */
    }
    const entry = {
      ts: new Date().toISOString(),
      source: 'main',
      level: 'error',
      code: code.slice(0, 200),
      message: message.slice(0, MAX_MESSAGE),
    }
    appendFileSync(path, `${JSON.stringify(entry)}\n`, 'utf8')
    return true
  } catch {
    return false
  }
}
