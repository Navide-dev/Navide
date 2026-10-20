import { describe, expect, it } from 'vitest'
import { capabilitiesV1 } from '../../../packages/plugin-contracts/src/index'
import { PUBLIC_CAPABILITY_CATALOG } from './pluginCapabilityCatalog'
import {
  WEB_BRIDGE_OPERATIONS,
  WEB_EVENTS,
  WEB_GESTURE_METHODS,
  WEB_METHODS,
  isAllowedWebUrl,
  validateWebBridgeRequest,
  validateWebChangedEvent,
  validateWebRequest,
} from './webCapability'

const view = {
  viewId: 'view-1',
  space: 'Research',
  owner: 'agent',
  control: 'agent',
  state: 'running',
  url: 'https://example.com/',
  title: 'Example',
  loading: false,
  attached: true,
  agentScriptSinceLoad: false,
}

describe('web URL allowlist', () => {
  it('accepts only http(s) URLs and exactly about:blank', () => {
    for (const url of ['https://example.com', 'http://localhost:3000/a?b=c#d', 'about:blank']) {
      expect(isAllowedWebUrl(url)).toBe(true)
    }
  })

  it.each([
    'javascript:alert(1)',
    'JAVASCRIPT:alert(1)',
    'file:///etc/passwd',
    'data:text/html,<script>alert(1)</script>',
    'chrome://settings',
    'devtools://devtools/bundled/inspector.html',
    'blob:https://example.com/uuid',
    'view-source:https://example.com',
    'about:config',
    'about:blank#x',
    'https://user:pass@example.com/',
    'https://user@example.com/',
    'ftp://example.com/',
    'https://',
    'not a url',
    ' https://example.com',
    'https://exa\tmple.com',
    '',
  ])('rejects %s', (url) => {
    expect(isAllowedWebUrl(url)).toBe(false)
  })

  it('rejects non-strings and over-long URLs', () => {
    expect(isAllowedWebUrl(undefined)).toBe(false)
    expect(isAllowedWebUrl(new URL('https://example.com'))).toBe(false)
    expect(isAllowedWebUrl(`https://example.com/${'a'.repeat(8192)}`)).toBe(false)
    expect(isAllowedWebUrl(`https://example.com/${'a'.repeat(8000)}`)).toBe(true)
  })
})

describe('web view capability requests', () => {
  it('lists the contract surface', () => {
    expect(WEB_METHODS).toEqual([
      'web.list', 'web.create', 'web.attach', 'web.detach', 'web.navigate',
      'web.setOwner', 'web.takeControl', 'web.returnControl', 'web.close', 'web.capture', 'web.clearData',
    ])
    expect(WEB_EVENTS).toEqual(['web.changed'])
    expect([...WEB_GESTURE_METHODS].sort()).toEqual(['web.clearData', 'web.create', 'web.returnControl', 'web.setOwner', 'web.takeControl'])
  })

  it.each([
    ['web.list', {}],
    ['web.clearData', {}],
    ['web.create', { space: 'Research' }],
    ['web.create', { space: 'Research', url: 'https://example.com' }],
    ['web.attach', { viewId: 'view-1', rect: { x: 0, y: 12.5, width: 1, height: 16384 } }],
    ['web.detach', { viewId: 'view-1' }],
    ['web.close', { viewId: 'view-1' }],
    ['web.returnControl', { viewId: 'view-1' }],
    ['web.takeControl', { viewId: 'view-1' }],
    ['web.navigate', { viewId: 'view-1', url: 'about:blank' }],
    ['web.navigate', { viewId: 'view-1', action: 'back' }],
    ['web.navigate', { viewId: 'view-1', action: 'stop' }],
    ['web.setOwner', { viewId: 'view-1', owner: 'agent' }],
    ['web.setOwner', { viewId: 'view-1', owner: 'user' }],
    ['web.capture', { viewId: 'view-1' }],
    ['web.capture', { viewId: 'view-1', maxWidth: 64 }],
    ['web.capture', { viewId: 'view-1', maxWidth: 2048 }],
  ])('accepts %s %j', (address, value) => {
    expect(validateWebRequest(address, value)).toBe(true)
  })

  it.each([
    ['web.unknown', {}],
    ['web.list', null],
    ['web.list', []],
    ['web.list', { extra: true }],
    ['web.clearData', { pluginId: 'other' }],
    ['web.create', {}],
    ['web.create', { space: '' }],
    ['web.create', { space: 'x'.repeat(129) }],
    ['web.create', { space: 'Research', url: 'javascript:alert(1)' }],
    ['web.create', { space: 'Research', partition: 'persist:other' }],
    ['web.attach', { viewId: 'view-1' }],
    ['web.attach', { viewId: 'view-1', rect: { x: -1, y: 0, width: 10, height: 10 } }],
    ['web.attach', { viewId: 'view-1', rect: { x: 0, y: 0, width: 0, height: 10 } }],
    ['web.attach', { viewId: 'view-1', rect: { x: 0, y: 0, width: 16385, height: 10 } }],
    ['web.attach', { viewId: 'view-1', rect: { x: Number.NaN, y: 0, width: 10, height: 10 } }],
    ['web.attach', { viewId: 'view-1', rect: { x: 0, y: Infinity, width: 10, height: 10 } }],
    ['web.attach', { viewId: 'view-1', rect: { x: 0, y: 0, width: 10, height: 10, z: 1 } }],
    ['web.attach', { viewId: 'view-1', rect: { x: '0', y: 0, width: 10, height: 10 } }],
    ['web.detach', {}],
    ['web.detach', { viewId: '' }],
    ['web.close', { viewId: 'x'.repeat(129) }],
    ['web.close', { viewId: 1 }],
    ['web.returnControl', { viewId: 'view-1', control: 'agent' }],
    ['web.takeControl', {}],
    ['web.takeControl', { viewId: 'view-1', reason: 'manual_takeover' }],
    ['web.navigate', { viewId: 'view-1' }],
    ['web.navigate', { viewId: 'view-1', url: 'https://example.com', action: 'reload' }],
    ['web.navigate', { viewId: 'view-1', url: 'file:///etc/passwd' }],
    ['web.navigate', { viewId: 'view-1', action: 'go' }],
    ['web.setOwner', { viewId: 'view-1' }],
    ['web.setOwner', { viewId: 'view-1', owner: 'host' }],
    ['web.capture', { viewId: 'view-1', maxWidth: 63 }],
    ['web.capture', { viewId: 'view-1', maxWidth: 2049 }],
    ['web.capture', { viewId: 'view-1', maxWidth: 100.5 }],
  ])('rejects %s %j', (address, value) => {
    expect(validateWebRequest(address, value)).toBe(false)
  })

  it('is the validator the public catalog uses, and the JSON catalog agrees', () => {
    const methods = (capabilitiesV1 as {
      methods: Array<{ address: string; permission: unknown; requiresUserGesture?: boolean }>
      events: Array<{ address: string; permission: unknown }>
    })
    for (const address of WEB_METHODS) {
      const entry = PUBLIC_CAPABILITY_CATALOG[address]
      expect(entry).toMatchObject({ kind: 'method', namespace: 'web', scope: 'plugin', eligibility: 'public' })
      expect(entry?.requiresUserGesture === true).toBe(WEB_GESTURE_METHODS.has(address))
      const json = methods.methods.find((method) => method.address === address)
      expect(json?.permission).toEqual({ id: 'system', access: 'web', scope: 'plugin' })
      expect(json?.requiresUserGesture === true).toBe(WEB_GESTURE_METHODS.has(address))
    }
    expect(PUBLIC_CAPABILITY_CATALOG['web.create']?.validateRequest?.({ space: 'a', url: 'file:///x' })).toBe(false)
    expect(PUBLIC_CAPABILITY_CATALOG['web.changed']).toMatchObject({ kind: 'event', namespace: 'web' })
    expect(methods.events.find((event) => event.address === 'web.changed')?.permission)
      .toEqual({ id: 'system', access: 'web', scope: 'plugin' })
  })
})

