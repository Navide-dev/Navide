import { defineConfig } from '@playwright/test'

// Electron E2E only. Specs live in e2e/ and drive the *built* app
// (out/main/index.js), so run `pnpm build` before `pnpm test:e2e`.
// Single worker — one Electron instance + one Python backend at a time.
export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list'
})
