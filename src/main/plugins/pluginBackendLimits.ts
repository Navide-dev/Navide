/** Host-private resource limits for package-local Backend Wire routing. */
export const MAX_BACKEND_TIMEOUT_MS = 120_000
/** Host-private bound for queued Bridge frames and stream payloads. */
export const MAX_BACKEND_BRIDGE_QUEUE_BYTES = 256 * 1024
export const MAX_BACKEND_BRIDGE_CHUNK_BYTES = 64 * 1024
export const MAX_BACKEND_BRIDGE_RESULT_BYTES = 192 * 1024
/** Largest byte range one filesystem `read_range` call may return. Base64
 * inflates it by a third, so it stays well inside the result limit above; a
 * larger file is read by paging, never by raising the shared limits. */
export const MAX_BACKEND_BRIDGE_RANGE_BYTES = 96 * 1024

export function isAllowedBackendTimeout(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= MAX_BACKEND_TIMEOUT_MS
}
