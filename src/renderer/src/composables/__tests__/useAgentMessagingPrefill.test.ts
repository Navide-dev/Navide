import { describe, it, expect, beforeEach } from 'vitest'
import {
  useAgentMessaging,
  _resetMessagingForTest,
  TERMINAL_AGENT_KEY,
  type MessagingDeps,
} from '../useAgentMessaging'

function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0))
}

describe('useAgentMessaging — terminal prefill (cli_send submit: false)', () => {
  let delivered: Array<{ paneId: string; text: string; prefill: boolean | undefined; args: number }>
  let m: ReturnType<typeof useAgentMessaging>

  const deps: MessagingDeps = {
    now: () => 1_000_000,
    deliver: async (...args) => {
      const [paneId, text, , prefill] = args
      delivered.push({ paneId, text, prefill, args: args.length })
      return true
    },
    isPaneIdle: () => true,
  }

  beforeEach(() => {
    _resetMessagingForTest()
    delivered = []
    m = useAgentMessaging()
    m.configureMessaging(deps)
    m.registerPane('pt', TERMINAL_AGENT_KEY)
    m.registerPane('pc', 'claude')
  })

  it('hands a prefill to deliver with the flag, and the bare command', async () => {
    expect(m.acceptRemoteMessage({
      msgKey: 'pa:mcp:1', targetPaneId: 'pt', fromDisplay: 'sender', content: 'sudo -v', prefill: true,
    })).toBe(true)
    await m.pump()
    await flush()
    expect(delivered).toEqual([{ paneId: 'pt', text: 'sudo -v', prefill: true, args: 4 }])
  })

  it('an ordinary message is delivered exactly as before', async () => {
    m.acceptRemoteMessage({ msgKey: 'pa:mcp:2', targetPaneId: 'pt', fromDisplay: 'sender', content: 'ls' })
    await m.pump()
    await flush()
    expect(delivered).toEqual([{ paneId: 'pt', text: 'ls', prefill: undefined, args: 3 }])
  })

  it('ignores the flag for an agent pane', async () => {
    m.acceptRemoteMessage({
      msgKey: 'pa:mcp:3', targetPaneId: 'pc', fromDisplay: 'sender', content: 'hi', prefill: true,
    })
    await m.pump()
    await flush()
    expect(delivered).toHaveLength(1)
    expect(delivered[0].prefill).toBeUndefined()
  })
})
