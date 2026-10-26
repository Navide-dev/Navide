import { Worker } from 'node:worker_threads'

/**
 * A child stdout frame longer than this is decoded and parsed in a worker
 * thread, so a large result never stalls the Host's main thread. Frames up to
 * this size (the old frame bound) take the same synchronous path as before.
 * A threshold for where the work runs, not a limit: frames have no size limit.
 */
export const OFF_THREAD_FRAME_BYTES = 1_048_576

/**
 * A result piece frame (contract 4.4, R1) longer than this is parsed in the
 * worker too, and its data comes back as bytes: a 40 MiB result then never
 * passes through this thread's heap as strings. Only frames that name the
 * piece method near their start are sent; the worker checks every frame fully.
 */
export const OFF_THREAD_PIECE_BYTES = 16_384
const PIECE_METHOD = Buffer.from('"notifications/navide/resultChunk"')

/** Whether a frame is a large result piece, to be parsed in the worker. */
export function isLargePieceFrame(line: Buffer): boolean {
  return line.length > OFF_THREAD_PIECE_BYTES && line.subarray(0, 256).includes(PIECE_METHOD)
}

export interface OffThreadFrame {
  /** The frame's JSON, with a response's `result.value` replaced by `null`
   *  and a result piece's `params.data` replaced by `""`. */
  envelope: string
  /** That value's compact UTF-8 spelling, and the end offset of each piece of it. */
  value?: { bytes: Uint8Array; cuts: number[] }
  /** That piece's data as UTF-8. */
  data?: Uint8Array
}

// Plain JavaScript run with `eval: true`, so nothing extra is bundled. A frame
// is checked exactly as parseBackendWireFrame checks it on the main thread
// (no BOM, UTF-8, the same JsonScanner, finite numbers). The value is cut on
// its bytes like splitAgentToolPayloadText: each cut steps back off
// continuation bytes to the start of its code point.
const source = (scanner: string): string => `
const { parentPort } = require('node:worker_threads')
const JsonScanner = (${scanner})
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
const encoder = new TextEncoder()
const finite = (value) => {
  const stack = [value]
  while (stack.length > 0) {
    const item = stack.pop()
    if (typeof item === 'number' && !Number.isFinite(item)) return false
    if (item !== null && typeof item === 'object') for (const child of Object.values(item)) stack.push(child)
  }
  return true
}
parentPort.on('message', ({ id, parts, chunkBytes }) => {
  let frame
  try {
    const line = parts.length === 1 ? parts[0] : Buffer.concat(parts)
    if (line[0] === 0xef && line[1] === 0xbb && line[2] === 0xbf) throw new Error('BOM')
    const text = decoder.decode(line)
    if (text.length === 0 || text.includes('\\ufeff')) throw new Error('BOM')
    new JsonScanner(text).parse()
    frame = JSON.parse(text)
    if (!finite(frame)) throw new Error('number')
  } catch {
    parentPort.postMessage({ id, invalid: true })
    return
  }
  const params = frame !== null && typeof frame === 'object' && !Array.isArray(frame) ? frame.params : undefined
  if (
    frame.method === 'notifications/navide/resultChunk' &&
    params !== null && typeof params === 'object' && !Array.isArray(params) && typeof params.data === 'string'
  ) {
    const data = encoder.encode(params.data)
    params.data = ''
    parentPort.postMessage({ id, envelope: JSON.stringify(frame), data }, [data.buffer])
    return
  }
  const result = frame !== null && typeof frame === 'object' && !Array.isArray(frame) ? frame.result : undefined
  if (result === null || typeof result !== 'object' || Array.isArray(result) || !('value' in result)) {
    parentPort.postMessage({ id, envelope: JSON.stringify(frame) })
    return
  }
  const bytes = encoder.encode(JSON.stringify(result.value))
  result.value = null
  const cuts = []
  let from = 0
  while (bytes.length - from > chunkBytes) {
    let end = from + chunkBytes
    while ((bytes[end] & 0xc0) === 0x80) end -= 1
    cuts.push(end)
    from = end
  }
  cuts.push(bytes.length)
  parentPort.postMessage({ id, envelope: JSON.stringify(frame), bytes, cuts }, [bytes.buffer])
})
`

interface Waiter {
  resolve: (frame: OffThreadFrame) => void
  reject: (error: Error) => void
}

let worker: Worker | undefined
let nextId = 0
const waiting = new Map<number, Waiter>()

function failAll(error: Error): void {
  worker = undefined
  for (const waiter of waiting.values()) waiter.reject(error)
  waiting.clear()
}

function frameWorker(scanner: string): Worker {
  if (worker) return worker
  const created = new Worker(source(scanner), { eval: true })
  created.unref()
  created.on('message', (message: {
    id: number
    invalid?: true
    envelope?: string
    bytes?: Uint8Array
    cuts?: number[]
    data?: Uint8Array
  }) => {
    const waiter = waiting.get(message.id)
    if (!waiter) return
    waiting.delete(message.id)
    // An idle worker never keeps the process alive.
    if (waiting.size === 0) created.unref()
    if (message.invalid || message.envelope === undefined) {
      waiter.reject(new Error('invalid frame'))
      return
    }
    waiter.resolve({
      envelope: message.envelope,
      ...(message.bytes && message.cuts ? { value: { bytes: message.bytes, cuts: message.cuts } } : {}),
      ...(message.data ? { data: message.data } : {}),
    })
  })
  created.on('error', (error) => {
    if (worker === created) failAll(error)
  })
  created.on('exit', () => {
    if (worker === created) failAll(new Error('frame worker exited'))
  })
  worker = created
  return created
}

/**
 * Join, decode, check and parse one frame in the worker thread. `parts` are
 * the frame's bytes in order, handed over (transferred, so the main thread
 * copies nothing it owns) and not to be used afterwards. `scanner` is the
 * supervisor's JsonScanner class, whose source the worker runs. Rejects when
 * the frame fails a check, or when the worker itself fails.
 */
export function parseFrameOffThread(
  parts: readonly Uint8Array[],
  chunkBytes: number,
  scanner: abstract new (text: string) => { parse(): void },
): Promise<OffThreadFrame> {
  const id = nextId++
  // Transfer needs a buffer of its own; a part that shares memory is copied.
  const own = parts.map((part) => part.byteOffset === 0 && part.buffer.byteLength === part.length
    ? part
    : Uint8Array.prototype.slice.call(part))
  return new Promise<OffThreadFrame>((resolve, reject) => {
    const target = frameWorker(scanner.toString())
    waiting.set(id, { resolve, reject })
    target.ref()
    target.postMessage({ id, parts: own, chunkBytes }, own.map((part) => part.buffer as ArrayBuffer))
  })
}
