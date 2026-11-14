import { describe, expect, inject, it } from 'vitest'
import {
  cpSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import { planPublicCapabilityCall } from './pluginCapabilityBroker'
import { readManifestFromEntries, readZipEntries } from './pluginPackage'
import { manifestV2CapabilityPolicy } from './pluginPermissions'

type CommandResult = {
  status: number | null
  stdout: string
  stderr: string
}

function packageManager(): { command: string; prefix: string[] } {
  // Every invocation below is pnpm-specific — --store-dir, --lockfile=false,
  // workspace resolution — so npm_execpath is only useful when it actually IS
  // pnpm. Under npx or npm it points at npm, which then fails deep in the run
  // complaining about flags it does not have, a long way from the cause.
  // NAVIDE_PNPM stays an explicit override for a pnpm somewhere else.
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
    // A newer pnpm resolved from PATH re-verifies the workspace before running
    // and, when this checkout's `pnpm` field is not one it reads, replaces
    // node_modules before failing. This test only ever packs and installs into a
    // temp directory, so the implicit install is never what it wants.
    npm_config_verify_deps_before_run: 'false',
    PATH: `${nodeDirectory}${delimiter}${process.env.PATH ?? ''}`,
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
    throw new Error(
      `pnpm ${args.join(' ')} failed in ${cwd}\n${result.stdout}\n${result.stderr}`
    )
  }
  return result
}

function runExternalCli(args: string[], cwd: string): Promise<CommandResult> {
  // pnpm links the bin as a shell script on POSIX and as `.cmd`/`.ps1` shims
  // on Windows; `pnpm exec` resolves whichever it wrote, as `pnpm run` does.
  return runPnpm(['exec', 'navide-plugin', ...args], cwd)
}

