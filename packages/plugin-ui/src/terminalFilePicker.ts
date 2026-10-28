import { splitTerminalLinkSuffix } from './terminalLinkInteraction'

export interface PickerItem {
  abs: string
  name: string
  dir: string
}

export interface TerminalFilePickerOpenRequest {
  initialQuery: string
  lineNum?: number
  preferredAbsPath?: string
  displayText?: string
}

export interface TerminalFilePicker {
  open(request: TerminalFilePickerOpenRequest): void
  close(): void
  readonly active: boolean
}

export interface TerminalFilePickerOptions {
  /** Search is owned by the Host; returned paths are untrusted display data. */
  query(query: string): Promise<PickerItem[]>
  /** The Host owns opening the selected path and its line number. */
  onPick(item: PickerItem, lineNum: number | undefined, event: MouseEvent | KeyboardEvent): void
  onClose?(reason: 'cancel' | 'select'): void
  /** Optional display-only home collapsing, supplied by the Host. */
  collapsePath?(dir: string): string
}

export function mergePreferredPath(
  items: PickerItem[],
  preferredAbsPath: string | undefined,
  isInitialQuery: boolean
): PickerItem[] {
  if (!preferredAbsPath || !isInitialQuery) return items
  const idx = items.findIndex((item) => item.abs === preferredAbsPath)
  if (idx === 0) return items
  if (idx > 0) {
    const copy = items.slice()
    copy.unshift(copy.splice(idx, 1)[0])
    return copy
  }
  const parts = preferredAbsPath.split('/')
  const name = parts.pop() ?? preferredAbsPath
  return [{ abs: preferredAbsPath, name, dir: parts.join('/') }, ...items]
}

/** Mount the existing Cmd-click file picker overlay without owning filesystem
 *  or authority operations. The injected query and pick callbacks stay Host
 *  owned; this helper only renders and manages the picker interaction. */
export function createTerminalFilePicker(options: TerminalFilePickerOptions): TerminalFilePicker {
  let closeCurrent: ((reason?: 'cancel' | 'select') => void) | null = null

  function close(reason: 'cancel' | 'select' = 'cancel'): void {
    const current = closeCurrent
    closeCurrent = null
    current?.(reason)
  }

  function open(request: TerminalFilePickerOpenRequest): void {
    close()
    document.querySelector('.term-file-picker-root')?.remove()

    const root = document.createElement('div')
    root.className = 'term-file-picker-root'
    Object.assign(root.style, {
      position: 'fixed', inset: '0', zIndex: 'calc(var(--z-toast) + 200)',
      display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
      paddingTop: '80px', background: 'rgba(0,0,0,0.35)',
    })

    const card = document.createElement('div')
    Object.assign(card.style, {
      background: '#161b22', border: '1px solid #30363d', borderRadius: '8px',
      width: '560px', maxHeight: '420px', display: 'flex', flexDirection: 'column',
      boxShadow: '0 16px 48px rgba(0,0,0,0.8)', overflow: 'hidden',
    })

    const pickerInput = document.createElement('input')
    pickerInput.value = request.displayText ?? request.initialQuery
    pickerInput.placeholder = 'Search files...'
    Object.assign(pickerInput.style, {
      background: 'transparent', border: 'none', borderBottom: '1px solid #21262d',
      color: '#e6edf3', fontSize: '14px', padding: '12px 16px', outline: 'none',
      fontFamily: 'inherit', width: '100%', boxSizing: 'border-box',
    })

    const itemList = document.createElement('div')
    Object.assign(itemList.style, { overflowY: 'auto', flex: '1' })

    card.appendChild(pickerInput)
    card.appendChild(itemList)
    root.appendChild(card)
    document.body.appendChild(root)

    let currentItems: PickerItem[] = []
    let selectedIdx = 0
    let debounceTimer: ReturnType<typeof setTimeout>
    let searchPending = true
    // A line suffix typed or pasted into the box (`path:12`, `path:12-30`)
    // overrides the request's line; it is never part of the search query.
    let typedLine: number | undefined
    const pickLine = (): number | undefined => typedLine ?? request.lineNum

    let rowEls: HTMLElement[] = []
    const SELECTED_BG = 'rgba(56,139,253,0.2)'
    // Move the highlight in place: hover and arrow keys must not rebuild the
    // rows, or the element under the pointer is replaced mid-interaction.
    function updateSelection(): void {
      rowEls.forEach((el, i) => { el.style.background = i === selectedIdx ? SELECTED_BG : '' })
    }

    function renderList(): void {
      itemList.innerHTML = ''
      rowEls = []
      if (!currentItems.length) {
        const msg = document.createElement('div')
        msg.textContent = searchPending ? 'Searching…' : 'No files found'
        Object.assign(msg.style, { padding: '10px 16px', color: '#6e7681', fontSize: '12px' })
        itemList.appendChild(msg)
        return
      }
      currentItems.forEach((item, i) => {
        const row = document.createElement('div')
        Object.assign(row.style, {
          padding: '7px 16px', cursor: 'pointer',
          display: 'flex', gap: '10px', alignItems: 'baseline',
          background: i === selectedIdx ? SELECTED_BG : '',
        })
        const nameSpan = document.createElement('span')
        nameSpan.textContent = item.name
        Object.assign(nameSpan.style, { color: '#e6edf3', fontSize: '13px' })
        const dirSpan = document.createElement('span')
        dirSpan.textContent = options.collapsePath?.(item.dir) ?? item.dir
        Object.assign(dirSpan.style, { color: '#8b949e', fontSize: '11px' })
        row.appendChild(nameSpan)
        row.appendChild(dirSpan)
        row.addEventListener('mouseenter', () => { selectedIdx = i; updateSelection() })
        row.addEventListener('mousedown', (e) => {
          e.preventDefault()
          close('select')
          options.onPick(item, pickLine(), e)
        })
        rowEls.push(row)
        itemList.appendChild(row)
      })
    }

    const onDocKeydown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); close() }
    }
    const localClose = (reason: 'cancel' | 'select' = 'cancel'): void => {
      clearTimeout(debounceTimer)
      document.removeEventListener('keydown', onDocKeydown, true)
      root.remove()
      options.onClose?.(reason)
    }
    closeCurrent = localClose

    async function doSearch(q: string): Promise<void> {
      searchPending = true
      const { filepath, line } = splitTerminalLinkSuffix(q.trim())
      typedLine = line
      let items: PickerItem[] = []
      try { items = await options.query(filepath) } catch { items = [] }
      currentItems = mergePreferredPath(items, request.preferredAbsPath, q === request.initialQuery)
      searchPending = false
      selectedIdx = 0
      renderList()
    }

    pickerInput.addEventListener('input', () => {
      clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => void doSearch(pickerInput.value), 150)
    })

    pickerInput.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        if (selectedIdx < currentItems.length - 1) { selectedIdx++; updateSelection() }
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        if (selectedIdx > 0) { selectedIdx--; updateSelection() }
      } else if (e.key === 'Enter') {
        e.preventDefault()
        const item = currentItems[selectedIdx]
        if (item) { close('select'); options.onPick(item, pickLine(), e) }
      }
    })

    root.addEventListener('mousedown', (e) => { if (e.target === root) close() })
    document.addEventListener('keydown', onDocKeydown, true)
    pickerInput.focus()
    pickerInput.select()
    renderList()
    void doSearch(request.initialQuery)
  }

  return {
    open,
    close,
    get active() { return closeCurrent !== null },
  }
}
