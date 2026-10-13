import { describe, expect, it } from 'vitest'
import { MASK, maskArgs, maskMcpRecord, maskUrl } from '../syncMask'

// The 38 inputs from the D1/D2 security review (sec-review/D/mask.mjs). Each
// names the secret that must not survive; markers like S1 are matched as a
// whole token so S1 does not pass by hiding inside S10.
function leaks(output: string, secret: string): boolean {
  const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`${escaped}(?![0-9])`).test(output)
}

const URLS: Array<[string, string]> = [
  ['https://user:tok@host/x', 'tok'],
  ['https://tok@host/x', 'tok'],
  ['https://host/x?api_key=S1&b=2', 'S1'],
  ['https://host/x#access_token=S2', 'S2'],
  ['https://host/mcp/S3secretpath', 'S3secretpath'],
  ['https://host/x;token=S4', 'S4'],
  ['https://a:b@c@host/x', 'b@c'],
  ['HTTPS://u:S5@h/', 'S5'],
]

const ARGS: Array<[string[], string | null]> = [
  [['-y', 'mcp-remote', 'https://host/sse?token=S6'], 'S6'],
  [['-y', 'mcp-remote', 'https://u:S7@host/sse'], 'S7'],
  [['--header', 'X-API-Key: S8'], 'S8'],
  [['-H', 'X-Api-Key:S9'], 'S9'],
  [['--header', 'Cookie: session=S10'], 'S10'],
  [['--pat', 'S11'], 'S11'],
  [['-k', 'S12'], 'S12'],
  [['--credentials', 'S13'], 'S13'],
  [['--api-key', 'S14', '--model', 'x'], 'S14'],
  [['--token=S15'], 'S15'],
  [['GITHUB_PERSONAL_ACCESS_TOKEN=S16'], 'S16'],
  [['--url=https://host/?x=S17'], 'S17'],
  [['--connection-string', 'postgres://u:S18@db/x'], 'S18'],
  [['postgres://u:S19@db/x'], 'S19'],
  [['--header', 'Authorization:Basic S20'], 'S20'],
  [['--header=Authorization: Bearer S21'], 'S21'],
  [['Authorization', 'Bearer S22'], 'S22'],
  [['--header', 'Proxy-Authorization: S23'], 'S23'],
  [['ghp_S24abcdefghijklmnopqrstuvwxyz0123456789'], 'S24'],
  [['--api-key', '--verbose', 'S25'], 'S25'],
  [['--key-file', '/path'], null],
  [['--access_token', 'S26'], 'S26'],
  [['--Token', 'S27'], 'S27'],
  [['-e', 'API_KEY=S28'], 'S28'],
  [['--env', 'OPENAI_API_KEY', 'S29'], 'S29'],
  [['--db', 'mysql://root:S30@h'], 'S30'],
  [['--sig=S31'], 'S31'],
  [['--client-secret', 'S32'], 'S32'],
  [['--header', 'x-goog-api-key: S33'], 'S33'],
  [['--password'], null],
]

describe('maskUrl', () => {
  it.each(URLS)('masks the secret in %s', (url, secret) => {
    const out = maskUrl(url)
    expect(leaks(out, secret)).toBe(false)
    expect(out).toContain(MASK)
  })

  it('keeps scheme, host and an ordinary path readable', () => {
    expect(maskUrl('https://api.example.com/v1/sse')).toBe('https://api.example.com/v1/sse')
    expect(maskUrl('https://host/x?api_key=S1&b=2')).toContain('api_key=')
  })
})

