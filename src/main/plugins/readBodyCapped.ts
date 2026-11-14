/** Largest plugin package the Host downloads from the Registry or Testplace. */
export const PACKAGE_DOWNLOAD_MAX_BYTES = 200 * 1024 * 1024

/** Read a response body, giving up (and cancelling the stream) as soon as it
 *  passes `cap` bytes, so a chunked or lying response never lands in memory
 *  whole. A response without a stream (a test double) is read directly. */
export async function readBodyCapped(res: Response, cap: number): Promise<Uint8Array | null> {
  const body = res.body
  if (!body) {
    const bytes = new Uint8Array(await res.arrayBuffer())
    return bytes.byteLength <= cap ? bytes : null
  }
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > cap) {
      await reader.cancel().catch(() => undefined)
      return null
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}
