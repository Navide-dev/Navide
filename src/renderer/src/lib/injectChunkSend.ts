/**
 * One injection chunk's terminal.input request, resent when it timed out.
 *
 * A request timeout is not a lost write: 2026-11-15 10:16 the backend's event
 * loop stalled 15.9 s, past the 10 s request timeout, and then wrote the chunk
 * anyway. So every chunk carries the injection's id and its index, which the
 * backend uses to answer a resend without writing it twice; that is what makes
 * resending here safe. Anything other than a timeout (socket closed, refused
 * before dispatch) is not resent.
 */

/** Sends per chunk, the first included. */
export const CHUNK_SEND_ATTEMPTS = 3

/** wsClient rejects a request that got no answer in time with
 *  `request <type> timeout`. */
export function isRequestTimeout(err: unknown): boolean {
  return err instanceof Error && /^request \S+ timeout$/.test(err.message)
}

export function newInjectId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

export type ChunkSendResult<T> =
  | { ok: true; resp: T }
  /** `timedOut`: the last attempt timed out, so the backend may yet write the
   *  chunk — the caller must treat it as possibly typed. */
  | { ok: false; timedOut: boolean; error: unknown }

export async function sendChunkWithRetry<T>(
  send: () => Promise<T>,
  opts: { attempts?: number; aborted?: () => boolean } = {},
): Promise<ChunkSendResult<T>> {
  const attempts = opts.attempts ?? CHUNK_SEND_ATTEMPTS
  for (let attempt = 1; ; attempt++) {
    try {
      return { ok: true, resp: await send() }
    } catch (err) {
      const timedOut = isRequestTimeout(err)
      if (!timedOut || attempt >= attempts || opts.aborted?.() === true) {
        return { ok: false, timedOut, error: err }
      }
    }
  }
}