describe('web.changed event payload', () => {
  it('accepts a list of WebViewInfo', () => {
    expect(validateWebChangedEvent({ views: [] })).toBe(true)
    expect(validateWebChangedEvent({ views: [view, { ...view, note: 'Sign in', state: 'need-action', control: 'user' }] })).toBe(true)
  })

  it.each([
    null,
    {},
    { views: {} },
    { views: [], extra: 1 },
    { views: [{ ...view, owner: 'host' }] },
    { views: [{ ...view, control: 'nobody' }] },
    { views: [{ ...view, state: 'paused' }] },
    { views: [{ ...view, loading: 'no' }] },
    { views: [{ ...view, attached: undefined }] },
    { views: [{ ...view, viewId: '' }] },
    { views: [{ ...view, title: 1 }] },
    { views: [{ ...view, note: 2 }] },
    { views: [{ ...view, partition: 'persist:navide-web:x' }] },
  ])('rejects %j', (value) => {
    expect(validateWebChangedEvent(value)).toBe(false)
  })
})

describe('web bridge port requests', () => {
  it('lists the bridge operations', () => {
    expect(WEB_BRIDGE_OPERATIONS).toEqual(['list', 'create', 'close', 'cdp', 'setState'])
  })

  it.each([
    ['list', {}],
    ['create', { space: 'Research' }],
    ['create', { space: 'Research', url: 'https://example.com' }],
    ['close', { viewId: 'view-1' }],
    ['cdp', { viewId: 'view-1', method: 'Accessibility.getFullAXTree' }],
    ['cdp', { viewId: 'view-1', method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', x: 1, y: 2 } }],
    ['setState', { viewId: 'view-1', state: 'need-action', note: 'Please sign in' }],
    ['setState', { viewId: 'view-1', state: 'done' }],
  ])('accepts %s %j', (operation, value) => {
    expect(validateWebBridgeRequest(operation, value)).toBe(true)
  })

  it.each([
    ['attach', { viewId: 'view-1' }],
    ['list', { all: true }],
    ['create', {}],
    ['create', { space: 'Research', url: 'chrome://settings' }],
    ['close', {}],
    ['cdp', { viewId: 'view-1' }],
    ['cdp', { viewId: 'view-1', method: 'accessibility.getFullAXTree' }],
    ['cdp', { viewId: 'view-1', method: 'Runtime' }],
    ['cdp', { viewId: 'view-1', method: 'Runtime.evaluate.x' }],
    ['cdp', { viewId: 'view-1', method: `A.${'b'.repeat(127)}` }],
    ['cdp', { viewId: 'view-1', method: 'Page.navigate', params: [] }],
    ['cdp', { viewId: 'view-1', method: 'Page.navigate', params: new Date() }],
    ['cdp', { viewId: 'view-1', method: 'Page.navigate', sessionId: 'other' }],
    ['setState', { viewId: 'view-1', state: 'paused' }],
    ['setState', { viewId: 'view-1', state: 'done', note: 'x'.repeat(501) }],
    ['setState', { viewId: 'view-1', state: 'done', control: 'user' }],
  ])('rejects %s %j', (operation, value) => {
    expect(validateWebBridgeRequest(operation, value)).toBe(false)
  })
})
