import { createHash } from 'node:crypto'

const PROTOCOL_REVISION = '2026-07-28'
const SERVER_INFO_KEY = 'io.modelcontextprotocol/serverInfo'
// Chunked transfer (plugin agent-tools contract 4.4).
const CHUNK_BYTES = 131_072
const RESULT_CHUNK_METHOD = 'notifications/navide/resultChunk'
const RESULT_CHUNKS_KEY = 'io.navide/resultChunks'
const ARGUMENT_CHUNK_METHOD = 'notifications/navide/argumentChunk'
const ARGUMENT_CHUNKS_KEY = 'io.navide/argumentChunks'
const argumentPieces = new Map()

const pendingDelays = new Map()
const subscriptions = new Map()
let cancelledCount = 0
let input = Buffer.alloc(0)

function isRequestId(value) {
  return (typeof value === 'string' && value.length > 0) ||
    (typeof value === 'number' && Number.isInteger(value))
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value, keys) {
  return isRecord(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
}

function isClientMeta(value) {
  return isRecord(value) &&
    value['io.modelcontextprotocol/protocolVersion'] === PROTOCOL_REVISION &&
    isRecord(value['io.modelcontextprotocol/clientCapabilities'])
}

function isEventName(value) {
  return typeof value === 'string' && /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/.test(value)
}

const RUNTIME_KEYS = [
  'pluginId',
  'packageVersion',
  'workspaceId',
  'instanceId',
  'contributionKey',
  'hostWindowId',
]

function isInitiator(value) {
  return isRecord(value) &&
    (exactKeys(value, ['kind', 'id']) &&
      value.kind === 'user' &&
      typeof value.id === 'string' && value.id.length > 0 ||
      (exactKeys(value, ['kind', 'source', 'id']) ||
        exactKeys(value, ['kind', 'source', 'id', 'caller']) && isAgentCaller(value.caller)) &&
      value.kind === 'agent' && value.source === 'mcp' &&
      typeof value.id === 'string' && value.id.length > 0)
}

// The agent-tool caller (plan B1-b) is an additive optional field of the
// agent initiator.
function isAgentCaller(value) {
  if (!isRecord(value) || !exactKeys(value, ['kind', 'paneId', 'workspace', 'verifiedTo'])) return false
  if (value.kind === 'pane') {
    return typeof value.paneId === 'string' && value.paneId.length > 0 &&
      (value.workspace === null || typeof value.workspace === 'string' && value.workspace.length > 0) &&
      value.verifiedTo === 'pane'
  }
  return (value.kind === 'external' || value.kind === 'host') &&
    value.paneId === null && value.workspace === null && value.verifiedTo === 'caller-kind'
}

function isRuntime(value) {
  // `initiator` is an additive OPTIONAL field of Backend Wire v1: the Host
  // always sends it, and a v1 receiver must also accept the pre-initiator
  // runtime shape.
  return (exactKeys(value, RUNTIME_KEYS) || exactKeys(value, [...RUNTIME_KEYS, 'initiator'])) &&
    typeof value.pluginId === 'string' && value.pluginId.length > 0 &&
    typeof value.packageVersion === 'string' && value.packageVersion.length > 0 &&
    ['workspaceId', 'instanceId', 'contributionKey', 'hostWindowId']
      .every((key) => value[key] === null || typeof value[key] === 'string') &&
    (value.initiator === undefined || isInitiator(value.initiator))
}

function scanString(text, start) {
  let index = start + 1
  while (index < text.length) {
    const character = text[index]
    if (character === '\\') {
      index += 2
      continue
    }
    if (character === '"') return index + 1
    index += 1
  }
  throw new Error('unterminated string')
}

function scanValue(text, start, keys) {
  const character = text[start]
  if (character === '"') return scanString(text, start)
  if (character === '[') {
    let index = start + 1
    if (text[index] === ']') return index + 1
    while (true) {
      index = scanValue(text, index, keys)
      if (text[index] === ']') return index + 1
      if (text[index] !== ',') throw new Error('invalid array')
      index += 1
    }
  }
  if (character === '{') {
    const seen = new Set()
    let index = start + 1
    if (text[index] === '}') return index + 1
    while (true) {
      if (text[index] !== '"') throw new Error('invalid object key')
      const keyEnd = scanString(text, index)
      const key = JSON.parse(text.slice(index, keyEnd))
      if (seen.has(key)) throw new Error('duplicate object key')
      seen.add(key)
      index = keyEnd
      if (text[index] !== ':') throw new Error('invalid object')
      index = scanValue(text, index + 1, keys)
      if (text[index] === '}') return index + 1
      if (text[index] !== ',') throw new Error('invalid object')
      index += 1
    }
  }
  let index = start
  while (index < text.length && !',]}'.includes(text[index])) index += 1
  return index
}

function parseStrict(line) {
  if (line.length === 0) throw new Error('empty frame')
  let inString = false
  let escaped = false
  for (const character of line) {
    if (escaped) {
      escaped = false
      continue
    }
    if (character === '\\' && inString) {
      escaped = true
      continue
    }
    if (character === '"') {
      inString = !inString
      continue
    }
    if (!inString && /[\t\r\n ]/.test(character)) throw new Error('non-compact frame')
  }
  const end = scanValue(line, 0, new Set())
  if (end !== line.length) throw new Error('trailing frame data')
  return JSON.parse(line)
}

function writeFrame(frame) {
  process.stdout.write(`${JSON.stringify(frame)}\n`)
}

function writeProtocolError(id) {
  const frame = { jsonrpc: '2.0', error: { code: -32600, message: 'Invalid request' } }
  if (isRequestId(id)) frame.id = id
  writeFrame(frame)
}

function response(id, value) {
  writeFrame({
    jsonrpc: '2.0',
    id,
    result: {
      resultType: 'complete',
      value,
      _meta: { [SERVER_INFO_KEY]: { name: 'fixture.backend', version: '1.0.0' } },
    },
  })
}

function isHealthRequest(frame) {
  return exactKeys(frame, ['jsonrpc', 'id', 'method', 'params']) &&
    frame.jsonrpc === '2.0' &&
    isRequestId(frame.id) &&
    frame.method === 'navide/health' &&
    exactKeys(frame.params, ['_meta']) &&
    isClientMeta(frame.params._meta)
}

function utf8Pieces(text, maxBytes) {
  const pieces = []
  let current = ''
  let bytes = 0
  for (const char of text) {
    const size = Buffer.byteLength(char, 'utf8')
    if (bytes + size > maxBytes) {
      pieces.push(current)
      current = ''
      bytes = 0
    }
    current += char
    bytes += size
  }
  pieces.push(current)
  return pieces
}

function sendResultPieces(id, pieces, bytes) {
  pieces.forEach((data, seq) => writeFrame({ jsonrpc: '2.0', method: RESULT_CHUNK_METHOD, params: { requestId: id, seq, data } }))
  writeFrame({
    jsonrpc: '2.0',
    id,
    result: {
      resultType: 'complete',
      _meta: { [SERVER_INFO_KEY]: { name: 'fixture.backend', version: '1.0.0' }, [RESULT_CHUNKS_KEY]: { chunks: pieces.length, bytes } },
    },
  })
}

function isCallRequest(frame) {
  // Arguments sent in pieces leave `arguments` out and carry their summary in _meta.
  const chunked = isRecord(frame?.params?._meta?.[ARGUMENT_CHUNKS_KEY])
  return exactKeys(frame, ['jsonrpc', 'id', 'method', 'params']) &&
    frame.jsonrpc === '2.0' &&
    isRequestId(frame.id) &&
    frame.method === 'navide/call' &&
    exactKeys(frame.params, chunked ? ['_meta', 'name', 'runtime'] : ['_meta', 'name', 'arguments', 'runtime']) &&
    isClientMeta(frame.params._meta) &&
    typeof frame.params.name === 'string' &&
    /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/.test(frame.params.name) &&
    isRuntime(frame.params.runtime)
}

function isListenRequest(frame) {
  return exactKeys(frame, ['jsonrpc', 'id', 'method', 'params']) &&
    frame.jsonrpc === '2.0' &&
    isRequestId(frame.id) &&
    frame.method === 'subscriptions/listen' &&
    exactKeys(frame.params, ['_meta', 'notifications', 'runtime']) &&
    isClientMeta(frame.params._meta) &&
    exactKeys(frame.params.notifications, ['dev.navide/pluginEvents']) &&
    Array.isArray(frame.params.notifications['dev.navide/pluginEvents']) &&
    frame.params.notifications['dev.navide/pluginEvents'].length > 0 &&
    new Set(frame.params.notifications['dev.navide/pluginEvents']).size ===
      frame.params.notifications['dev.navide/pluginEvents'].length &&
    frame.params.notifications['dev.navide/pluginEvents'].every(isEventName) &&
    isRuntime(frame.params.runtime)
}

function acknowledgeSubscription(id, events) {
  writeFrame({
    jsonrpc: '2.0',
    method: 'notifications/subscriptions/acknowledged',
    params: {
      _meta: { 'io.modelcontextprotocol/subscriptionId': id },
      notifications: { 'dev.navide/pluginEvents': events },
    },
  })
}

function emitSubscriptionEvent(id, event, payload) {
  writeFrame({
    jsonrpc: '2.0',
    method: 'notifications/navide/event',
    params: {
      _meta: { 'io.modelcontextprotocol/subscriptionId': id },
      event,
      payload,
    },
  })
}

function closeSubscription(id) {
  writeFrame({
    jsonrpc: '2.0',
    id,
    result: {
      resultType: 'complete',
      _meta: {
        [SERVER_INFO_KEY]: { name: 'fixture.backend', version: '1.0.0' },
        'io.modelcontextprotocol/subscriptionId': id,
      },
    },
  })
}

function handle(frame) {
  if (frame?.jsonrpc === '2.0' && frame.method === ARGUMENT_CHUNK_METHOD) {
    const { requestId, seq, data } = frame.params ?? {}
    const pieces = argumentPieces.get(String(requestId)) ?? []
    if (seq !== pieces.length || typeof data !== 'string') {
      writeProtocolError(undefined)
      return
    }
    pieces.push(data)
    argumentPieces.set(String(requestId), pieces)
    return
  }
  if (frame?.jsonrpc === '2.0' && frame.method === 'notifications/cancelled') {
    if (!exactKeys(frame, ['jsonrpc', 'method', 'params']) ||
      !isRecord(frame.params) ||
      !Object.keys(frame.params).every((key) => key === 'requestId' || key === 'reason') ||
      !Object.prototype.hasOwnProperty.call(frame.params, 'requestId') ||
      (frame.params.reason !== undefined && typeof frame.params.reason !== 'string') ||
      !isRequestId(frame.params.requestId)) {
      writeProtocolError(undefined)
      return
    }
    const timer = pendingDelays.get(String(frame.params.requestId))
    if (timer) {
      clearTimeout(timer)
      pendingDelays.delete(String(frame.params.requestId))
      cancelledCount += 1
    }
    const subscription = subscriptions.get(String(frame.params.requestId))
    if (
      subscription &&
      process.env.NAVIDE_FIXTURE_LATE_ACK_AFTER_CANCEL === '1' &&
      !subscription.acknowledged
    ) {
      acknowledgeSubscription(subscription.id, subscription.events)
      emitSubscriptionEvent(subscription.id, subscription.events[0], { afterCancel: true })
      closeSubscription(subscription.id)
    }
    if (subscriptions.delete(String(frame.params.requestId))) cancelledCount += 1
    argumentPieces.delete(String(frame.params.requestId))
    return
  }

  if (!isHealthRequest(frame) && !isCallRequest(frame) && !isListenRequest(frame)) {
    writeProtocolError(frame?.id)
    return
  }

  if (frame.method === 'navide/health') {
    const value = {
      method: frame.method,
      protocolVersion: frame.params._meta['io.modelcontextprotocol/protocolVersion'],
      requestIdIsNonNull: frame.id !== null,
      clientCapabilities: frame.params._meta['io.modelcontextprotocol/clientCapabilities'],
    }
    if (process.env.NAVIDE_FIXTURE_ARGUMENT_CHUNKS !== '1') {
      response(frame.id, value)
      return
    }
    writeFrame({
      jsonrpc: '2.0',
      id: frame.id,
      result: {
        resultType: 'complete',
        value,
        _meta: { [SERVER_INFO_KEY]: { name: 'fixture.backend', version: '1.0.0' }, [ARGUMENT_CHUNKS_KEY]: {} },
      },
    })
    return
  }

  if (frame.method === 'subscriptions/listen') {
    const id = String(frame.id)
    const events = frame.params.notifications['dev.navide/pluginEvents']
    subscriptions.set(id, { id: frame.id, events, acknowledged: false })
    if (process.env.NAVIDE_FIXTURE_LATE_ACK_AFTER_CANCEL === '1') return
    if (process.env.NAVIDE_FIXTURE_EVENT_BEFORE_ACK === '1') {
      emitSubscriptionEvent(frame.id, events[0], { beforeAck: true })
    }
    acknowledgeSubscription(frame.id, events)
    subscriptions.get(id).acknowledged = true
    return
  }

  const { name } = frame.params
  let args = frame.params.arguments
  const argumentSummary = frame.params._meta[ARGUMENT_CHUNKS_KEY]
  if (isRecord(argumentSummary)) {
    const pieces = argumentPieces.get(String(frame.id)) ?? []
    argumentPieces.delete(String(frame.id))
    const text = pieces.join('')
    if (pieces.length !== argumentSummary.chunks || Buffer.byteLength(text, 'utf8') !== argumentSummary.bytes) {
      writeFrame({ jsonrpc: '2.0', id: frame.id, error: { code: 1000, message: 'pieces', data: { code: 'PLUGIN_TOOL_CHUNKS_INVALID' } } })
      return
    }
    args = JSON.parse(text)
  }
  if (name === 'fixture.hash') {
    const text = JSON.stringify(args)
    response(frame.id, {
      sha256: createHash('sha256').update(text, 'utf8').digest('hex'),
      bytes: Buffer.byteLength(text, 'utf8'),
      pieces: isRecord(argumentSummary) ? argumentSummary.chunks : 0,
    })
    return
  }
  if (name === 'fixture.pid') {
    response(frame.id, process.pid)
    return
  }
  if (name === 'fixture.bigresult') {
    // {bytes, mode}: a result of about `bytes` UTF-8 bytes (ASCII, CJK and emoji).
    // mode 'pieces' (default) sends pieces when the Host advertises them;
    // 'single' always sends one frame; 'drip' sends a short piece then another;
    // 'repeat' sends the same full piece twice; 'duplicate-key' sends one frame
    // whose value repeats a key.
    const unit = 'abc中文😀'
    const data = unit.repeat(Math.ceil((args?.bytes ?? 0) / Buffer.byteLength(unit, 'utf8')))
    const value = { data }
    const text = JSON.stringify(value)
    const bytes = Buffer.byteLength(text, 'utf8')
    const mode = args?.mode ?? 'pieces'
    const advertised = isRecord(frame.params._meta['io.modelcontextprotocol/clientCapabilities'][RESULT_CHUNKS_KEY])
    if (mode === 'drip') {
      writeFrame({ jsonrpc: '2.0', method: RESULT_CHUNK_METHOD, params: { requestId: frame.id, seq: 0, data: '{' } })
      writeFrame({ jsonrpc: '2.0', method: RESULT_CHUNK_METHOD, params: { requestId: frame.id, seq: 1, data: '"' } })
      return
    }
    const pieces = utf8Pieces(text, CHUNK_BYTES)
    if (mode === 'repeat') {
      writeFrame({ jsonrpc: '2.0', method: RESULT_CHUNK_METHOD, params: { requestId: frame.id, seq: 0, data: pieces[0] } })
      writeFrame({ jsonrpc: '2.0', method: RESULT_CHUNK_METHOD, params: { requestId: frame.id, seq: 0, data: pieces[0] } })
      return
    }
    if (mode === 'duplicate-key') {
      // One frame over the off-thread threshold whose value repeats a key.
      const frameText = JSON.stringify({
        jsonrpc: '2.0', id: frame.id,
        result: { resultType: 'complete', value, _meta: { [SERVER_INFO_KEY]: { name: 'fixture.backend', version: '1.0.0' } } },
      }).replace('{"data":', '{"a":1,"a":2,"data":')
      process.stdout.write(`${frameText}\n`)
      return
    }
    if (mode === 'single' || !advertised || pieces.length === 1) {
      response(frame.id, value)
      return
    }
    sendResultPieces(frame.id, pieces, bytes)
    return
  }
  if (name === 'fixture.bigexit') {
    // {bytes}: answers with one frame of about `bytes`, then exits as soon as
    // the frame is written.
    const unit = 'abc中文😀'
    const value = { data: unit.repeat(Math.ceil((args?.bytes ?? 0) / Buffer.byteLength(unit, 'utf8'))) }
    process.stdout.write(`${JSON.stringify({
      jsonrpc: '2.0', id: frame.id,
      result: { resultType: 'complete', value, _meta: { [SERVER_INFO_KEY]: { name: 'fixture.backend', version: '1.0.0' } } },
    })}\n`, () => process.exit(0))
    return
  }
  if (name === 'fixture.nonewline') {
    // {bytes}: writes `bytes` of a frame that never ends (no newline), in
    // 64 KiB writes, and never answers.
    const block = Buffer.alloc(65_536, 0x61)
    let left = args?.bytes ?? 0
    process.stdout.write('{"jsonrpc":"2.0","method":"notifications/navide/never","params":{"data":"')
    const next = () => {
      if (left <= 0) return
      const size = Math.min(left, block.length)
      left -= size
      if (process.stdout.write(block.subarray(0, size))) setImmediate(next)
      else process.stdout.once('drain', next)
    }
    next()
    return
  }
  if (name === 'plans.resolve_root') {
    const workspacePath = isRecord(args) && typeof args.workspace_path === 'string'
      ? args.workspace_path
      : ''
    if (!workspacePath) {
      writeProtocolError(frame.id)
      return
    }
    response(frame.id, { ok: true, root: workspacePath })
    for (const subscription of subscriptions.values()) {
      if (subscription.acknowledged && subscription.events.includes('plans.changed')) {
        emitSubscriptionEvent(subscription.id, 'plans.changed', { workspace_path: workspacePath })
      }
    }
    return
  }
  if (name === 'fixture.echo') {
    response(frame.id, { arguments: args, runtime: frame.params.runtime })
    return
  }
  if (name === 'fixture.publicerror') {
    writeFrame({
      jsonrpc: '2.0',
      id: frame.id,
      error: {
        code: 1000,
        message: 'Public plugin error',
        data: { code: 'INVALID_ARGUMENT', details: { retryable: false } },
      },
    })
    return
  }
  if (name === 'fixture.protocolerror') {
    writeFrame({
      jsonrpc: '2.0',
      id: frame.id,
      error: { code: -32601, message: 'Method not found' },
    })
    return
  }
  if (name === 'fixture.delay') {
    const milliseconds = isRecord(args) && typeof args.milliseconds === 'number'
      ? args.milliseconds
      : 100
    const key = String(frame.id)
    pendingDelays.set(key, setTimeout(() => {
      pendingDelays.delete(key)
      response(frame.id, { delayed: true })
    }, milliseconds))
    return
  }
  if (name === 'fixture.cancelcount') {
    response(frame.id, cancelledCount)
    return
  }
  if (name === 'fixture.pendingdelays') {
    response(frame.id, pendingDelays.size)
    return
  }
  if (name === 'fixture.emit') {
    const requestedId = isRecord(args) ? args.subscriptionId : undefined
    const subscription = isRequestId(requestedId)
      ? subscriptions.get(String(requestedId))
      : subscriptions.values().next().value
    if (!subscription || !isRecord(args) || !isEventName(args.event) || !isJsonPayload(args.payload)) {
      writeProtocolError(frame.id)
      return
    }
    emitSubscriptionEvent(subscription.id, args.event, args.payload)
    response(frame.id, { ok: true })
    return
  }
  if (name === 'fixture.forgedevent') {
    const subscriptionId = isRecord(args) && isRequestId(args.subscriptionId)
      ? args.subscriptionId
      : 'forged-subscription'
    emitSubscriptionEvent(subscriptionId, 'fixture.changed', { forged: true })
    response(frame.id, { ok: true })
    return
  }
  if (name === 'fixture.duplicateevent') {
    const subscription = subscriptions.values().next().value
    const subscriptionId = JSON.stringify(subscription?.id ?? 'forged-subscription')
    process.stdout.write(
      `{"jsonrpc":"2.0","method":"notifications/navide/event","params":{"_meta":{"io.modelcontextprotocol/subscriptionId":${subscriptionId},"io.modelcontextprotocol/subscriptionId":${subscriptionId}},"event":"fixture.changed","payload":{}}}\n`
    )
    return
  }
  if (name === 'fixture.unknownnotification') {
    writeFrame({ jsonrpc: '2.0', method: 'notifications/unknown', params: {} })
    return
  }
  if (name === 'fixture.progress') {
    const requestedId = isRecord(args) ? args.subscriptionId : undefined
    const subscription = isRequestId(requestedId)
      ? subscriptions.get(String(requestedId))
      : subscriptions.values().next().value
    if (!subscription) {
      writeProtocolError(frame.id)
      return
    }
    writeFrame({
      jsonrpc: '2.0',
      method: 'notifications/progress',
      params: {
        progressToken: subscription.id,
        progress: 1,
        total: 2,
        message: 'fixture progress',
      },
    })
    response(frame.id, { ok: true })
    return
  }
  if (name === 'fixture.close') {
    const requestedId = isRecord(args) ? args.subscriptionId : undefined
    const subscription = isRequestId(requestedId)
      ? subscriptions.get(String(requestedId))
      : subscriptions.values().next().value
    if (!subscription) {
      writeProtocolError(frame.id)
      return
    }
    subscriptions.delete(String(subscription.id))
    closeSubscription(subscription.id)
    response(frame.id, { ok: true })
    return
  }
  if (name === 'fixture.lateresponse') {
    const requestId = isRecord(args) ? args.requestId : undefined
    if (!isRequestId(requestId)) {
      writeProtocolError(frame.id)
      return
    }
    response(requestId, { late: true })
    response(frame.id, { ok: true })
    return
  }
  if (name === 'fixture.exit') {
    process.exit(17)
    return
  }
  if (name === 'fixture.stderr') {
    process.stderr.write('fixture diagnostic: /private/internal/path\n')
    response(frame.id, { ok: true })
    return
  }
  if (name === 'fixture.badversion') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.1',
      id: frame.id,
      result: {
        resultType: 'complete',
        value: true,
        _meta: { [SERVER_INFO_KEY]: { name: 'fixture.backend', version: '1.0.0' } },
      },
    }) + '\n')
    return
  }
  if (name === 'fixture.duplicatekeys') {
    process.stdout.write(`{"jsonrpc":"2.0","id":${JSON.stringify(frame.id)},"result":{"resultType":"complete","value":true,"_meta":{"${SERVER_INFO_KEY}":{"name":"fixture.backend","version":"1.0.0"}}},"result":{}}\n`)
    return
  }
  if (name === 'fixture.multiline') {
    process.stdout.write('{"jsonrpc":"2.0",\n')
    process.stdout.write(`"id":${JSON.stringify(frame.id)},"result":{"resultType":"complete","value":true,"_meta":{"${SERVER_INFO_KEY}":{"name":"fixture.backend","version":"1.0.0"}}}}\n`)
    return
  }
  if (name === 'fixture.unknownmethod') {
    writeFrame({ jsonrpc: '2.0', id: frame.id, method: 'tools/list', params: {} })
    return
  }
  if (name === 'fixture.forgedruntime') {
    writeFrame({
      jsonrpc: '2.0',
      id: frame.id,
      runtime: { pluginId: 'forged.plugin' },
      result: {
        resultType: 'complete',
        value: true,
        _meta: { [SERVER_INFO_KEY]: { name: 'fixture.backend', version: '1.0.0' } },
      },
    })
    return
  }

  writeFrame({
    jsonrpc: '2.0',
    id: frame.id,
    error: { code: -32601, message: 'Method not found' },
  })
}

function isJsonPayload(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isJsonPayload)
  if (!isRecord(value)) return false
  return Object.values(value).every(isJsonPayload)
}

function failClosed() {
  process.exitCode = 2
  process.stdin.destroy()
}

process.stdin.on('data', (chunk) => {
  input = Buffer.concat([input, chunk])
  while (true) {
    const newline = input.indexOf(0x0a)
    if (newline < 0) return
    const line = input.subarray(0, newline).toString('utf8')
    input = input.subarray(newline + 1)
    try {
      handle(parseStrict(line))
    } catch {
      failClosed()
      return
    }
  }
})

process.stdin.on('end', () => {
  if (input.length !== 0) failClosed()
})
