// Review MED-5 / S8 Q3 on W3: publish stages are files with no count limit.
import { createHash } from 'node:crypto'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerDeveloperIpc } from './developerIpc'

let base = ''
let handlers: Map<string, (event: unknown, ...args: unknown[]) => unknown>
let publish: ReturnType<typeof vi.fn>

const stagingRoot = (): string => join(base, 'userData', 'plugin-staging', 'publish')
const call = (channel: string, ...args: unknown[]) => handlers.get(channel)!(null, ...args)

function register(): void {
  handlers = new Map()
  publish = vi.fn(async () => ({ status: 201, body: {}, digest: 'd' }))
  registerDeveloperIpc({
    handle: (channel, listener) => handlers.set(channel, listener as never),
    authorize: () => true,
    account: { publish } as never,
    inspectPackage: (bytes) => ({
      id: 'acme.todo', version: '1.0.0', publisher: 'acme',
      digest: createHash('sha256').update(bytes).digest('hex'), manifest: { schemaVersion: 2 },
    }),
    pickPackageFile: async () => null,
    hostTarget: () => 'darwin-arm64',
    stagingRoot: stagingRoot(),
  })
}

function vsixAt(n: number): string {
  const path = join(base, `todo-${n}.vsix`)
  writeFileSync(path, `package ${n}`)
  return path
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'navide-dev-staging-'))
})
afterEach(() => {
  vi.useRealTimers()
  rmSync(base, { recursive: true, force: true })
})

describe('developer publish stages (MED-5)', () => {
  it('keeps every stage, the ninth and later included, and publishes exactly the staged bytes', async () => {
    register()
    const staged = []
    for (let n = 0; n < 10; n += 1) staged.push(await call('developer:stagePackage', vsixAt(n)) as { stageId: string })
    expect(readdirSync(stagingRoot())).toHaveLength(10)
    writeFileSync(join(base, 'todo-0.vsix'), 'changed after staging')
    await call('developer:publish', { stageId: staged[0].stageId, target: 'universal' })
    expect(Buffer.from(publish.mock.calls[0][0] as Uint8Array).toString()).toBe('package 0')
    // Published: its stage file is gone; the other nine stay.
    expect(readdirSync(stagingRoot())).toHaveLength(9)
  })

  it('refuses a stage whose file changed on disk, and says when one expired', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-20T10:00:00Z'))
    register()
    const tampered = await call('developer:stagePackage', vsixAt(1)) as { stageId: string }
    const late = await call('developer:stagePackage', vsixAt(2)) as { stageId: string }
    writeFileSync(join(stagingRoot(), `${createHash('sha256').update('package 1').digest('hex')}.vsix`), 'swapped')
    await expect(call('developer:publish', { stageId: tampered.stageId })).rejects.toThrow(/^STAGING_DIGEST_MISMATCH/)
    vi.setSystemTime(new Date('2026-10-20T11:01:00Z'))
    await expect(call('developer:publish', { stageId: late.stageId })).rejects.toThrow(/^PUBLISH_STAGE_EXPIRED/)
    expect(publish).not.toHaveBeenCalled()
    expect(readdirSync(stagingRoot())).toEqual([])
  })
})
