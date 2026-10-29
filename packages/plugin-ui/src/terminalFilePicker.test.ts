// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTerminalFilePicker, type PickerItem } from './terminalFilePicker'

const items: PickerItem[] = [
  { abs: '/w/docs/a.md', name: 'a.md', dir: 'docs' },
  { abs: '/w/docs/b.md', name: 'b.md', dir: 'docs' },
  { abs: '/w/docs/c.md', name: 'c.md', dir: 'docs' },
]

async function openPicker() {
  const onPick = vi.fn()
  const picker = createTerminalFilePicker({ query: async () => items, onPick })
  picker.open({ initialQuery: 'md' })
  await vi.waitFor(() => expect(document.querySelectorAll('.term-file-picker-root input ~ div > div').length).toBe(3))
  const rows = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('.term-file-picker-root input ~ div > div')]
  return { picker, onPick, rows, input: document.querySelector('.term-file-picker-root input') as HTMLInputElement }
}

afterEach(() => { document.querySelector('.term-file-picker-root')?.remove() })

describe('terminal file picker', () => {
  it('picks the clicked row on mousedown', async () => {
    const { onPick, rows } = await openPicker()
    rows()[1]!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
    expect(onPick).toHaveBeenCalledOnce()
    expect(onPick.mock.calls[0]![0]).toEqual(items[1])
    expect(document.querySelector('.term-file-picker-root')).toBeNull()
  })

  it('hover moves the highlight without rebuilding the row elements', async () => {
    const { rows } = await openPicker()
    const before = rows()
    before[2]!.dispatchEvent(new MouseEvent('mouseenter'))
    const after = rows()
    after.forEach((row, i) => expect(row).toBe(before[i]))
    expect(after[2]!.style.background).not.toBe('')
    expect(after[0]!.style.background).toBe('')
  })

  it('keeps keyboard navigation working after hover', async () => {
    const { rows, input, onPick } = await openPicker()
    rows()[1]!.dispatchEvent(new MouseEvent('mouseenter'))
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
    expect(rows()[2]!.style.background).not.toBe('')
    expect(rows()[1]!.style.background).toBe('')
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    expect(onPick.mock.calls[0]![0]).toEqual(items[2])
  })
})

describe('terminal file picker location suffix', () => {
  it('searches without a typed :start-end suffix and picks with its start line', async () => {
    const query = vi.fn(async () => items)
    const onPick = vi.fn()
    const picker = createTerminalFilePicker({ query, onPick })
    picker.open({ initialQuery: 'md', lineNum: 3 })
    const input = document.querySelector('.term-file-picker-root input') as HTMLInputElement
    input.value = '  app/Services/OrderService.php:137-158 '
    input.dispatchEvent(new Event('input'))
    await vi.waitFor(() => expect(query).toHaveBeenLastCalledWith('app/Services/OrderService.php'))
    await vi.waitFor(() => expect(document.querySelectorAll('.term-file-picker-root input ~ div > div').length).toBe(3))
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    expect(onPick.mock.calls[0]![1]).toBe(137)
  })

  it('keeps the request line when the typed query has no suffix', async () => {
    const query = vi.fn(async () => items)
    const onPick = vi.fn()
    const picker = createTerminalFilePicker({ query, onPick })
    picker.open({ initialQuery: 'md', lineNum: 3 })
    const input = document.querySelector('.term-file-picker-root input') as HTMLInputElement
    input.value = 'docs/a.md'
    input.dispatchEvent(new Event('input'))
    await vi.waitFor(() => expect(query).toHaveBeenLastCalledWith('docs/a.md'))
    await vi.waitFor(() => expect(document.querySelectorAll('.term-file-picker-root input ~ div > div').length).toBe(3))
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    expect(onPick.mock.calls[0]![1]).toBe(3)
  })
})
