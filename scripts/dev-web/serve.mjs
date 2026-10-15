#!/usr/bin/env node
// Dev-only: serve the renderer for a browser, with no Electron at all.
//
//   NAVIDE_DEV_WEB=1 node scripts/dev-web/serve.mjs
//
// `electron-vite dev --rendererOnly` is not a substitute: it skips building
// main and preload but still launches Electron afterwards. This resolves the
// same electron.vite.config.ts and starts only its renderer dev server, where
// devWebPlugin.ts adds the login gate and the isolated backend.
import { resolveConfig } from 'electron-vite'
import { createServer } from 'vite'

if (process.env.NAVIDE_DEV_WEB !== '1') {
  console.error('dev web mode is opt-in: run with NAVIDE_DEV_WEB=1')
  process.exit(2)
}

const { config } = await resolveConfig({}, 'serve', 'development')
if (!config?.renderer) {
  console.error('electron.vite.config.ts has no renderer config')
  process.exit(1)
}
const server = await createServer({ ...config.renderer, configFile: false })
await server.listen()
server.printUrls()

const stop = async () => {
  await server.close()
  process.exit(0)
}
process.once('SIGINT', stop)
process.once('SIGTERM', stop)
