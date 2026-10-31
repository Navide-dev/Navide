import { describe, expect, it, vi } from 'vitest'
import { resolveWorkspaceFileLink, retryWhileBusy, searchWorkspaceFiles, type WorkspaceFileSource } from '../workspaceFiles'

function sourceOf(files: string[], existing: string[] = []): WorkspaceFileSource & { query: ReturnType<typeof vi.fn> } {
  const query = vi.fn(async ({ query: text, mode, limit }: { query: string; mode: string; limit: number }) => {
    const needle = text.toLowerCase()
    const hit = (path: string): boolean => {
      if (mode === 'substring') return path.toLowerCase().includes(needle)
      let found = 0
      for (const char of path.toLowerCase()) if (char === needle[found]) found++
      return found === needle.length
    }
    return files.filter(hit).slice(0, limit).map((path) => ({ path, name: path.split('/').pop() ?? path }))
  })
  return { query, isFile: async (path) => existing.includes(path) }
}

describe('searchWorkspaceFiles', () => {
  it('ranks what the Host returned in path order', async () => {
    const rows = await searchWorkspaceFiles(sourceOf(['a/foobar.ts', 'z/foo.ts']), 'foo.ts')
    expect(rows.map((row) => row.path)).toEqual(['z/foo.ts', 'a/foobar.ts'])
  })

  it('adds a subsequence pass only when exact text found too little', async () => {
    const few = sourceOf(['src/OrderService.php'])
    expect((await searchWorkspaceFiles(few, 'ordsrv')).map((row) => row.path)).toEqual(['src/OrderService.php'])
    expect(few.query).toHaveBeenCalledTimes(2)

    const many = sourceOf(Array.from({ length: 25 }, (_, index) => `foo${index}.ts`))
    expect(await searchWorkspaceFiles(many, 'foo')).toHaveLength(20)
    expect(many.query).toHaveBeenCalledTimes(1)
  })
})

describe('resolveWorkspaceFileLink', () => {
  it('opens the reported file at its line', async () => {
    const source = sourceOf([], ['app/Services/OrderService.php'])
    await expect(resolveWorkspaceFileLink(source, ['app/Services/OrderService.php:137-158'], '/work'))
      .resolves.toEqual({ path: 'app/Services/OrderService.php', line: 137, endLine: 158 })
  })

  it('takes an absolute path inside the workspace', async () => {
    const source = sourceOf([], ['src/a.ts'])
    await expect(resolveWorkspaceFileLink(source, ['/work/src/a.ts:3'], '/work')).resolves.toEqual({ path: 'src/a.ts', line: 3 })
  })

  it('finds a path relative to a subfolder when one file fits', async () => {
    const source = sourceOf(['packages/ui/src/a.ts', 'packages/ui/src/b.ts'])
    await expect(resolveWorkspaceFileLink(source, ['src/a.ts:9'], '/work')).resolves.toEqual({ path: 'packages/ui/src/a.ts', line: 9 })
  })

  it('tries the next candidate', async () => {
    const source = sourceOf([], ['src/a.ts'])
    await expect(resolveWorkspaceFileLink(source, ['Editing src/a.ts', 'src/a.ts'], '/work')).resolves.toEqual({ path: 'src/a.ts' })
  })

  it('leaves two possible files to the Host picker', async () => {
    const source = sourceOf(['a/src/x.ts', 'b/src/x.ts'])
    await expect(resolveWorkspaceFileLink(source, ['src/x.ts'], '/work')).resolves.toBeNull()
  })

  it('leaves a missing file and anything outside the workspace to the Host picker', async () => {
    const source = sourceOf([])
    await expect(resolveWorkspaceFileLink(source, ['src/none.ts', '/etc/hosts', '../x.ts'], '/work')).resolves.toBeNull()
    expect(source.query).toHaveBeenCalledTimes(1)
  })
})

describe('retryWhileBusy', () => {
  const wait = async () => undefined

  it('keeps the first answer that is not busy', async () => {
    const send = vi.fn(async () => ({ error: 'busy' }) as { error?: string })
    send.mockResolvedValueOnce({ error: 'busy' }).mockResolvedValueOnce({})
    await expect(retryWhileBusy(send, wait)).resolves.toEqual({})
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('does not retry another failure', async () => {
    const send = vi.fn(async () => ({ error: 'workspace not found' }))
    await expect(retryWhileBusy(send, wait)).resolves.toEqual({ error: 'workspace not found' })
    expect(send).toHaveBeenCalledOnce()
  })

  it('gives up and returns busy after its retries', async () => {
    const send = vi.fn(async () => ({ error: 'busy' }))
    await expect(retryWhileBusy(send, wait)).resolves.toEqual({ error: 'busy' })
    expect(send).toHaveBeenCalledTimes(5)
  })
})
