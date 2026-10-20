// Worker thread body for the static scan of a local package (plan W1). The
// shared scanner runs synchronously for up to its 30 s budget, so the Host
// runs it here instead of on the main thread. Bundled by electron-vite
// through the `?nodeWorker` import in pluginLocalScan.ts.
import { parentPort } from 'node:worker_threads'
import { scanPackageFiles } from '../../../packages/plugin-contracts/src/staticScan'

parentPort?.on('message', (input: { files: Array<[string, Uint8Array]>; artifactDigest: string; target: string; manifest: unknown }) => {
  try {
    const report = scanPackageFiles({
      files: new Map(input.files),
      artifactDigest: input.artifactDigest,
      target: input.target,
      manifest: input.manifest,
    })
    parentPort?.postMessage({ ok: true, report })
  } catch (error) {
    parentPort?.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) })
  }
})
