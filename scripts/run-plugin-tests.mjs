// Runs the App-bundled plugins' own test suites, one plugin at a time. The root
// vitest.config.ts does not collect plugins/**: each plugin has its own
// plugins/<dir>/vitest.config.ts (see vitest.plugin.ts).
//
//   node scripts/run-plugin-tests.mjs                  # every plugin's unit project
//   node scripts/run-plugin-tests.mjs --artifacts      # their artifact projects
//   node scripts/run-plugin-tests.mjs --skip navide-git -- --reporter=junit --outputFile.junit=out/{plugin}.xml
//
// Arguments after `--` go to Vitest, with {plugin} replaced by the plugin's
// directory name so each run can write its own report.
import { run, testEnvironment } from './test-process.mjs'

export const PLUGIN_DIRS = ['navide-browser', 'navide-git', 'navide-mini-ide', 'navide-plans']

const args = process.argv.slice(2)
const split = args.indexOf('--')
const own = split === -1 ? args : args.slice(0, split)
const forwarded = split === -1 ? [] : args.slice(split + 1)
const skip = own.includes('--skip') ? own[own.indexOf('--skip') + 1].split(',') : []
const unknown = skip.filter((dir) => !PLUGIN_DIRS.includes(dir))
if (unknown.length) {
  console.error(`--skip names no App-bundled plugin: ${unknown.join(', ')}`)
  process.exit(2)
}
const artifacts = own.includes('--artifacts')

for (const dir of PLUGIN_DIRS.filter((name) => !skip.includes(name))) {
  // `<dir>-artifacts*` also takes `<dir>-artifacts-heavy` where a plugin has one.
  run(process.execPath, [
    'node_modules/vitest/vitest.mjs', 'run', '--config', `plugins/${dir}/vitest.config.ts`,
    '--project', artifacts ? `${dir}-artifacts*` : dir,
    ...forwarded.map((arg) => arg.replaceAll('{plugin}', dir)),
  ], testEnvironment())
}
