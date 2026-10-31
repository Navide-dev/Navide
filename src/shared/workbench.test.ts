import { describe, expect, it } from 'vitest'
import { EMPTY_WORKBENCH, MAX_WORKBENCH_BUTTONS, parseWorkbench } from './workbench'

const button = (id: string, label = 'Run') => ({ id, label, steps: [{ action: 'workbench.action.quickOpen' }] })
const file = (buttons: unknown[], extra = {}) => JSON.stringify({ schemaVersion: 1, buttons, ...extra })

describe('parseWorkbench', () => {
  it.each(['', 'not json', '[]', '{"schemaVersion":2,"buttons":[]}', '{"schemaVersion":1}'])(
    'reads %j as no buttons', (text) => {
      expect(parseWorkbench(text)).toEqual({ config: EMPTY_WORKBENCH, dropped: 0 })
    })

  it('keeps a good button, with its args', () => {
    const good = { id: 'a', label: 'Go', steps: [{ action: 'x.y', args: { tab: 1 } }] }
    expect(parseWorkbench(file([good])).config.buttons).toEqual([good])
  })

  it.each([
    ['a label with markup', { id: 'a', label: '<b>', steps: [{ action: 'x' }] }],
    ['a blank label', { id: 'a', label: '  ', steps: [{ action: 'x' }] }],
    ['no steps', { id: 'a', label: 'Go', steps: [] }],
    ['a step with no action', { id: 'a', label: 'Go', steps: [{}] }],
    ['args that are not an object', { id: 'a', label: 'Go', steps: [{ action: 'x', args: 'rm -rf' }] }],
  ])('drops %s and keeps the rest', (_name, bad) => {
    const { config, dropped } = parseWorkbench(file([bad, button('b')]))
    expect(config.buttons.map((b) => b.id)).toEqual(['b'])
    expect(dropped).toBe(1)
  })

  it('drops a duplicate id and anything past the limit', () => {
    const many = Array.from({ length: MAX_WORKBENCH_BUTTONS + 2 }, (_, i) => button(`b${i}`))
    expect(parseWorkbench(file(many)).config.buttons).toHaveLength(MAX_WORKBENCH_BUTTONS)
    expect(parseWorkbench(file([button('a'), button('a')])).config.buttons).toHaveLength(1)
  })

  it('reads hidden only when it is true', () => {
    expect(parseWorkbench(file([], { hidden: true })).config.hidden).toBe(true)
    expect(parseWorkbench(file([], { hidden: 'yes' })).config.hidden).toBe(false)
  })
})
