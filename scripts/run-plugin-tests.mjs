// Runs the App-bundled plugins' own test suites, one plugin at a time. The root
// vitest.config.ts does not collect plugins/**: each plugin has its own
// plugins/<dir>/vitest.config.ts (see vitest.plugin.ts).
//
//   node scripts/run-plugin-tests.mjs                  # every plugin's unit project
//   node scripts/run-plugin-tests.mjs --artifacts      # their artifact projects
//   node scripts/run-plugin-tests.mjs --all            # every project (pnpm test:run)
//   node scripts/run-plugin-tests.mjs --skip navide-browser --reporter=junit --outputFile.junit=out/{plugin}.xml
//
// Every other argument goes to Vitest, with {plugin} replaced by the plugin's
// directory name so each run can write its own report.
import { run, testEnvironment } from './test-process.mjs'

export const PLUGIN_DIRS = ['navide-browser', 'navide-mini-ide', 'navide-plans']

const args = process.argv.slice(2).filter((arg) => arg !== '--')
const skipAt = args.indexOf('--skip')
const skip = skipAt === -1 ? [] : (args[skipAt + 1] ?? '').split(',')
const artifacts = args.includes('--artifacts')
const all = args.includes('--all')
const ownAt = new Set(skipAt === -1 ? [] : [skipAt, skipAt + 1])
const forwarded = args.filter((arg, index) => arg !== '--artifacts' && arg !== '--all' && !ownAt.has(index))
const unknown = skip.filter((dir) => !PLUGIN_DIRS.includes(dir))
if (unknown.length) {
  console.error(`--skip names no App-bundled plugin: ${unknown.join(', ')}`)
  process.exit(2)
}

for (const dir of PLUGIN_DIRS.filter((name) => !skip.includes(name))) {
  // `<dir>-artifacts*` also takes `<dir>-artifacts-heavy` where a plugin has one.
  run(process.execPath, [
    'node_modules/vitest/vitest.mjs', 'run', '--config', `plugins/${dir}/vitest.config.ts`,
    ...(all ? [] : ['--project', artifacts ? `${dir}-artifacts*` : dir]),
    ...forwarded.map((arg) => arg.replaceAll('{plugin}', dir)),
  ], testEnvironment())
}
