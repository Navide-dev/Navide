import { describe, expect, inject, it } from 'vitest'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawn } from 'node:child_process'

type CommandResult = {
  status: number | null
  stdout: string
  stderr: string
}

const repositoryRoot = resolve(import.meta.dirname, '../../..')

function packageManager(): { command: string; prefix: string[] } {
  const inherited = process.env.npm_execpath ?? ''
  const configured = process.env.NAVIDE_PNPM ?? (/pnpm/i.test(inherited) ? inherited : '')
  if (!configured) return { command: 'pnpm', prefix: [] }
  if (configured.endsWith('.js') || configured.endsWith('.cjs')) {
    return { command: process.execPath, prefix: [configured] }
  }
  return { command: configured, prefix: [] }
}

function subprocessEnvironment(): NodeJS.ProcessEnv {
  const nodeDirectory = dirname(process.execPath)
  return {
    ...process.env,
    CI: '1',
    PNPM_CONFIG_PM_ON_FAIL: 'ignore',
    // A newer pnpm than the repo's pinned 10.x enables verify-deps-before-run
    // by default and can wipe node_modules on a lockfile-config mismatch.
    npm_config_verify_deps_before_run: 'false',
    PATH: `${nodeDirectory}:${process.env.PATH ?? ''}`,
  }
}

const maxOutputBytes = 16 * 1024 * 1024

// Asynchronous on purpose: these subprocesses run for a minute or more, and a
// synchronous spawn blocks the vitest worker's event loop for that long, so its
// onTaskUpdate RPC to the main process times out (60 s) and fails the run.
function run(command: string, args: string[], cwd: string): Promise<CommandResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { cwd, env: subprocessEnvironment() })
    const output = { stdout: [] as Buffer[], stderr: [] as Buffer[] }
    const sizes = { stdout: 0, stderr: 0 }
    let settled = false
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      child.kill()
      rejectPromise(error)
    }
    for (const stream of ['stdout', 'stderr'] as const) {
      child[stream].on('data', (chunk: Buffer) => {
        sizes[stream] += chunk.length
        if (sizes[stream] > maxOutputBytes) {
          fail(new Error(`${command} ${stream} exceeded maxBuffer (${maxOutputBytes} bytes)`))
          return
        }
        output[stream].push(chunk)
      })
    }
    child.on('error', fail)
    child.on('close', (status) => {
      if (settled) return
      settled = true
      resolvePromise({
        status,
        stdout: Buffer.concat(output.stdout).toString('utf8'),
        stderr: Buffer.concat(output.stderr).toString('utf8'),
      })
    })
  })
}

function runPnpm(args: string[], cwd: string): Promise<CommandResult> {
  const invocation = packageManager()
  return run(invocation.command, [...invocation.prefix, ...args], cwd)
}

async function runPnpmOrThrow(args: string[], cwd: string): Promise<CommandResult> {
  const result = await runPnpm(args, cwd)
  if (result.status !== 0) {
    throw new Error(`pnpm ${args.join(' ')} failed in ${cwd}\n${result.stdout}\n${result.stderr}`)
  }
  return result
}

async function runNodeEntryOrThrow(entry: string, args: string[], cwd: string): Promise<CommandResult> {
  const result = await run(process.execPath, [entry, ...args], cwd)
  if (result.status !== 0) {
    throw new Error(`node ${entry} ${args.join(' ')} failed in ${cwd}\n${result.stdout}\n${result.stderr}`)
  }
  return result
}

function vueTscEntry(consumerEntry: string): string {
  // Bun's loader cannot apply Volar's `tsc` bootstrap, so a direct vue-tsc
  // entry reports TS2307 for every .vue import. Under Bun the same typecheck
  // runs through the repository's explicit adapter; the consumer's vue-tsc is
  // the same installed package. Node keeps the consumer entry unchanged.
  return process.versions.bun ? join(repositoryRoot, 'scripts/bun/vue-tsc.cjs') : consumerEntry
}

