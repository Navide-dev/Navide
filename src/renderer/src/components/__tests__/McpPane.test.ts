// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { i18n } from '@navide/plugin-ui/foundation'
import McpPane from '../McpPane.vue'
import type { McpAgent, NativeMcpServer } from '../../lib/mcp-settings-editor'

const agents: McpAgent[] = [
  { key: 'claude', label: 'Claude Code', state: 'wired', reflects: true },
  { key: 'codex', label: 'Codex', state: 'wired', reflects: true },
  { key: 'droid', label: 'Droid', state: 'planned', reflects: true },
  { key: 'aider', label: 'Aider', state: 'unsupported', reflects: false },
]

/** Navide's own servers — the parent owns these and passes them down. */
function navideServers() {
  return [
    {
      name: 'context7',
      transport: 'stdio' as const,
      command: 'npx',
      args: ['-y', '@upstash/context7-mcp'],
      env: { API_KEY: 'sk-live', LOG_LEVEL: 'debug' },
      enabled: true,
      status: 'connected' as const,
      tool_count: 2,
      tools: [{ name: 'resolve', description: 'resolves ids' }],
    },
  ]
}

const native: NativeMcpServer[] = [
  {
    name: 'context7',
    agent: 'claude',
    transport: 'stdio',
    path: '/Users/x/.claude.json',
    command: 'npx',
    args: ['-y', '@upstash/context7-mcp'],
    url: '',
    env: { API_KEY: '***' },
    headers: {},
    enabled: true,
    valid: true,
    error: '',
  },
  {
    name: 'xmind',
    agent: 'codex',
    transport: 'http',
    path: '/Users/x/.codex/config.toml',
    command: '',
    args: [],
    url: 'https://app.xmind.com/mcp',
    env: {},
    headers: {},
    enabled: false,
    valid: true,
    error: '',
  },
]

function mountPane(overrides: Record<string, unknown> = {}): VueWrapper {
  return mount(McpPane, {
    props: { servers: navideServers(), native, agents, ...overrides },
    global: { plugins: [i18n] },
  }) as VueWrapper
}

async function openCard(wrapper: VueWrapper, name: string): Promise<void> {
  const card = wrapper.findAll('.mcp-card').find((c) => c.find('strong').text() === name)
  if (!card) throw new Error(`no card named ${name}`)
  await card.trigger('click')
  await flushPromises()
}

async function openCompareView(wrapper: VueWrapper): Promise<void> {
  const button = wrapper.findAll('.mcp-view-switch button').find((b) => b.text() === 'Compare')
  await button!.trigger('click')
  await flushPromises()
}

