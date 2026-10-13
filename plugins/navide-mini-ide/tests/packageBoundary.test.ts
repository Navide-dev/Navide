import { describe, expect, inject, it } from 'vitest'
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, delimiter, dirname, join, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

type CommandResult = {
  status: number | null
  stdout: string
  stderr: string
}

const repositoryRoot = resolve(import.meta.dirname, '../../..')
const execFileAsync = promisify(execFile)

function subprocessEnvironment(): NodeJS.ProcessEnv {
  const nodeDirectory = dirname(process.execPath)
  return {
    ...process.env,
    CI: '1',
    PNPM_CONFIG_PM_ON_FAIL: 'ignore',
    // A newer pnpm than the repo's pinned 10.x enables verify-deps-before-run
    // by default and can wipe node_modules on a lockfile-config mismatch.
    npm_config_verify_deps_before_run: 'false',
    PATH: `${nodeDirectory}${delimiter}${process.env.PATH ?? ''}`,
  }
}

async function run(command: string, args: string[], cwd: string, extraEnv: NodeJS.ProcessEnv = {}): Promise<CommandResult> {
  try {
    const result = await execFileAsync(command, args, {
      cwd,
      encoding: 'utf8',
      env: { ...subprocessEnvironment(), ...extraEnv },
      maxBuffer: 32 * 1024 * 1024,
    })
    return { status: 0, stdout: result.stdout, stderr: result.stderr }
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & {
      code?: number | string
      stdout?: string | Buffer
      stderr?: string | Buffer
    }
    if (typeof failure.code !== 'number') throw error
    return {
      status: failure.code,
      stdout: String(failure.stdout ?? ''),
      stderr: String(failure.stderr ?? ''),
    }
  }
}

async function runNodeEntryOrThrow(entry: string, args: string[], cwd: string, extraEnv: NodeJS.ProcessEnv = {}): Promise<CommandResult> {
  const result = await run(process.execPath, [entry, ...args], cwd, extraEnv)
  if (result.status !== 0) {
    throw new Error(`node ${entry} ${args.join(' ')} failed in ${cwd}\n${result.stdout}\n${result.stderr}`)
  }
  return result
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
  symlinkSync(realpathSync(source), destination, 'junction')
  expect(lstatSync(destination).isSymbolicLink(), packageName).toBe(true)
}

function collectFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return collectFiles(path)
    return entry.isFile() ? [path] : []
  })
}

function writeConsumerProject(project: string, packageRoot: string): void {
  for (const file of ['package.json', 'tsconfig.json', 'vite.config.ts', 'manifest.json']) {
    cpSync(join(packageRoot, file), join(project, file))
  }
  cpSync(join(packageRoot, 'frontend'), join(project, 'frontend'), { recursive: true })
  // Test sources are not part of the shipped package and would demand test-only
  // dev dependencies in the external consumer typecheck.
  cpSync(join(packageRoot, 'src'), join(project, 'src'), {
    recursive: true,
    filter: (source) => !/(?:[/\\]__tests__[/\\]|\.test\.ts$)/.test(source),
  })
}