describe('maskArgs', () => {
  it.each(ARGS)('masks the secret in %j', (args, secret) => {
    const out = maskArgs(args)
    expect(out).toHaveLength(args.length)
    const text = JSON.stringify(out)
    if (secret) expect(leaks(text, secret)).toBe(false)
  })

  it('masks bare token shapes wherever they appear', () => {
    const bare = [
      'gho_abcdefghijklmnop1234',
      'github_pat_11ABCDEFG0123456789_abcdefghijk',
      'sk-proj-abcdefghij1234567890',
      'xoxb-1234567890-abcdefghij',
      'AKIAABCDEFGHIJKLMNOP',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl',
      '0123456789abcdef0123456789abcdef',
      'QWxhZGRpbjpvcGVuIHNlc2FtZTEyMzQ1Njc4OTA=',
    ]
    for (const token of bare) {
      expect(JSON.stringify(maskArgs([token]))).not.toContain(token.slice(4, 14))
      expect(JSON.stringify(maskArgs([`--foo=${token}`]))).not.toContain(token.slice(4, 14))
    }
  })

  it('keeps an ordinary command line readable', () => {
    expect(maskArgs(['-y', '@modelcontextprotocol/server-github', '--model', 'x', '--verbose'])).toEqual([
      '-y',
      '@modelcontextprotocol/server-github',
      '--model',
      'x',
      '--verbose',
    ])
    expect(maskArgs(['--env', 'OPENAI_API_KEY', 'S29'])[1]).toBe('OPENAI_API_KEY')
  })
})

describe('maskMcpRecord', () => {
  it('masks env and header values but keeps their names', () => {
    const out = maskMcpRecord({ env: { TOKEN: 'v1' }, headers: { 'X-Key': 'v2' } }) as Record<string, unknown>
    expect(out.env).toEqual({ TOKEN: MASK })
    expect(out.headers).toEqual({ 'X-Key': MASK })
  })
})

// Second review (R-C3, sec-review2/C/mask2.ts): values glued to short flags,
// JSON inside an argument, more secret names, space-separated headers and
// URLs WHATWG would accept with backslashes.
describe('second review (R-C3)', () => {
  const ARGS2: Array<[string[], string]> = [
    [['-HX-Api-Key:S61'], 'S61'],
    [['-HAuthorization: Bearer S86'], 'S86'],
    [['-uadmin:S92'], 'S92'],
    [['-pS93'], 'S93'],
    [['{"apiKey":"S66"}'], 'S66'],
    [['--config', '{"apiKey":"S67x"}'], 'S67x'],
    [['--json={"token":"S68"}'], 'S68'],
    [['--config', '{"apiKey":S67y'], 'S67y'],
    [['--passphrase', 'S89'], 'S89'],
    [['--header', 'apikey S101'], 'S101'],
    [['https:/\\/u:S51@h/x'], 'S51'],
    [['--url', 'https:\\\\u:S52@h/x'], 'S52'],
    [['--ＡＰＩ-ＫＥＹ', 'S79'], 'S79'],
    [['-a', 'S82'], 'S82'],
  ]

  it.each(ARGS2)('masks the secret in %j', (args, secret) => {
    expect(leaks(JSON.stringify(maskArgs(args)), secret)).toBe(false)
  })

  it('keeps the JSON readable apart from its secret values', () => {
    const out = maskArgs(['--config', '{"apiKey":"S66","model":"gpt","url":"https://u:S9@h/"}'])[1] as string
    expect(JSON.parse(out)).toEqual({ apiKey: MASK, model: 'gpt', url: `https://${MASK}@h/` })
  })

  it('masks a WHATWG-normalised URL and a path segment after a secret name', () => {
    expect(leaks(maskUrl('https:/\\/u:S51@h/x'), 'S51')).toBe(false)
    expect(leaks(maskUrl('https://host/sse/key/S46'), 'S46')).toBe(false)
    expect(maskUrl('https://host/sse/key/S46')).toContain('/key/')
  })

  it('masks secrets in any field of an MCP record, nested ones included', () => {
    const record = {
      command: 'x',
      url: 'https://u:S200@h/?token=S201',
      args: ['--token', 'S202'],
      env: { A: 'S203' },
      headers: { H: 'S204' },
      envFile: 'S205',
      auth: { token: 'S206' },
      oauth: { clientSecret: 'S207' },
      transport: { headers: { Authorization: 'S208' } },
      cwd: '/home/x',
      bearer_token: 'S209',
      apiKey: 'S210',
      http_headers: { A: 'S211' },
      env_http_headers: { A: 'S212' },
    }
    const out = JSON.stringify(maskMcpRecord(record))
    for (let i = 200; i <= 212; i += 1) expect(leaks(out, `S${i}`)).toBe(false)
    const shown = maskMcpRecord(record) as Record<string, unknown>
    expect(shown.command).toBe('x')
    expect(shown.cwd).toBe('/home/x')
    expect(shown.transport).toEqual({ headers: { Authorization: MASK } })
  })
})
