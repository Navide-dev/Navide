// The Host's LocalPackageScanner (plan W1): the static scan the Registry and
// `navide-plugin scan` share, run once per package in its own worker thread so
// a large package never stalls the main thread. The worker is its own entry
// of the main build (electron.vite.config.ts), emitted beside index.js. A
// worker that fails or does not answer in time yields no report; the scan
// never decides an install.
import { Worker } from 'node:worker_threads'
import { join } from 'node:path'
import type { ScanReport } from '../../shared/pluginDisclosureScan'
import type { LocalPackageScanner } from './pluginIpc'

/** The scanner's own budget is 30 s; this only bounds a worker that hangs. */
const WORKER_DEADLINE_MS = 45_000

export const scanLocalPackageInWorker: LocalPackageScanner = (input) =>
  new Promise<ScanReport | null>((resolve) => {
    const worker = new Worker(join(__dirname, 'pluginLocalScanWorker.js'))
    let settled = false
    const settle = (report: ScanReport | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      void worker.terminate()
      resolve(report)
    }
    const timer = setTimeout(() => settle(null), WORKER_DEADLINE_MS)
    worker.once('message', (message: { ok: boolean; report?: ScanReport | null }) => settle(message.ok ? message.report ?? null : null))
    worker.once('error', () => settle(null))
    worker.once('exit', () => settle(null))
    worker.postMessage({ ...input, files: [...input.files] })
  })