async function runCommandOrThrow(command: string, args: string[], cwd: string): Promise<CommandResult> {
  const result = await run(command, args, cwd)
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed in ${cwd}\n${result.stdout}\n${result.stderr}`)
  }
  return result
}

function resolveInstalledPackageDirectory(
  repository: string,
  packageName: string,
  require: NodeRequire,
): string {
  try {
    return dirname(realpathSync(require.resolve(`${packageName}/package.json`)))
  } catch {
    const directPackage = join(repository, 'node_modules', packageName)
    if (existsSync(join(directPackage, 'package.json'))) return realpathSync(directPackage)
    const pnpmStore = join(repository, 'node_modules', '.pnpm')
    const packageDirectory = readdirSync(pnpmStore).find((entry) =>
      entry.startsWith(`${packageName.replace('/', '+')}@`),
    )
    if (!packageDirectory) throw new Error(`Could not locate installed package ${packageName}`)
    return dirname(
      realpathSync(join(pnpmStore, packageDirectory, 'node_modules', packageName, 'package.json')),
    )
  }
}

function resolveInstalledPackageBin(
  repository: string,
  packageName: string,
  binaryName: string,
  require: NodeRequire,
): string {
  const packageDirectory = resolveInstalledPackageDirectory(repository, packageName, require)
  const packageJson = JSON.parse(readFileSync(join(packageDirectory, 'package.json'), 'utf8')) as {
    bin?: string | Record<string, string>
  }
  const bin = typeof packageJson.bin === 'string' ? packageJson.bin : packageJson.bin?.[binaryName]
  if (!bin) throw new Error(`Could not locate ${binaryName} in ${packageName}`)
  return join(packageDirectory, bin)
}

function installedVersion(repository: string, packageName: string): string {
  const require = createRequire(join(repository, 'package.json'))
  const directory = resolveInstalledPackageDirectory(repository, packageName, require)
  return (JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as { version: string }).version
}

function installedVersionOrUndefined(repository: string, packageName: string): string | undefined {
  try {
    return installedVersion(repository, packageName)
  } catch {
    return undefined
  }
}

function writeConsumerProject(
  project: string,
  tarballs: Record<string, string>,
  versions: Record<string, string | undefined>,
): void {
  writeFileSync(
    join(project, 'package.json'),
    `${JSON.stringify(
      {
        name: 'navide-git-external-consumer',
        private: true,
        type: 'module',
        dependencies: {
          '@navide/navide-git': `file:${tarballs['@navide/navide-git']}`,
          '@navide/plugin-contracts': `file:${tarballs['@navide/plugin-contracts']}`,
          '@navide/plugin-sdk': `file:${tarballs['@navide/plugin-sdk']}`,
          '@navide/plugin-ui': `file:${tarballs['@navide/plugin-ui']}`,
          vue: versions.vue,
          'vue-i18n': versions['vue-i18n'],
        },
        devDependencies: {
          '@types/node': versions['@types/node'],
          '@vitejs/plugin-vue': versions['@vitejs/plugin-vue'],
          typescript: versions.typescript,
          vite: versions.vite,
          ...(versions['vue-tsc'] ? { 'vue-tsc': versions['vue-tsc'] } : {}),
        },
      },
      null,
      2,
    )}\n`,
  )
  mkdirSync(join(project, 'src'))
  writeFileSync(
    join(project, 'index.html'),
    '<div id="app"></div><script type="module" src="/src/main.ts"></script>\n',
  )
  writeFileSync(
    join(project, 'src/main.ts'),
    `import { createApp, defineComponent, h } from 'vue'
import { GitPane, DiffPane, BranchDiffPane, ConflictPane } from '@navide/navide-git/composition'
import { V2_VIEW_LOCATIONS } from '@navide/plugin-contracts'
import { PluginError, type PluginContext } from '@navide/plugin-sdk'
import { useNotify } from '@navide/plugin-ui/foundation'

const injectedAuthority = undefined as unknown as Pick<PluginContext, 'capabilities' | 'events'>
const contractProbe = new PluginError('INTERNAL_ERROR', 'external composition probe')
const Consumer = defineComponent({
  setup() {
    void injectedAuthority
    void contractProbe
    void V2_VIEW_LOCATIONS
    void useNotify
    return () => h('section', [
      h(GitPane),
      h(DiffPane),
      h(BranchDiffPane),
      h(ConflictPane),
    ])
  },
})

// The external consumer owns the eventual mount and authority injection.
void createApp(Consumer)
`,
  )
  writeFileSync(
    join(project, 'tsconfig.json'),
    `${JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'Bundler',
          strict: true,
          skipLibCheck: true,
          noEmit: true,
          types: ['vite/client'],
        },
        include: ['src/**/*.ts', 'src/**/*.vue', 'vite.config.ts'],
      },
      null,
      2,
    )}\n`,
  )
  writeFileSync(
    join(project, 'vite.config.ts'),
    `import { defineConfig, type Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'

function compositionBoundaryGuard(): Plugin {
  return {
    name: 'composition-boundary-guard',
    generateBundle() {
      const moduleIds = [...this.getModuleIds()]
      const expectedComponents = [
        'src/components/GitPane.vue',
        'src/editor/DiffPane.vue',
        'src/editor/BranchDiffPane.vue',
        'src/editor/ConflictPane.vue',
      ]
      const missingComponents = expectedComponents.filter((path) =>
        !moduleIds.some((id) => id.endsWith('/node_modules/@navide/navide-git/' + path)),
      )
      if (missingComponents.length) {
        this.error('composition components missing from Rollup graph:\\n' + missingComponents.join('\\n'))
      }
      const violations = moduleIds.filter((id) =>
        /[/\\\\]src[/\\\\]renderer[/\\\\]/.test(id) ||
        /[/\\\\]node_modules[/\\\\]@navide[/\\\\]navide-git[/\\\\]src[/\\\\](?:index|mount|capabilityBackend)\\.ts$/.test(id),
      )
      if (violations.length) {
        this.error('forbidden composition module graph entries:\\n' + violations.join('\\n'))
      }
    },
  }
}

export default defineConfig({
  plugins: [vue(), compositionBoundaryGuard()],
})
`,
  )
}

async function extractPackageTarball(tarball: string, packageDirectory: string, cwd: string): Promise<void> {
  mkdirSync(packageDirectory, { recursive: true })
  await runCommandOrThrow(
    'tar',
    ['-xzf', tarball, '--strip-components=1', '-C', packageDirectory],
    cwd,
  )
}

function linkThirdPartyPackage(repository: string, consumer: string, packageName: string): void {
  if (packageName.startsWith('@navide/')) {
    throw new Error(`Refusing to symlink Navide package ${packageName}`)
  }
  const source = join(repository, 'node_modules', packageName)
  const destination = join(consumer, 'node_modules', packageName)
  expect(existsSync(source), packageName).toBe(true)
  mkdirSync(dirname(destination), { recursive: true })
  symlinkSync(realpathSync(source), destination)
  expect(lstatSync(destination).isSymbolicLink(), packageName).toBe(true)
}

describe('navide.git public composition', () => {
  it(
    'packs all public packages and builds an external Vue consumer from packed artifacts',
    async () => {
      // The runner's TEMP can be an 8.3 short path (C:\Users\RUNNER~1); vite
      // resolves inputs to the long form, so a short root puts index.html outside it.
      const temporaryRoot = realpathSync.native(mkdtempSync(join(tmpdir(), 'navide-git-composition-')))
      const externalProject = join(temporaryRoot, 'consumer')
      mkdirSync(externalProject)
      try {
        // Built and packed once for the whole run by tests/support/publicPackagesSetup.ts.
        const packageTarballs = inject('publicPackageTarballs')
        expect(Object.keys(packageTarballs).sort()).toEqual([
          '@navide/navide-git',
          '@navide/plugin-contracts',
          '@navide/plugin-sdk',
          '@navide/plugin-ui',
        ])

        const versions = {
          '@types/node': installedVersion(repositoryRoot, '@types/node'),
          '@vitejs/plugin-vue': installedVersion(repositoryRoot, '@vitejs/plugin-vue'),
          typescript: installedVersion(repositoryRoot, 'typescript'),
          vite: installedVersion(repositoryRoot, 'vite'),
          vue: installedVersion(repositoryRoot, 'vue'),
          'vue-i18n': installedVersion(repositoryRoot, 'vue-i18n'),
          'vue-tsc': installedVersionOrUndefined(repositoryRoot, 'vue-tsc'),
        }
        expect(versions.vite).toBe('6.4.4')
        writeConsumerProject(externalProject, packageTarballs, versions)

        for (const packageName of Object.keys(packageTarballs)) {
          const installedPackage = join(externalProject, 'node_modules', packageName)
          await extractPackageTarball(packageTarballs[packageName], installedPackage, externalProject)
          expect(lstatSync(installedPackage).isSymbolicLink(), packageName).toBe(false)
          expect(readFileSync(join(installedPackage, 'package.json'), 'utf8')).toContain(`"name": "${packageName}"`)
          expect(realpathSync(installedPackage), packageName).not.toContain(repositoryRoot)
        }
        for (const packageName of [
          '@types/node',
          '@vitejs/plugin-vue',
          'typescript',
          'vite',
          'vue',
          'vue-i18n',
          ...(versions['vue-tsc'] ? ['vue-tsc'] : []),
        ]) {
          linkThirdPartyPackage(repositoryRoot, externalProject, packageName)
        }

        const externalRequire = createRequire(join(externalProject, 'package.json'))
        if (versions['vue-tsc']) {
          const vueTscCli = resolveInstalledPackageBin(externalProject, 'vue-tsc', 'vue-tsc', externalRequire)
          await runNodeEntryOrThrow(vueTscEntry(vueTscCli), ['--noEmit', '--project', join(externalProject, 'tsconfig.json')], externalProject)
        }

        const viteCli = resolveInstalledPackageBin(externalProject, 'vite', 'vite', externalRequire)
        await runNodeEntryOrThrow(viteCli, ['build', '--config', join(externalProject, 'vite.config.ts')], externalProject)

        const builtJavaScript = readdirSync(join(externalProject, 'dist', 'assets'))
          .filter((entry) => entry.endsWith('.js'))
          .map((entry) => readFileSync(join(externalProject, 'dist', 'assets', entry), 'utf8'))
          .join('\n')
        expect(builtJavaScript.length).toBeGreaterThan(0)
        expect(builtJavaScript).not.toContain('src/renderer')
        expect(builtJavaScript).not.toContain('capabilityBackend')
      } finally {
        rmSync(temporaryRoot, { recursive: true, force: true })
      }
    },
    180_000,
  )
})
