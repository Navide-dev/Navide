import { describe, expect, it } from 'vitest'
import { dockSurfaceProvided } from './dockSurfaceProvider'

// A restored panel resumes only while a plugin still provides its surface:
// the installed package or the built-in fallback, which both register a
// descriptor. Only the three built-in panel surfaces map to a plugin.
describe('dockSurfaceProvided', () => {
  const present = (ids: string[]) => (id: string): boolean => ids.includes(id)

  it('maps each built-in panel surface to its plugin', () => {
    expect(dockSurfaceProvided('plans', present(['navide.plans']))).toBe(true)
    expect(dockSurfaceProvided('git', present(['navide.git']))).toBe(true)
    expect(dockSurfaceProvided('editor', present(['navide.mini-ide']))).toBe(true)
  })

  it('reports a surface whose plugin is gone', () => {
    expect(dockSurfaceProvided('plans', present([]))).toBe(false)
    expect(dockSurfaceProvided('git', present(['navide.plans']))).toBe(false)
    expect(dockSurfaceProvided('editor', present(['navide.git']))).toBe(false)
  })

  it('leaves every other surface alone (pm belongs to the main window)', () => {
    expect(dockSurfaceProvided('pm', present([]))).toBe(true)
    expect(dockSurfaceProvided('acme.panel', present([]))).toBe(true)
  })
})
