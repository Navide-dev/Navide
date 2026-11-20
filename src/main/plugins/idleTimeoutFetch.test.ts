import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DOWNLOAD_IDLE_TIMEOUT_MS, fetchWithIdleTimeout } from './idleTimeoutFetch'
import { defaultInstallerDeps } from './pluginInstaller'
import { readBodyCapped } from './readBodyCapped'

const savedFetch = global.fetch

/** A body that yields `chunks` chunks of `size` bytes, one every `gapMs`, then
 *  either ends or (with `stallAfter`) goes silent forever. */
function slowBody(chunks: number, size: number, gapMs: number, stallAfter = false): ReadableStream<Uint8Array> {
  let sent = 0
  return new ReadableStream<Uint8Array>({
    async pull(stream) {
      if (sent === chunks) {
        if (stallAfter) await new Promise(() => undefined)
        stream.close()
        return
      }
      await new Promise((resolve) => setTimeout(resolve, gapMs))
      sent += 1
      stream.enqueue(new Uint8Array(size).fill(sent))
    },
  })
}

function serve(body: ReadableStream<Uint8Array>): void {
  global.fetch = vi.fn(async () => new Response(body, { status: 200 })) as unknown as typeof fetch
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
  global.fetch = savedFetch
})

describe('fetchWithIdleTimeout', () => {
  it('finishes a slow but steady download that takes far longer than 15 s', async () => {
    // 12 chunks, 20 s apart: four minutes in all, never 30 s without data.
    serve(slowBody(12, 1024, 20_000))
    const done = fetchWithIdleTimeout('https://registry.test/pkg.vsix').then((res) => readBodyCapped(res, 1 << 20))
    await vi.advanceTimersByTimeAsync(12 * 20_000 + 1)
    const bytes = await done
    expect(bytes?.byteLength).toBe(12 * 1024)
  })

  it('aborts once no data has arrived for the idle timeout', async () => {
    serve(slowBody(2, 1024, 5_000, true))
    const done = fetchWithIdleTimeout('https://registry.test/pkg.vsix').then((res) => readBodyCapped(res, 1 << 20))
    const outcome = done.then(() => 'finished', (err: unknown) => err)
    await vi.advanceTimersByTimeAsync(10_000 + DOWNLOAD_IDLE_TIMEOUT_MS - 1)
    let settled = false
    void outcome.then(() => { settled = true })
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(2)
    expect(await outcome).toMatchObject({ name: 'TimeoutError' })
  })

  it('aborts a request whose response never starts', async () => {
    global.fetch = vi.fn((_url: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason))
      })
    ) as unknown as typeof fetch
    const outcome = fetchWithIdleTimeout('https://registry.test/pkg.vsix').then(() => 'finished', (err: unknown) => err)
    await vi.advanceTimersByTimeAsync(DOWNLOAD_IDLE_TIMEOUT_MS + 1)
    expect(await outcome).toMatchObject({ name: 'TimeoutError' })
  })

  it('is what the installer downloads packages with: slow but steady installs', async () => {
    serve(slowBody(6, 4096, 25_000))
    const done = defaultInstallerDeps.download('https://registry.test/pkg.vsix')
    await vi.advanceTimersByTimeAsync(6 * 25_000 + 1)
    expect((await done).bytes.byteLength).toBe(6 * 4096)
  })
})
