import { pnpm, run, testEnvironment } from './test-process.mjs'

const args = process.argv.slice(2)
const prepared = args.includes('--prepared')
const packagedOnly = args.includes('--packaged-plans')
const packaged = packagedOnly || (prepared && process.platform === 'darwin')
const forwarded = args.filter((arg) => !['--prepared', '--packaged-plans'].includes(arg))

if (!prepared) {
  // The manual packaged gate keeps its historical standalone entrypoint.
  // Each dependency builds once before any test worker starts.
  for (const build of [
    'build:public-packages', 'build:plans:v2', 'build:plans:backend',
    'build:mini-ide:v2', 'build:git:v2',
  ]) pnpm(['run', build])
  run(process.execPath, ['scripts/stage-official-plugin-artifacts.mjs'])
}
// Electron's lazy download must finish before parallel tests start: two
// workers importing electron at once both extract into the same dist folder.
run(process.execPath, ['node_modules/electron/install.js'])
if (packaged) {
  pnpm(['run', 'build:plans:fixture'])
}

const env = testEnvironment({ NAVIDE_TEST_ARTIFACTS_PREBUILT: '1' })
if (packaged) {
  env.NAVIDE_TEST_PACKAGED_PLANS = '1'
  env.NAVIDE_TEST_PRODUCTION_PLANS_BACKEND = '1'
}
run(process.execPath, [
  'node_modules/vitest/vitest.mjs', 'run', '--project', 'artifacts', '--project', 'artifacts-heavy',
  ...(packagedOnly ? [
    'tests/integration/plansPackagedRoundtrip.test.ts',
    'src/main/plugins/pluginBackendHost.test.ts',
    'src/main/plugins/pluginBackendSupervisor.test.ts',
  ] : []),
  ...forwarded,
], env)