function writeManifest(directory: string, manifest: unknown): void {
  writeFileSync(join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
}

function resolveInstalledPackageDirectory(
  repository: string,
  packageName: string,
  require: NodeRequire
): string {
  try {
    return dirname(realpathSync(require.resolve(`${packageName}/package.json`)))
  } catch {
    const pnpmStore = join(repository, 'node_modules', '.pnpm')
    const packageDirectory = readdirSync(pnpmStore).find((entry) =>
      entry.startsWith(`${packageName.replace('/', '+')}@`)
    )
    if (!packageDirectory) {
      throw new Error(`Could not locate installed package ${packageName}`)
    }
    return dirname(
      realpathSync(join(pnpmStore, packageDirectory, 'node_modules', packageName, 'package.json'))
    )
  }
}

function resolveInstalledPackageBin(
  repository: string,
  packageName: string,
  binaryName: string,
  require: NodeRequire
): string {
  const packageDirectory = resolveInstalledPackageDirectory(repository, packageName, require)
  const packageJson = JSON.parse(
    readFileSync(join(packageDirectory, 'package.json'), 'utf8')
  ) as { bin?: string | Record<string, string> }
  const bin = typeof packageJson.bin === 'string' ? packageJson.bin : packageJson.bin?.[binaryName]
  if (!bin) throw new Error(`Could not locate ${binaryName} in ${packageName}`)
  return join(packageDirectory, bin)
}

async function runNodeEntryOrThrow(entry: string, args: string[], cwd: string): Promise<CommandResult> {
  const commandResult = await run(process.execPath, [entry, ...args], cwd)
  if (commandResult.status !== 0) {
    throw new Error(
      `node ${entry} ${args.join(' ')} failed in ${cwd}\n${commandResult.stdout}\n${commandResult.stderr}`
    )
  }
  return commandResult
}

describe('third-party plugin external workspace', () => {
  it(
    'installs public packages, validates/types/builds/packages the example, and enforces Host capability denial',
    async () => {
      const repository = process.cwd()
      // The runner's TEMP can be an 8.3 short path (C:\Users\RUNNER~1); vite
      // resolves inputs to the long form, so a short root puts index.html outside it.
      const temporaryRoot = realpathSync.native(mkdtempSync(join(tmpdir(), 'navide-plugin-external-')))
      const externalProject = join(temporaryRoot, 'example')
      try {
        for (const schemaName of [
          'plugin-manifest-v2.schema.json',
          'capabilities-v1.json',
          'execution-policy-v1.schema.json',
        ]) {
          expect(
            readFileSync(join(repository, 'packages', 'plugin-contracts', 'src', 'schemas', schemaName), 'utf8')
          ).toBe(readFileSync(join(repository, 'docs', 'plugin-contracts', schemaName), 'utf8'))
        }
        for (const packageName of ['plugin-contracts', 'plugin-sdk', 'plugin-ui']) {
          const packageJson = readFileSync(
            join(repository, 'packages', packageName, 'package.json'),
            'utf8'
          )
          expect(packageJson).not.toContain('workspace:')
          expect(packageJson).not.toContain('packages/internal')
        }
        // The editor subpath must carry portable workers for offline/file://
        // consumers, rather than resolve them against the Host origin.
        const editorBundle = join(repository, 'packages/plugin-ui/dist/editor/index.js')
        const editorSource = readFileSync(editorBundle, 'utf8')
        expect(editorSource).not.toMatch(/["']\/assets\/[^"']*\.worker-/)
        const workerUrls = [...editorSource.matchAll(/new URL\(\s*["']([^"']+\.worker-[^"']+\.js)["']/g)]
        expect(workerUrls).toHaveLength(5)
        for (const [, workerUrl] of workerUrls) {
          expect(readFileSync(new URL(workerUrl, pathToFileURL(editorBundle))).length).toBeGreaterThan(0)
        }

        // Built and packed once for the whole run by tests/support/publicPackagesSetup.ts.
        const packedTarballs = inject('publicPackageTarballs')
        const packageTarballs: Record<string, string> = {}
        for (const packageName of ['@navide/plugin-contracts', '@navide/plugin-sdk', '@navide/plugin-ui']) {
          packageTarballs[packageName] = packedTarballs[packageName]
        }

        const require = createRequire(import.meta.url)
        const typescriptCli = resolveInstalledPackageBin(repository, 'typescript', 'tsc', require)
        const viteCli = resolveInstalledPackageBin(repository, 'vite', 'vite', require)
        const pnpmStorePath = (await runPnpmOrThrow(['store', 'path'], repository)).stdout.trim()

        cpSync(join(repository, 'examples', 'third-party-files'), externalProject, {
          recursive: true,
        })
        const externalPackageJsonPath = join(externalProject, 'package.json')
        const externalPackageJson = JSON.parse(readFileSync(externalPackageJsonPath, 'utf8')) as {
          dependencies: Record<string, string>
          devDependencies: Record<string, string>
        }
        expect(externalPackageJson.devDependencies.typescript).toEqual(expect.any(String))
        expect(externalPackageJson.devDependencies.vite).toEqual(expect.any(String))
        for (const packageName of Object.keys(packageTarballs)) {
          externalPackageJson.dependencies[packageName] = `file:${packageTarballs[packageName]}`
        }
        // Vue and vue-i18n are Host-provided peers of @navide/plugin-ui. The
        // external gate installs only the public Navide tarballs offline, then
        // links the repository's already-installed peer runtime explicitly.
        delete externalPackageJson.dependencies.vue
        delete externalPackageJson.dependencies['vue-i18n']
        delete externalPackageJson.devDependencies.typescript
        delete externalPackageJson.devDependencies.vite
        writeFileSync(externalPackageJsonPath, `${JSON.stringify(externalPackageJson, null, 2)}\n`)

        expect(JSON.stringify(externalPackageJson)).not.toContain('workspace:')
        expect(JSON.stringify(externalPackageJson)).not.toContain('@navide/feature-')
        expect(
          Object.entries(externalPackageJson.dependencies)
            .filter(([name]) => name.startsWith('@navide/'))
            .every(([, value]) => value.startsWith('file:'))
        ).toBe(true)
        expect(externalPackageJson.devDependencies.typescript).toBeUndefined()
        expect(externalPackageJson.devDependencies.vite).toBeUndefined()

        await runPnpmOrThrow(
          [
            'install',
            '--offline',
            '--ignore-scripts',
            '--config.auto-install-peers=false',
            '--lockfile=false',
            '--store-dir',
            pnpmStorePath,
          ],
          externalProject
        )
        symlinkSync(realpathSync(join(repository, 'node_modules', 'vue')), join(externalProject, 'node_modules', 'vue'))
        symlinkSync(
          realpathSync(join(repository, 'node_modules', 'vue-i18n')),
          join(externalProject, 'node_modules', 'vue-i18n')
        )
        // Only this generated editor probe needs the optional Monaco peer;
        // the shipped sample keeps its existing public surface and behavior.
        symlinkSync(realpathSync(join(repository, 'node_modules', 'monaco-editor')), join(externalProject, 'node_modules', 'monaco-editor'))
        writeFileSync(join(externalProject, 'src/editor-surface-probe.ts'), `
import { EditorPane, createPreflightEditorPort, type EditorPort } from '@navide/plugin-ui/editor'
export { EditorPane }
export const port: EditorPort = createPreflightEditorPort()
export function save(editor: InstanceType<typeof EditorPane>): Promise<void> { return editor.save() }
`)
        await runNodeEntryOrThrow(
          typescriptCli,
          ['--noEmit', '--project', join(externalProject, 'tsconfig.json')],
          externalProject
        )
        await runNodeEntryOrThrow(
          viteCli,
          ['build', '--config', join(externalProject, 'vite.config.ts')],
          externalProject
        )
        writeFileSync(join(externalProject, 'editor.vite.config.mjs'), `
export default {
  base: './',
  build: {
    outDir: 'editor-probe',
    lib: { entry: 'src/editor-surface-probe.ts', formats: ['es'], fileName: () => 'editor.js' },
    rollupOptions: { external: ['vue', 'vue-i18n', 'monaco-editor'] },
  },
}
`)
        await runNodeEntryOrThrow(viteCli, ['build', '--config', join(externalProject, 'editor.vite.config.mjs')], externalProject)
        expect(readFileSync(join(externalProject, 'editor-probe/editor.js'), 'utf8')).not.toContain('src/renderer')
        await runNodeEntryOrThrow(join(externalProject, 'scripts', 'stage-package.mjs'), [], externalProject)
        await runPnpmOrThrow(['run', 'check'], externalProject)
        await runPnpmOrThrow(['run', 'package'], externalProject)

        const archivePath = join(externalProject, 'dist', 'acme-files.vsix')
        const secondArchivePath = join(externalProject, 'dist', 'acme-files-second.vsix')
        const secondPackageResult = await runExternalCli(
          ['package', join(externalProject, 'dist', 'package'), '--out', secondArchivePath],
          externalProject
        )
        expect(secondPackageResult.status).toBe(0)
        expect(readFileSync(secondArchivePath)).toEqual(readFileSync(archivePath))
        const entries = readZipEntries(readFileSync(archivePath))
        const regularPaths = entries.filter((entry) => entry.type === 'regular').map((entry) => entry.path)
        expect(regularPaths).toContain('manifest.json')
        expect(regularPaths).toContain('frontend/index.html')
        expect(regularPaths).toContain('frontend/main.js')
        expect(regularPaths.some((path) => path.startsWith('src/'))).toBe(false)
        expect(regularPaths.some((path) => path.startsWith('node_modules/'))).toBe(false)
        expect(readManifestFromEntries(entries)).toMatchObject({
          id: 'acme.files',
          permissions: { system: ['fs'] },
        })
        const builtEntry = readFileSync(
          join(externalProject, 'dist', 'package', 'frontend', 'main.js'),
          'utf8'
        )
        expect(builtEntry).not.toMatch(/(?:from|import)\s*['"](?:@|[A-Za-z])/)
        expect(readFileSync(join(externalProject, 'dist', 'package', 'frontend', 'index.html'), 'utf8'))
          .toContain('./main.js')

        const validationRoot = join(temporaryRoot, 'validation-cases')
        cpSync(join(externalProject, 'dist', 'package'), validationRoot, { recursive: true })
        const contractsModule = await import(
          pathToFileURL(
            join(externalProject, 'node_modules', '@navide', 'plugin-contracts', 'dist', 'index.js')
          ).href
        )
        expect(
          contractsModule.validatePortableArchiveEntries([
            { path: 'frontend/main.js', type: 'regular' },
            { path: 'frontend/MAIN.JS', type: 'regular' },
          ])
        ).toEqual({ kind: 'duplicate', path: 'frontend/MAIN.JS' })

        const duplicateDirectory = join(validationRoot, 'duplicate')
        cpSync(join(externalProject, 'dist', 'package'), duplicateDirectory, { recursive: true })
        writeFileSync(
          join(duplicateDirectory, 'manifest.json'),
          '{"schemaVersion":2,"permissions":{},"permissions":{}}\n'
        )
        const duplicateResult = await runExternalCli(['validate', duplicateDirectory], externalProject)
        expect(duplicateResult.status).not.toBe(0)
        expect(`${duplicateResult.stdout}\n${duplicateResult.stderr}`).toContain(
          'duplicate JSON object key'
        )

        const unknownDirectory = join(validationRoot, 'unknown')
        cpSync(join(externalProject, 'dist', 'package'), unknownDirectory, { recursive: true })
        const unknownManifest = JSON.parse(
          readFileSync(join(unknownDirectory, 'manifest.json'), 'utf8')
        ) as Record<string, unknown>
        unknownManifest.unknownField = true
        writeManifest(unknownDirectory, unknownManifest)
        const unknownResult = await runExternalCli(['validate', unknownDirectory], externalProject)
        expect(unknownResult.status).not.toBe(0)
        expect(`${unknownResult.stdout}\n${unknownResult.stderr}`).toContain('unknown field')

        const publisherDirectory = join(validationRoot, 'publisher-mismatch')
        cpSync(join(externalProject, 'dist', 'package'), publisherDirectory, { recursive: true })
        const publisherManifest = JSON.parse(
          readFileSync(join(publisherDirectory, 'manifest.json'), 'utf8')
        ) as Record<string, unknown>
        publisherManifest.publisher = 'other'
        writeManifest(publisherDirectory, publisherManifest)
        const publisherResult = await runExternalCli(['validate', publisherDirectory], externalProject)
        expect(publisherResult.status).not.toBe(0)
        expect(`${publisherResult.stdout}\n${publisherResult.stderr}`).toContain(
          'publisher must match id namespace'
        )

        const collisionDirectory = join(validationRoot, 'portable-collision')
        cpSync(join(externalProject, 'dist', 'package'), collisionDirectory, { recursive: true })
        writeFileSync(join(collisionDirectory, 'frontend', 'MAIN.JS'), 'case collision\n')
        // validate reads only the canonical file list, so the colliding entry
        // must be listed to be checked at all.
        const collisionList = JSON.parse(
          readFileSync(join(collisionDirectory, 'artifact-files.json'), 'utf8')
        ) as { files: string[] }
        writeFileSync(
          join(collisionDirectory, 'artifact-files.json'),
          JSON.stringify({ files: [...collisionList.files, 'frontend/MAIN.JS'] })
        )
        const collisionNames = readdirSync(join(collisionDirectory, 'frontend'))
        if (collisionNames.includes('main.js') && collisionNames.includes('MAIN.JS')) {
          const collisionResult = await runExternalCli(['validate', collisionDirectory], externalProject)
          expect(collisionResult.status).not.toBe(0)
          expect(`${collisionResult.stdout}\n${collisionResult.stderr}`).toContain(
            'portable archive collision'
          )
        }

        const aliasDirectory = join(validationRoot, 'portable-alias')
        cpSync(join(externalProject, 'dist', 'package'), aliasDirectory, { recursive: true })
        writeFileSync(join(aliasDirectory, 'frontend', 'alias'), 'alias\n')
        writeFileSync(join(aliasDirectory, 'frontend', 'alias.'), 'portable alias\n')
        writeFileSync(
          join(aliasDirectory, 'artifact-files.json'),
          JSON.stringify({ files: ['manifest.json', 'frontend/index.html', 'frontend/main.js', 'frontend/alias', 'frontend/alias.'] })
        )
        const aliasResult = await runExternalCli(['validate', aliasDirectory], externalProject)
        expect(aliasResult.status).not.toBe(0)
        expect(`${aliasResult.stdout}\n${aliasResult.stderr}`).toContain('portable archive collision')

        const unsafeDirectory = join(validationRoot, 'unsafe')
        cpSync(join(externalProject, 'dist', 'package'), unsafeDirectory, { recursive: true })
        const unsafeManifest = JSON.parse(
          readFileSync(join(unsafeDirectory, 'manifest.json'), 'utf8')
        ) as { contributes: { views: Array<Record<string, unknown>> } }
        unsafeManifest.contributes.views[0].entry = '../outside.html'
        writeManifest(unsafeDirectory, unsafeManifest)
        const unsafeResult = await runExternalCli(['validate', unsafeDirectory], externalProject)
        expect(unsafeResult.status).not.toBe(0)
        expect(`${unsafeResult.stdout}\n${unsafeResult.stderr}`).toContain('safe package-relative')

        const missingDirectory = join(validationRoot, 'missing')
        cpSync(join(externalProject, 'dist', 'package'), missingDirectory, { recursive: true })
        rmSync(join(missingDirectory, 'frontend', 'index.html'))
        const missingResult = await runExternalCli(['validate', missingDirectory], externalProject)
        expect(missingResult.status).not.toBe(0)
        expect(`${missingResult.stdout}\n${missingResult.stderr}`).toContain('does not exist')

        const symlinkPath = join(validationRoot, 'symlink-file')
        symlinkSync(join(externalProject, 'dist', 'package', 'frontend', 'main.js'), symlinkPath)
        const packageFilesModule = await import(
          pathToFileURL(join(repository, 'packages', 'plugin-sdk', 'bin', 'package-files.mjs')).href
        )
        expect(() => packageFilesModule.readRegularFileNoFollow(symlinkPath)).toThrow()

        const pluginModule = await import(
          `${pathToFileURL(join(externalProject, 'dist', 'package', 'frontend', 'main.js')).href}?smoke=1`
        )
        expect(pluginModule.plugin).toBeDefined()
        const HostPluginError = contractsModule.PluginError as new (
          code: string,
          message: string
        ) => Error & { code: string }
        const binding = {
          pluginId: 'acme.files',
          packageVersion: '1.0.0',
          workspaceId: 'workspace-1',
          instanceId: 'instance-1',
          audience: 'external',
        }
        const policy = manifestV2CapabilityPolicy({ system: ['fs'] })
        const authorization = {
          publisherEligible: false,
          userGrant: { packageVersion: '1.0.0', system: ['fs'] as const },
          runtimeBinding: binding,
        }
        let requestId = 0
        const invoke = async (address: string, params: unknown): Promise<unknown> => {
          const separator = address.indexOf('.')
          const decision = planPublicCapabilityCall(
            {
              pluginId: binding.pluginId,
              ns: address.slice(0, separator),
              method: address.slice(separator + 1),
              args: params,
              reqId: `external-${requestId++}`,
            },
            policy,
            authorization
          )
          if (decision.kind === 'deny') {
            const error = decision.response.error
            throw new HostPluginError(error?.code ?? 'INTERNAL_ERROR', error?.message ?? 'denied')
          }
          if (decision.plan.address === 'fs.readFile') return { content: 'README from Host' }
          throw new Error(`unexpected allowed capability ${decision.plan.address}`)
        }

        await pluginModule.plugin.activate({
          pluginId: binding.pluginId,
          packageVersion: binding.packageVersion,
          contributionKey: 'main',
          instanceId: binding.instanceId,
          workspaceId: binding.workspaceId,
          startupDeadlineMs: 5000,
          capabilities: { invoke },
          events: { subscribe: () => ({ dispose() {} }) },
          lifecycle: { reportProgress() {} },
          view: { hide: async () => {} },
          targets: { subscribe: () => ({ dispose() {} }) },
        })
        expect(pluginModule.lastRun).toMatchObject({
          allowedContent: 'README from Host',
          deniedCode: 'CAPABILITY_DENIED',
        })

        // The published in-memory Host (@navide/plugin-sdk/testing) answers the
        // same plugin the same way, from the installed package alone.
        const testingModule = await import(
          pathToFileURL(
            join(externalProject, 'node_modules', '@navide', 'plugin-sdk', 'dist', 'testing.js')
          ).href
        )
        const testHost = testingModule.createTestHost({
          pluginId: binding.pluginId,
          packageVersion: binding.packageVersion,
          permissions: { system: ['fs'] },
          handlers: { 'fs.readFile': () => ({ content: 'README from the test Host' }) },
        })
        await pluginModule.plugin.activate(testHost.context)
        expect(pluginModule.lastRun).toMatchObject({
          allowedContent: 'README from the test Host',
          deniedCode: 'CAPABILITY_DENIED',
        })
        expect(testHost.calls.map((call: { address: string; outcome: string }) => [call.address, call.outcome])).toEqual([
          ['fs.readFile', 'ok'],
          ['shell.run', 'CAPABILITY_DENIED'],
        ])
      } finally {
        rmSync(temporaryRoot, { recursive: true, force: true })
      }
    },
    180_000
  )
})
