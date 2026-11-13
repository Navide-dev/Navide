import { spawn, execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { describe, expect, it } from 'vitest'
import { createWsClient, type TerminalOutputFrame } from '../../src/shared/wsClient'

const python = resolve('backend', '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')

// The driver's BackendProcess enforces its own startup budget
// (_STARTUP_TIMEOUT_S in backend/tests/cli_regression/support/backend_process.py,
// which mirrors the app's health-check default) and exits non-zero with the
// backend log when it is exceeded. This outer wait is only a backstop on top of
// it, so it must never be the stricter of the two: a fixed 35s here failed a
// healthy Windows backend that the harness and the app would both accept.
const HARNESS_STARTUP_BUDGET_MS = (process.platform === 'linux' ? 120 : 45) * 1000
// Interpreter start and harness imports before BackendProcess starts timing.
const DRIVER_STARTUP_MARGIN_MS = 15_000
const READY_TIMEOUT_MS = HARNESS_STARTUP_BUDGET_MS + DRIVER_STARTUP_MARGIN_MS

// Reuse the backend suite's isolation, fake CLI, readiness and process-tree
// cleanup. Only the external wire client differs: this is Navide's real TS
// client and binary decoder talking to the real Python dispatch/PTY service.
const driver = `
import asyncio, json, sys
from pathlib import Path
from tests.cli_regression.support.backend_process import BackendProcess
async def main():
    root = Path(sys.argv[1])
    async with BackendProcess(root) as backend:
        endpoint = root / "wire.pending.json"
        endpoint.write_text(json.dumps({"url": backend.url, "command": backend.fake_command()}), encoding="utf-8")
        endpoint.replace(root / "wire.json")
        await asyncio.to_thread(sys.stdin.readline)
asyncio.run(main())
`

async function until(predicate: () => boolean, message: string, timeout = 15_000): Promise<void> {
  const deadline = Date.now() + timeout
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message)
    await delay(20)
  }
}

describe('frontend/backend CLI wire regression', () => {
  it('reconnects the production wsClient to the same PTY and decodes Unicode output', async () => {
    expect(existsSync(python), 'run uv --project backend sync --locked first').toBe(true)
    const root = mkdtempSync(join(tmpdir(), 'navide-cli-wire-'))
    const child = spawn(python, ['-c', driver, root], {
      cwd: resolve('backend'), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    })
    let driverLog = ''
    let exitCode: number | null | undefined
    child.stdout.on('data', (data) => { driverLog += data })
    child.stderr.on('data', (data) => { driverLog += data })
    child.once('error', (error) => { driverLog += error.message; exitCode = -1 })
    child.once('exit', (code) => { exitCode = code })
    let connections = 0
    const client = createWsClient({ onStatus: (status) => { if (status === 'connected') connections++ } })
    const output = new Map<string, string>()
    const decoders = new Map<string, TextDecoder>()
    client.on('terminal.output', (payload) => {
      const frame = payload as TerminalOutputFrame
      const decoder = decoders.get(frame.terminal_session_id) ?? new TextDecoder()
      decoders.set(frame.terminal_session_id, decoder)
      output.set(frame.terminal_session_id, (output.get(frame.terminal_session_id) ?? '') + decoder.decode(frame.data, { stream: true }))
    })
    try {
      await until(() => {
        if (exitCode !== undefined) throw new Error(`backend driver exited: ${driverLog}`)
        return existsSync(join(root, 'wire.json'))
      }, 'isolated backend did not become ready', READY_TIMEOUT_MS)
      // The driver publishes this readiness file by rename only after the
      // entire JSON document is closed; existence must never expose a prefix.
      expect(existsSync(join(root, 'wire.pending.json'))).toBe(false)
      const endpoint = JSON.parse(readFileSync(join(root, 'wire.json'), 'utf8'))
      client.connect(endpoint.url)
      await until(() => connections === 1, 'wsClient did not authenticate')
      const created = await client.send<{ terminal_session_id: string; pid: number }>('terminal.create', {
        pane_id: 'frontend-wire-pane', agent_key: 'terminal', command: endpoint.command,
        cwd: root, cols: 100, rows: 30, create_generation: 'frontend-wire-generation',
      }, 15_000)
      expect(created.ok).toBe(true)
      const id = created.payload!.terminal_session_id
      await until(() => (output.get(id) ?? '').includes('READY '), 'fake CLI never announced readiness')
      const fakePid = Number(output.get(id)!.match(/READY \{"pid": (\d+)\}/)![1])
      expect(fakePid).toBeGreaterThan(0)
      expect((await client.send('terminal.input', { terminal_session_id: id, data: 'before-世界\r' })).ok).toBe(true)
      await until(() => (output.get(id) ?? '').includes(`"pid": ${fakePid}, "text": "before-世界"`), 'missing Unicode ACK before reconnect')

      client.reconnectNow('regression disconnect')
      await until(() => connections === 2, 'wsClient did not reconnect')
      const reattached = await client.send<{ alive: string[]; dead: string[] }>('terminal.reattach', {
        terminal_session_ids: [id], cols: 120, rows: 40,
      })
      expect(reattached.ok).toBe(true)
      expect(reattached.payload!.alive).toEqual([id])
      expect(reattached.payload!.dead).toEqual([])
      expect((await client.send('terminal.input', { terminal_session_id: id, data: 'after-世界\r' })).ok).toBe(true)
      await until(() => (output.get(id) ?? '').includes(`"pid": ${fakePid}, "text": "after-世界"`), 'reconnected output did not come from the original process')
      expect((await client.send('terminal.kill', { terminal_session_id: id })).ok).toBe(true)
      const gone = await client.send<{ dead: string[] }>('terminal.reattach', { terminal_session_ids: [id] })
      expect(gone.payload!.dead).toEqual([id])
    } finally {
      client.dispose('regression finished')
      child.stdin.end('\n')
      try {
        await until(() => exitCode !== undefined, 'backend driver shutdown timed out', 22_000)
        expect(exitCode, driverLog).toBe(0)
      } finally {
        if (exitCode === undefined && child.pid) {
          // Emergency cleanup is limited to this disposable driver's tree.
          execFileSync(python, ['-c', 'import psutil,sys; p=psutil.Process(int(sys.argv[1])); children=p.children(recursive=True); [c.kill() for c in children if c.is_running()]; p.kill(); psutil.wait_procs(children+[p], timeout=5)', String(child.pid)], { timeout: 10_000 })
        }
        const reports = resolve('test-results/ci/cli-wire')
        mkdirSync(reports, { recursive: true })
        if (existsSync(join(root, 'backend.log'))) copyFileSync(join(root, 'backend.log'), join(reports, 'backend.log'))
        // Keep diagnostics, never the ephemeral authentication endpoint/token.
        rmSync(root, { recursive: true, force: true })
      }
    }
  }, READY_TIMEOUT_MS + 55_000)
})
