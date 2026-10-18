import { describe, expect, it, vi } from 'vitest'
import { createUiZoomStore, initialUiScaleFrom } from './ui-zoom-store'
import { DEFAULT_UI_SCALE, MAX_UI_SCALE, MIN_UI_SCALE, UI_SCALE_SETTING_KEY } from '../shared/uiScale'

function contentsStub(overrides: Partial<{ destroyed: boolean; throws: boolean }> = {}) {
  return {
    setZoomFactor: vi.fn(() => {
      if (overrides.throws) throw new Error('Object has been destroyed')
    }),
    isDestroyed: vi.fn(() => overrides.destroyed ?? false),
    send: vi.fn()
  }
}

describe('createUiZoomStore', () => {
  it('starts at the persisted scale', () => {
    expect(createUiZoomStore(1.25).get()).toBe(1.25)
  })

  it('starts at 100% when nothing is stored', () => {
    expect(createUiZoomStore().get()).toBe(DEFAULT_UI_SCALE)
    expect(createUiZoomStore(null).get()).toBe(DEFAULT_UI_SCALE)
  })

  it('clamps an out-of-range stored value instead of handing it to setZoomFactor', () => {
    expect(createUiZoomStore(12).get()).toBe(MAX_UI_SCALE)
  })

  it('applies one scale change to every tracked window at once', () => {
    const store = createUiZoomStore(1)
    const main = contentsStub()
    const editor = contentsStub()
    const plugin = contentsStub()
    store.track(main)
    store.track(editor)
    store.track(plugin)

    store.set(1.25)

    expect(main.setZoomFactor).toHaveBeenCalledWith(1.25)
    expect(editor.setZoomFactor).toHaveBeenCalledWith(1.25)
    expect(plugin.setZoomFactor).toHaveBeenCalledWith(1.25)
  })

  it('returns the clamped value that was actually applied', () => {
    const store = createUiZoomStore(1)
    const contents = contentsStub()
    store.track(contents)

    expect(store.set(99)).toBe(MAX_UI_SCALE)
    expect(contents.setZoomFactor).toHaveBeenCalledWith(MAX_UI_SCALE)
  })

  it('does not call into a destroyed WebContents', () => {
    const store = createUiZoomStore(1)
    const dead = contentsStub({ destroyed: true })
    store.track(dead)

    store.set(1.1)

    expect(dead.setZoomFactor).not.toHaveBeenCalled()
    expect(store.size()).toBe(0)
  })

  it('keeps scaling the remaining windows when one throws mid-broadcast', () => {
    // A window can be torn down between the isDestroyed() check and the call;
    // an unguarded loop would leave every later window at the old scale.
    const store = createUiZoomStore(1)
    const broken = contentsStub({ throws: true })
    const healthy = contentsStub()
    store.track(broken)
    store.track(healthy)

    expect(() => store.set(1.5)).not.toThrow()
    expect(healthy.setZoomFactor).toHaveBeenCalledWith(1.5)
    expect(store.size()).toBe(1)
  })

  it('stops scaling an untracked window', () => {
    const store = createUiZoomStore(1)
    const contents = contentsStub()
    store.track(contents)
    store.untrack(contents)

    store.set(1.25)

    expect(contents.setZoomFactor).not.toHaveBeenCalled()
  })

  it('reports the current scale to a window created after the change', () => {
    // New windows read get() through lockPageZoom's factor provider, so a
    // window opened at 125% must not paint at 100% first.
    const store = createUiZoomStore(1)
    store.set(1.25)

    expect(store.get()).toBe(1.25)
  })

  it('tells each window the zoom changed so native views can re-place themselves', () => {
    // GitPluginHostSlot divides CSS-pixel bounds by the zoom factor before
    // handing them to main. Electron emits 'zoom-changed' only for user
    // gestures, so an app-driven change must be pushed or those WebContentsViews
    // stay at the old geometry.
    const store = createUiZoomStore(1)
    const contents = contentsStub()
    store.track(contents)

    store.set(1.25)

    expect(contents.send).toHaveBeenCalledWith('window:zoom-changed')
  })

  it('does not notify a destroyed window', () => {
    const store = createUiZoomStore(1)
    const dead = contentsStub({ destroyed: true })
    store.track(dead)

    store.set(1.25)

    expect(dead.send).not.toHaveBeenCalled()
  })

  it('tracks a WebContents only once', () => {
    const store = createUiZoomStore(1)
    const contents = contentsStub()
    store.track(contents)
    store.track(contents)

    store.set(1.1)

    expect(contents.setZoomFactor).toHaveBeenCalledTimes(1)
  })
})

describe('initialUiScaleFrom', () => {
  // The renderer stores the scale as a raw number (settingsSet), so ui_settings.json
  // holds `1.25`, not the JSON-encoded string other keys use.
  it('restores a scale stored as a number', () => {
    expect(initialUiScaleFrom({ [UI_SCALE_SETTING_KEY]: 1.25 })).toBe(1.25)
  })

  it('restores a scale stored as a numeric string', () => {
    expect(initialUiScaleFrom({ [UI_SCALE_SETTING_KEY]: '1.25' })).toBe(1.25)
  })

  it('falls back to 100% when the key is absent or malformed', () => {
    expect(initialUiScaleFrom({})).toBe(DEFAULT_UI_SCALE)
    expect(initialUiScaleFrom({ [UI_SCALE_SETTING_KEY]: 'big' })).toBe(DEFAULT_UI_SCALE)
    expect(initialUiScaleFrom({ [UI_SCALE_SETTING_KEY]: null })).toBe(DEFAULT_UI_SCALE)
  })

  it('clamps an out-of-range stored scale', () => {
    expect(initialUiScaleFrom({ [UI_SCALE_SETTING_KEY]: 12 })).toBe(MAX_UI_SCALE)
    expect(initialUiScaleFrom({ [UI_SCALE_SETTING_KEY]: 0.1 })).toBe(MIN_UI_SCALE)
  })
})