describe('McpPane', () => {
  let wrapper: VueWrapper | undefined
  const openPath = vi.fn().mockResolvedValue({ ok: true })

  beforeEach(() => {
    i18n.global.locale.value = 'en-US'
    window.agentTeam = { openPath } as unknown as typeof window.agentTeam
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
    openPath.mockClear()
    vi.restoreAllMocks()
  })

  it('lists both sources once, filing each row under where it came from', () => {
    wrapper = mountPane()

    // context7 is Navide's *and* claude's: one row, not two.
    const names = wrapper.findAll('.mcp-card strong').map((el) => el.text())
    expect(names).toEqual(['context7', 'xmind'])
    const groups = wrapper.findAll('.mcp-group-title').map((el) => el.text())
    expect(groups[0]).toContain('Navide')
    expect(groups[1]).toContain('Codex')
  })

  it('shows every place a server is configured on its card', () => {
    wrapper = mountPane()

    const card = wrapper.findAll('.mcp-card').find((c) => c.find('strong').text() === 'context7')
    expect(card!.findAll('.pchip').map((el) => el.text())).toEqual([
      'Navide',
      'claude',
      '2 tools',
    ])
    expect(card!.find('.mcp-status-dot').classes()).toContain('connected')
  })

  it('separates "not configured" from "this CLI has no MCP" in the matrix', async () => {
    wrapper = mountPane()
    await openCompareView(wrapper)

    const row = wrapper
      .findAll('tbody tr')
      .find((tr) => tr.find('.matrix-name').exists() && tr.find('.matrix-name').text() === 'context7')
    // Navide, claude, codex, droid, aider
    expect(row!.findAll('td').map((cell) => cell.attributes('class'))).toEqual([
      'here',
      'here',
      'off',
      'off',
      'unsupported',
    ])
  })

  it('marks a natively configured but switched-off server as disabled, not absent', async () => {
    wrapper = mountPane()
    await openCompareView(wrapper)

    const row = wrapper
      .findAll('tbody tr')
      .find((tr) => tr.find('.matrix-name').exists() && tr.find('.matrix-name').text() === 'xmind')
    const cells = row!.findAll('td')
    expect(cells[0].attributes('class')).toBe('off') // not one of Navide's
    expect(cells[2].attributes('class')).toBe('disabled') // codex, enabled:false
  })

  it('filters by source and by search text', async () => {
    wrapper = mountPane()

    const codexChip = wrapper.findAll('.mcp-chip').find((c) => c.text().startsWith('codex'))
    await codexChip!.trigger('click')
    expect(wrapper.findAll('.mcp-card strong').map((el) => el.text())).toEqual(['xmind'])

    const allChip = wrapper.findAll('.mcp-chip').find((c) => c.text().startsWith('All'))
    await allChip!.trigger('click')
    await wrapper.find('.mcp-pane-search').setValue('upstash')
    expect(wrapper.findAll('.mcp-card strong').map((el) => el.text())).toEqual(['context7'])
  })

  it('edits one of Navide’s own servers and hands the result to the parent', async () => {
    wrapper = mountPane()
    await openCard(wrapper, 'context7')

    const command = wrapper.find('.mcp-editor input[placeholder="npx"]')
    await command.setValue('bunx')
    await wrapper.find('.mcp-drawer-actions.end button.primary').trigger('click')

    const saved = wrapper.emitted('save')
    expect(saved).toHaveLength(1)
    expect((saved![0][0] as { command: string }).command).toBe('bunx')
  })

  it('leaves the parent’s server untouched until the edit is saved', async () => {
    const servers = navideServers()
    wrapper = mountPane({ servers })
    await openCard(wrapper, 'context7')

    await wrapper.find('.mcp-editor input[placeholder="npx"]').setValue('bunx')

    // The draft is a copy: an abandoned edit must not reach saved settings.
    expect(servers[0].command).toBe('npx')
    expect(wrapper.emitted('save')).toBeUndefined()
  })

  it('masks a secret env value until it is revealed', async () => {
    wrapper = mountPane()
    await openCard(wrapper, 'context7')

    const rows = wrapper.findAll('.mcp-editor .mcp-kv-row')
    const secretRow = rows.find((row) => (row.find('input').element as HTMLInputElement).value === 'API_KEY')
    const valueInput = secretRow!.findAll('input')[1]
    expect(valueInput.attributes('type')).toBe('password')

    await secretRow!.findAll('button').find((b) => b.text() === 'Show')!.trigger('click')
    expect(secretRow!.findAll('input')[1].attributes('type')).toBe('text')
  })

  it('says which servers still need a value filled in on this machine', async () => {
    const synced = { ...navideServers()[0], env: { API_KEY: '', LOG_LEVEL: 'debug' } }
    wrapper = mountPane({ servers: [synced] })
    expect(wrapper.find('.mcp-card .pchip.needs').text()).toBe('Needs setup')
    await openCard(wrapper, 'context7')
    expect(wrapper.find('.mcp-drawer-hint.warn').text()).toContain('never sync between devices')

    await wrapper.setProps({ servers: navideServers() })
    await flushPromises()
    expect(wrapper.find('.pchip.needs').exists()).toBe(false)
  })

  it('says a server needs setup when a credential in its arguments or URL arrived empty', async () => {
    const synced = { ...navideServers()[0], args: ['-y', 'srv', '--token', ''] }
    wrapper = mountPane({ servers: [synced] })
    expect(wrapper.find('.mcp-card .pchip.needs').text()).toBe('Needs setup')
    await openCard(wrapper, 'context7')
    expect(wrapper.find('.mcp-drawer-hint.warn').text()).toContain('credentials in the URL and arguments')

    const remote = { name: 'remote', transport: 'http', url: 'https://@mcp.example.test/v1?api_key=', headers: {}, enabled: true }
    await wrapper.setProps({ servers: [remote] })
    await flushPromises()
    expect(wrapper.find('.mcp-card .pchip.needs').exists()).toBe(true)

    await wrapper.setProps({ servers: [{ ...remote, url: 'https://mcp.example.test/v1?region=eu' }, navideServers()[0]] })
    await flushPromises()
    expect(wrapper.find('.pchip.needs').exists()).toBe(false)
  })

  it('asks the parent to remove a server rather than deleting it itself', async () => {
    wrapper = mountPane()
    await openCard(wrapper, 'context7')

    await wrapper.findAll('.mcp-drawer-actions.end button').find((b) => b.text() === 'Delete')!.trigger('click')

    expect(wrapper.emitted('remove')).toEqual([['context7']])
  })

  it('saves immediately when the enable switch is flipped', async () => {
    wrapper = mountPane()
    await openCard(wrapper, 'context7')

    await wrapper.find('.mcp-drawer-toggle button[role="switch"]').trigger('click')

    const saved = wrapper.emitted('save')
    expect((saved![0][0] as { enabled: boolean }).enabled).toBe(false)
  })

  it('offers no way to edit a native config, only to open it', async () => {
    wrapper = mountPane({ servers: [] })
    await openCard(wrapper, 'xmind')

    const drawer = wrapper.find('.mcp-drawer')
    expect(drawer.find('.mcp-editor').exists()).toBe(false)
    expect(drawer.findAll('input')).toHaveLength(0)
    expect(drawer.text()).toContain('/Users/x/.codex/config.toml')

    await drawer.findAll('button').find((b) => b.text() === 'Open Config File')!.trigger('click')
    await flushPromises()
    expect(openPath).toHaveBeenCalledWith('/Users/x/.codex/config.toml')
  })

  it('opens the editor on a server the parent just added, and says it is done', async () => {
    wrapper = mountPane({ selectName: 'context7' })
    await flushPromises()

    expect(wrapper.find('.mcp-editor').exists()).toBe(true)
    expect(wrapper.find('.mcp-drawer-title h3').text()).toBe('context7')
    // Without this the drawer would pop open again on every remount.
    expect(wrapper.emitted('select-consumed')).toHaveLength(1)
  })

  it('drops the editor but keeps the row when a server is removed from Navide only', async () => {
    // context7 is also in claude's own config, so the row survives as a
    // read-only reflection — losing it would be the wrong answer.
    wrapper = mountPane()
    await openCard(wrapper, 'context7')
    expect(wrapper.find('.mcp-editor').exists()).toBe(true)

    await wrapper.setProps({ servers: [] })
    await flushPromises()

    expect(wrapper.find('.mcp-drawer').exists()).toBe(true)
    expect(wrapper.find('.mcp-editor').exists()).toBe(false)
    expect(wrapper.find('.mcp-drawer').text()).toContain('Claude Code')
  })

  it('closes the drawer when the removed server existed nowhere else', async () => {
    const solo = [
      { name: 'solo', transport: 'stdio' as const, command: 'npx', args: [], env: {}, enabled: true },
    ]
    wrapper = mountPane({ servers: solo, native: [] })
    await openCard(wrapper, 'solo')
    expect(wrapper.find('.mcp-editor').exists()).toBe(true)

    await wrapper.setProps({ servers: [] })
    await flushPromises()

    expect(wrapper.find('.mcp-drawer').exists()).toBe(false)
  })

  it('reports a config it could not read instead of dropping it', async () => {
    wrapper = mountPane({
      servers: [],
      native: [
        {
          name: 'config.toml',
          agent: 'codex',
          transport: 'unknown',
          path: '/Users/x/.codex/config.toml',
          command: '',
          args: [],
          url: '',
          env: {},
          headers: {},
          enabled: true,
          valid: false,
          error: 'invalid TOML: line 3',
        },
      ],
    })

    expect(wrapper.find('.mcp-card-detail').text()).toContain('invalid TOML')
    await openCard(wrapper, 'config.toml')
    expect(wrapper.find('.mcp-drawer-hint.danger').text()).toContain('invalid TOML')
  })

  it('says so when nothing is configured anywhere', () => {
    wrapper = mountPane({ servers: [], native: [] })

    expect(wrapper.find('.nv-empty').exists()).toBe(true)
    expect(wrapper.findAll('.mcp-card')).toHaveLength(0)
  })

  it('asks the parent to reload rather than fetching for itself', async () => {
    wrapper = mountPane()

    await wrapper.find('.mcp-pane-head button').trigger('click')

    expect(wrapper.emitted('refresh')).toHaveLength(1)
  })

  describe('a server that is starting or failed to start', () => {
    function withStatus(fields: Record<string, unknown>) {
      return [{ ...navideServers()[0], tool_count: 0, tools: [], ...fields }]
    }

    afterEach(() => {
      vi.useRealTimers()
    })

    it('says a slow start may be a first download, and refreshes until it settles', async () => {
      vi.useFakeTimers()
      wrapper = mountPane({
        servers: withStatus({
          status: 'starting', starting_seconds: 22, slow_start: true,
          stderr_tail: 'npm warn exec The following package was not found and will be installed',
        }),
        selectName: 'context7',
      })
      await flushPromises()

      expect(wrapper.find('[data-testid="mcp-starting-note"]').text()).toContain('22 s')
      expect(wrapper.find('[data-testid="mcp-starting-note"]').text()).toContain('npx')
      expect(wrapper.find('[data-testid="mcp-stderr-tail"] pre').text()).toContain('will be installed')
      expect(wrapper.find('.mcp-status-dot.starting').exists()).toBe(true)

      vi.advanceTimersByTime(3000)
      expect(wrapper.emitted('refresh')).toHaveLength(1)

      await wrapper.setProps({ servers: withStatus({ status: 'connected' }) })
      vi.advanceTimersByTime(9000)
      expect(wrapper.emitted('refresh')).toHaveLength(1)
    })

    it('shows no note while a start is still quick', async () => {
      wrapper = mountPane({
        servers: withStatus({ status: 'starting', starting_seconds: 3, slow_start: false }),
        selectName: 'context7',
      })
      await flushPromises()

      expect(wrapper.find('[data-testid="mcp-starting-note"]').exists()).toBe(false)
    })

    it('shows why a server failed to start', async () => {
      wrapper = mountPane({
        servers: withStatus({
          status: 'error',
          error: 'the server exited with code 1 before answering initialize',
          stderr_tail: 'npm error 404 Not Found',
        }),
        selectName: 'context7',
      })
      await flushPromises()

      expect(wrapper.find('[data-testid="mcp-error-reason"]').text()).toBe(
        'Failed to start: the server exited with code 1 before answering initialize',
      )
      expect(wrapper.find('[data-testid="mcp-stderr-tail"] pre').text()).toBe('npm error 404 Not Found')
    })

    it('says the tool list could not be read instead of showing zero tools', async () => {
      wrapper = mountPane({
        servers: withStatus({ status: 'connected', tool_count: 0, tools: [], tools_error: 'listing tools timed out' }),
        selectName: 'context7',
      })
      await flushPromises()

      expect(wrapper.find('[data-testid="mcp-tools-error"]').text()).toBe(
        'Could not list its tools: listing tools timed out',
      )
    })
  })

  describe('a server that needs Node.js', () => {
    it('says so on the card and offers the install in the drawer', async () => {
      wrapper = mountPane({ nodeMissing: true })

      const card = wrapper.findAll('.mcp-card').find((c) => c.find('strong').text() === 'context7')!
      expect(card.get('[data-testid="mcp-needs-node"]').text()).toBe(i18n.global.t('settings.mcp.needs-node'))

      await openCard(wrapper, 'context7')
      const notice = wrapper.get('[data-testid="mcp-needs-node-notice"]')
      expect(notice.text()).toContain(i18n.global.t('settings.mcp.needs-node-hint', { command: 'npx' }))
      await notice.get('button').trigger('click')
      expect(wrapper.emitted('install-node')).toEqual([[]])
    })

    it('stays quiet while Node.js is there, and for servers that do not use it', async () => {
      wrapper = mountPane()
      expect(wrapper.find('[data-testid="mcp-needs-node"]').exists()).toBe(false)
      wrapper.unmount()

      const servers = navideServers().map((s) => ({ ...s, command: '/usr/local/bin/uvx' }))
      wrapper = mountPane({ nodeMissing: true, servers })
      expect(wrapper.find('[data-testid="mcp-needs-node"]').exists()).toBe(false)
    })

    it('recognises a Windows npx.cmd by its full path', async () => {
      const servers = navideServers().map((s) => ({ ...s, command: 'C:\\Program Files\\nodejs\\npx.cmd' }))
      wrapper = mountPane({ nodeMissing: true, servers })
      expect(wrapper.find('[data-testid="mcp-needs-node"]').exists()).toBe(true)
    })
  })
})
