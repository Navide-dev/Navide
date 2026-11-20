/** How long a package or large asset download may go without receiving a
 *  single byte before it is abandoned. */
export const DOWNLOAD_IDLE_TIMEOUT_MS = 30_000

/** Fetch for downloads whose size makes a total deadline wrong: a slow but
 *  steady connection must finish however long it takes, so the request is
 *  aborted only after `idleMs` with no response and no body data. */
export async function fetchWithIdleTimeout(
  url: string | URL,
  init: RequestInit = {},
  idleMs = DOWNLOAD_IDLE_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const arm = (): void => {
    clearTimeout(timer)
    timer = setTimeout(
      () => controller.abort(new DOMException(`no data received for ${idleMs} ms`, 'TimeoutError')),
      idleMs
    )
  }
  arm()
  let res: Response
  try {
    res = await fetch(url, { ...init, signal: controller.signal })
  } catch (err) {
    clearTimeout(timer)
    throw err
  }
  if (!res.body) {
    clearTimeout(timer)
    return res
  }
  arm()
  const reader = res.body.getReader()
  // Settles only on abort, so a body stream that ignores the signal still stops.
  const aborted = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true })
  })
  aborted.catch(() => undefined)
  const body = new ReadableStream<Uint8Array>({
    async pull(stream) {
      try {
        const { done, value } = await Promise.race([reader.read(), aborted])
        if (done) {
          clearTimeout(timer)
          stream.close()
          return
        }
        arm()
        stream.enqueue(value)
      } catch (err) {
        clearTimeout(timer)
        if (controller.signal.aborted) void reader.cancel(controller.signal.reason).catch(() => undefined)
        stream.error(err)
      }
    },
    async cancel(reason) {
      clearTimeout(timer)
      await reader.cancel(reason)
    },
  })
  return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers })
}
