// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { chooseSubmenuPlacement, placeSubmenu } from '../submenuPlacement'

describe('hover submenu placement', () => {
  afterEach(() => document.body.replaceChildren())

  it('opens to the right when the flyout fits there', () => {
    expect(chooseSubmenuPlacement({ left: 10, right: 230 }, 220, 600)).toBe('right')
  })

  it('opens to the left when only the left side has room', () => {
    expect(chooseSubmenuPlacement({ left: 300, right: 520 }, 220, 600)).toBe('left')
  })

  it('drops below the row when neither side has room', () => {
    expect(chooseSubmenuPlacement({ left: 40, right: 260 }, 220, 300)).toBe('below')
  })

  it('measures the hidden flyout and records the placement on the row', () => {
    const row = document.createElement('div')
    const submenu = document.createElement('div')
    submenu.className = 'sub'
    submenu.style.display = 'none'
    row.appendChild(submenu)
    document.body.appendChild(row)
    row.getBoundingClientRect = () => ({ left: 300, right: 520 }) as DOMRect
    Object.defineProperty(submenu, 'offsetWidth', {
      get: () => (submenu.style.display === 'block' ? 220 : 0),
    })
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 600 })

    row.addEventListener('mouseenter', (event) => placeSubmenu(event, '.sub'))
    row.dispatchEvent(new MouseEvent('mouseenter'))

    expect(row.dataset.subPlace).toBe('left')
    expect(submenu.style.display).toBe('none')
  })
})