describe('navide Mini-IDE public package boundary', () => {
  it(
    'builds a copied Mini-IDE against packed public packages with portable Monaco workers',
    async () => {
      // The runner's TEMP can be an 8.3 short path (C:\Users\RUNNER~1); vite
      // resolves inputs to the long form, so a short root puts index.html outside it.
      const temporaryRoot = realpathSync.native(mkdtempSync(join(tmpdir(), 'navide-mini-ide-external-')))
      const externalProject = join(temporaryRoot, 'consumer')
      mkdirSync(externalProject)
      try {
        // Shared immutable fixtures avoid deleting another worker's dists.
        const packageTarballs = Object.fromEntries(Object.entries(inject('publicPackageTarballs'))
          .filter(([name]) => name !== '@navide/navide-git'))
        expect(Object.keys(packageTarballs).sort()).toEqual([
          '@navide/plugin-contracts',
          '@navide/plugin-sdk',
          '@navide/plugin-ui',
        ])

        const packageRoot = join(repositoryRoot, 'plugins/navide-mini-ide')
        writeConsumerProject(externalProject, packageRoot)
        const copiedPackageJson = JSON.parse(readFileSync(join(externalProject, 'package.json'), 'utf8')) as {
          dependencies?: Record<string, unknown>
          devDependencies?: Record<string, unknown>
        }
        expect(copiedPackageJson.dependencies).not.toHaveProperty('@navide/navide-git')
        expect(existsSync(join(externalProject, 'node_modules/@navide/navide-git'))).toBe(false)
        expect(collectFiles(externalProject).some((path) => /[/\\]src[/\\]renderer[/\\]/.test(path))).toBe(false)
        expect(collectFiles(externalProject).some((path) => /[/\\]plugins[/\\]navide-(git|plans)[/\\]/.test(path))).toBe(false)
        for (const packageName of Object.keys(packageTarballs)) {
          const installedPackage = join(externalProject, 'node_modules', packageName)
          await extractPackageTarball(packageTarballs[packageName], installedPackage, externalProject)
          expect(lstatSync(installedPackage).isSymbolicLink(), packageName).toBe(false)
          expect(realpathSync(installedPackage)).not.toContain(repositoryRoot)
        }

        for (const packageName of [
          '@types/node',
          '@vitejs/plugin-vue',
          'monaco-editor',
          'mermaid',
          'typescript',
          'vite',
          'vue',
          'vue-i18n',
          'vue-tsc',
          'yaml',
        ]) {
          linkThirdPartyPackage(repositoryRoot, externalProject, packageName)
        }

        const externalRequire = createRequire(join(externalProject, 'package.json'))
        const vueTscCli = resolveInstalledPackageBin(externalProject, 'vue-tsc', 'vue-tsc', externalRequire)
        const viteCli = resolveInstalledPackageBin(externalProject, 'vite', 'vite', externalRequire)
        // The typecheck reads only src/ and the build writes only dist/, so the
        // two run side by side: one after the other they took 1m35s + 3m44s of
        // wall time at load average ~280 and outran the test timeout. Both
        // settle before the finally block removes the project they read.
        const [typecheck, build] = await Promise.allSettled([
          runNodeEntryOrThrow(vueTscCli, ['--noEmit', '--project', join(externalProject, 'tsconfig.json')], externalProject),
          runNodeEntryOrThrow(viteCli, ['build', '--config', join(externalProject, 'vite.config.ts')], externalProject, {
            NAVIDE_MINI_IDE_DIST_DIR: join(externalProject, 'dist'),
          }),
        ])
        if (typecheck.status === 'rejected') throw typecheck.reason
        if (build.status === 'rejected') throw build.reason

        const distFiles = collectFiles(join(externalProject, 'dist'))
        const workerFiles = distFiles.filter((path) => /(?:editor|ts|json|css|html)\.worker-[^/]+\.js$/.test(path))
        const workerPrefixes = ['editor.worker-', 'ts.worker-', 'json.worker-', 'css.worker-', 'html.worker-']
        for (const workerPrefix of workerPrefixes) {
          expect(workerFiles.some((path) => path.includes(workerPrefix)), workerPrefix).toBe(true)
        }
        expect(workerFiles.length).toBeGreaterThanOrEqual(5)
        // Exactly one bundle per worker kind, and that one is the one the code
        // loads: Monaco's own `new URL('<x>.worker.js')` fallbacks used to add a
        // second, never-used copy of each language worker (~9MB in all).
        for (const workerPrefix of workerPrefixes) {
          expect(workerFiles.filter((path) => basename(path).startsWith(workerPrefix)), workerPrefix).toHaveLength(1)
        }
        const javaScriptFiles = distFiles.filter((path) => path.endsWith('.js'))
        for (const workerFile of workerFiles) {
          const workerName = basename(workerFile)
          expect(
            javaScriptFiles.some((path) => path !== workerFile && readFileSync(path, 'utf8').includes(workerName)),
            workerName,
          ).toBe(true)
        }

        const builtJavaScript = javaScriptFiles
          .map((path) => readFileSync(path, 'utf8'))
          .join('\n')
        expect(builtJavaScript.length).toBeGreaterThan(0)
        expect(builtJavaScript).not.toContain('src/renderer')
        expect(builtJavaScript).not.toContain('capabilityBackend')
        expect(builtJavaScript).not.toContain('GitWindowApp')
        expect(builtJavaScript).not.toMatch(/(?:from|import)\s*['"][^'"]*navide-git/)
        // No copied Git product code: the IDE asks the Git plugin for its
        // surfaces, so the Git feature's own transport inventory — the request
        // literals only that implementation emits — must not ship here. The
        // IDE's own reads (`git.status`, `git.branches`) stay out of this list
        // because they are part of its explorer and review affordances.
        for (const gitFeatureRequest of [
          'git.compare_branches',
          'git.list_conflicts',
          'git.mark_resolved',
          'git.stash_pop',
          'git.diff_blame',
          'resolveTheirs',
        ]) {
          expect(builtJavaScript, gitFeatureRequest).not.toContain(gitFeatureRequest)
        }
      } finally {
        rmSync(temporaryRoot, { recursive: true, force: true })
      }
    },
    // The build is inherently heavy (3.4K modules, five Monaco worker
    // sub-builds); at load average ~280 it alone took 3m44s of wall time.
    600_000,
  )
})
