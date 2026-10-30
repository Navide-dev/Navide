/**
 * Paging over the Plans backend's bounded responses.
 *
 * One Backend Wire response is bounded (a frame is at most 1 MiB), but a plan
 * document is not: `plans.read` / `plans.read_document` return a page with
 * `eof: false` and `next_offset` when the document does not fit, and
 * `plans.list` can be paged with `{ offset }`. These helpers join the pages so
 * every caller sees a whole document / the whole list, whatever its size.
 */

type BackendCall = (name: string, args: Record<string, unknown>) => Promise<unknown>

const CHUNK_KEYS = ['size', 'offset', 'eof', 'next_offset'] as const
const MAX_READ_ATTEMPTS = 3

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read a document page by page and join the text held under `textKey`
 * (`html` for plans.read, `content` for plans.read_document). A single-page
 * reply (no `eof: false`) is returned untouched. If the file changes between
 * pages the read restarts, so two versions are never spliced together.
 */
export async function readWholeDocument<T extends Record<string, unknown>>(
  call: BackendCall,
  method: 'plans.read' | 'plans.read_document',
  textKey: 'html' | 'content',
  args: Record<string, unknown>,
): Promise<T> {
  for (let attempt = 0; attempt < MAX_READ_ATTEMPTS; attempt++) {
    const first = await call(method, args)
    if (!isRecord(first) || first.eof !== false) return first as T
    const parts = [String(first[textKey] ?? '')]
    let nextOffset = first.next_offset
    let stable = true
    for (;;) {
      if (typeof nextOffset !== 'number' || !Number.isSafeInteger(nextOffset)) {
        throw new Error('Plan read returned no next_offset')
      }
      const page = await call(method, { ...args, offset: nextOffset })
      if (!isRecord(page)) throw new Error('Plan read page was malformed')
      if (page.mtime !== first.mtime) {
        stable = false
        break
      }
      parts.push(String(page[textKey] ?? ''))
      if (page.eof !== false) break
      const following = page.next_offset
      if (typeof following !== 'number' || following <= nextOffset) {
        throw new Error('Plan read made no progress')
      }
      nextOffset = following
    }
    if (stable) {
      const whole: Record<string, unknown> = { ...first, [textKey]: parts.join('') }
      for (const key of CHUNK_KEYS) delete whole[key]
      return whole as T
    }
  }
  throw new Error('The plan changed while it was being read; try again')
}

/**
 * Every plan the backend lists, however many. Pages with `{ offset }` so no
 * single response can exceed a frame; against a backend that predates paging
 * (it rejects the argument) the plain call is used.
 */
export async function listAllPlans(call: BackendCall): Promise<unknown[]> {
  let first: unknown
  try {
    first = await call('plans.list', { offset: 0 })
  } catch (cause) {
    if ((cause as { code?: unknown } | null)?.code !== 'INVALID_ARGUMENT') throw cause
    const plain = await call('plans.list', {})
    return Array.isArray(plain) ? plain : []
  }
  if (Array.isArray(first)) return first
  if (!isRecord(first) || !Array.isArray(first.entries)) return []
  const entries = [...first.entries]
  let next = first.next_offset
  while (typeof next === 'number') {
    const page = await call('plans.list', { offset: next })
    if (!isRecord(page) || !Array.isArray(page.entries)) break
    entries.push(...page.entries)
    const following = page.next_offset
    if (typeof following !== 'number' || following <= next) break
    next = following
  }
  return entries
}

// ── Writing a document of any size ──────────────────────────────────────────

/** The Host sends the backend UTF-8 frames through a 256 KiB input queue; a
 * frame over it is refused, and an overflow while other frames are queued
 * stops the child. A document whose JSON encoding exceeds half the queue, in
 * UTF-8 bytes, is therefore written in parts, leaving room for the envelope and
 * concurrent traffic. A test pins this to the Host limit. */
export const SINGLE_WRITE_MAX_JSON_BYTES = 128 * 1024
/** File bytes per part: 96 KiB is the most one Host Bridge call carries. */
const WRITE_PART_BYTES = 96 * 1024

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  }
  return btoa(binary)
}

/** Whether `content` is too large for the single `plans.write_document` call. */
export function needsChunkedWrite(content: string): boolean {
  return new TextEncoder().encode(JSON.stringify(content)).length > SINGLE_WRITE_MAX_JSON_BYTES
}

/**
 * Write `content` to `relPath` in parts: stage each part, then commit with the
 * same `expected_mtime` / `expected_sha256` conflict check `plans.write_document` has. The file on
 * disk changes only at the commit (one atomic swap); a failure part-way
 * discards what was staged. Resolves to what `plans.write_document` resolves to.
 */
export async function writeDocumentChunked(
  call: BackendCall,
  relPath: string,
  content: string,
  expectedMtime?: number,
  expectedSha256?: string,
): Promise<unknown> {
  const bytes = new TextEncoder().encode(content)
  const uploadId = globalThis.crypto.randomUUID().replace(/-/g, '')
  try {
    let offset = 0
    do {
      const part = bytes.subarray(offset, offset + WRITE_PART_BYTES)
      await call('plans.write_document_part', {
        rel_path: relPath, upload_id: uploadId, offset, data_base64: toBase64(part),
      })
      offset += part.length
    } while (offset < bytes.length)
    return await call('plans.write_document_commit', {
      rel_path: relPath,
      upload_id: uploadId,
      total_size: bytes.length,
      ...(expectedMtime === undefined ? {} : { expected_mtime: expectedMtime }),
      ...(expectedSha256 === undefined ? {} : { expected_sha256: expectedSha256 }),
    })
  } catch (cause) {
    await call('plans.write_document_abort', { rel_path: relPath, upload_id: uploadId }).catch(() => undefined)
    throw cause
  }
}
