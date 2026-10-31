// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { i18n } from '@navide/plugin-ui/foundation'
import { registerCommand } from '@navide/plugin-ui/shared'
import { _resetRegistry } from '@navide/plugin-ui/shared/testing'
import ActionBar from '../../components/ActionBar.vue'
import ProjectWorkbenchSection from '../ProjectWorkbenchSection.vue'
import { workbench } from '../../lib/workbench'
import {
  folderName,
  projectName,
  projectWorkbench,
  projectWorkbenchNeedsReview,
  refreshProjectWorkbench,
  syncProjectWorkbench,
  visibleProjectButtons,
} from '../../lib/projectWorkbench'
import { EMPTY_WORKBENCH } from '../../../../shared/workbench'
import type { ProjectWorkbench, ProjectWorkbenchSnapshot } from '../../../../shared/projectWorkbench'

const confirm = vi.hoisted(() => vi.fn())
vi.mock('@navide/plugin-ui/foundation', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useNotify: () => ({ confirm, toast: vi.fn() }),
}))

const global = { plugins: [i18n] }
const NONE: ProjectWorkbenchSnapshot = {
  status: 'none', fingerprint: null, recommendation: null, active: null, shouldNotify: false,
}
const FILE: ProjectWorkbench = {
  schemaVersion: 1,
  layoutMode: 'spotlight',
  plugins: [{ id: 'acme.runner', version: '^1.0.0' }],
  buttons: [
    { id: 'open', label: 'Open', steps: [{ action: 'a.open' }] },
    { id: 'lie', label: 'Open Plans', steps: [{ action: 'workbench.action.closeActivePane' }] },
    { id: 'yolo', label: 'Harmless', steps: [{ action: 'ui.settings.yolo' }] },
  ],
}
const pending: ProjectWorkbenchSnapshot = {
  status: 'pending', fingerprint: 'f'.repeat(64), recommendation: FILE, active: null, shouldNotify: true,
}
const accepted: ProjectWorkbenchSnapshot = {
  status: 'accepted', fingerprint: 'f'.repeat(64), recommendation: FILE, active: FILE, shouldNotify: false,
}
const api = (over: Record<string, unknown> = {}) => {
  const value = {
    inspect: vi.fn().mockResolvedValue(NONE),
    accept: vi.fn().mockResolvedValue({ ok: true, snapshot: accepted }),
    revoke: vi.fn().mockResolvedValue({ ok: true, snapshot: pending }),
    markNotified: vi.fn().mockResolvedValue({ ok: true, snapshot: { ...pending, shouldNotify: false } }),
    ...over,
  }
  ;(window as unknown as { agentTeam: unknown }).agentTeam = { workbenchProject: value }
  return value
}
const section = () => mount(ProjectWorkbenchSection, { global })

beforeEach(() => {
  _resetRegistry()
  workbench.value = EMPTY_WORKBENCH
  projectWorkbench.value = NONE
  projectName.value = 'repo'
  confirm.mockReset()
})
afterEach(() => { delete (window as unknown as { agentTeam?: unknown }).agentTeam })

describe('a project with no file behaves as if this did not exist', () => {
  it('renders no section, no button and no marker', async () => {
    const remote = api()
    const remind = vi.fn()
    await syncProjectWorkbench('/work/repo', remind)
    expect(section().html()).toBe('<!--v-if-->')
    expect(mount(ActionBar, { global }).html()).toBe('<!--v-if-->')
    expect(projectWorkbenchNeedsReview.value).toBe(false)
    expect(remote.markNotified).not.toHaveBeenCalled()
    expect(remind).not.toHaveBeenCalled()
  })

  it('stays empty on a build without the bridge', async () => {
    await syncProjectWorkbench('/work/repo', vi.fn())
    expect(projectWorkbench.value).toEqual(NONE)
  })

  it('stays empty when the main process refuses the window', async () => {
    api({ inspect: vi.fn().mockRejectedValue(new Error('untrusted sender')) })
    await refreshProjectWorkbench()
    expect(projectWorkbench.value).toEqual(NONE)
  })
})

describe('the reminder', () => {
  it('goes up once and marks the fingerprint', async () => {
    const remote = api({ inspect: vi.fn().mockResolvedValue(pending) })
    const remind = vi.fn()
    await syncProjectWorkbench('/work/repo', remind)
    expect(remote.markNotified).toHaveBeenCalledWith(pending.fingerprint)
    expect(remind).toHaveBeenCalledOnce()
    expect(remind).toHaveBeenCalledWith('pending')
    expect(projectWorkbench.value.shouldNotify).toBe(false)
    expect(projectWorkbenchNeedsReview.value).toBe(true)
  })

  it('stays quiet once the fingerprint is marked', async () => {
    api({ inspect: vi.fn().mockResolvedValue({ ...pending, shouldNotify: false }) })
    const remind = vi.fn()
    await syncProjectWorkbench('/work/repo', remind)
    expect(remind).not.toHaveBeenCalled()
  })
})

describe('what reaches the bar', () => {
  it('holds nothing from a file that was not accepted', () => {
    projectWorkbench.value = pending
    expect(visibleProjectButtons.value).toEqual([])
  })

  it('holds nothing from a file that went stale', () => {
    projectWorkbench.value = { ...pending, status: 'stale' }
    expect(visibleProjectButtons.value).toEqual([])
  })

  it('holds the accepted buttons, and hiding the bar hides them', () => {
    projectWorkbench.value = accepted
    expect(visibleProjectButtons.value).toHaveLength(3)
    workbench.value = { ...EMPTY_WORKBENCH, hidden: true }
    expect(visibleProjectButtons.value).toEqual([])
  })

  it('drops a reply that lost the race to a newer read', async () => {
    let finishOld: (value: ProjectWorkbenchSnapshot) => void = () => {}
    api({
      inspect: vi.fn()
        .mockReturnValueOnce(new Promise((resolve) => { finishOld = resolve }))
        .mockResolvedValueOnce(NONE),
    })
    const old = refreshProjectWorkbench()
    await refreshProjectWorkbench()
    finishOld(accepted)
    await old
    expect(projectWorkbench.value).toEqual(NONE)
  })
})

describe('a project button in the bar', () => {
  const bar = () => {
    projectWorkbench.value = accepted
    return mount(ActionBar, { global })
  }
  const named = (wrapper: ReturnType<typeof bar>, label: string) =>
    wrapper.findAll('button').find((item) => item.text().includes(label))!

  beforeEach(() => {
    registerCommand('a.open', () => {})
    registerCommand('ui.settings.yolo', () => {})
  })

  it('says it came from the project', () => {
    expect(named(bar(), 'Open').attributes('title')).toContain('repo')
  })

  it('is disabled when a step is one no button may run, whatever the file says', async () => {
    const run = vi.fn()
    registerCommand('ui.settings.yolo', run)
    const item = named(bar(), 'Harmless')
    expect(item.attributes('disabled')).toBeDefined()
    await item.trigger('click')
    expect(run).not.toHaveBeenCalled()
  })

  it('warns with the real action, not the label', async () => {
    confirm.mockResolvedValue(false)
    const run = vi.fn()
    registerCommand('workbench.action.closeActivePane', run)
    await named(bar(), 'Open Plans').trigger('click')
    await vi.waitFor(() => expect(confirm).toHaveBeenCalled())
    expect(confirm.mock.calls[0][0]).not.toContain('Open Plans')
    expect(run).not.toHaveBeenCalled()
  })

  it('keeps a repository id from colliding with yours', () => {
    registerCommand('a.mine', () => {})
    workbench.value = {
      schemaVersion: 1, hidden: false, buttons: [{ id: 'open', label: 'Mine', steps: [{ action: 'a.mine' }] }],
    }
    expect(bar().findAll('button').map((item) => item.text())).toEqual(
      expect.arrayContaining([expect.stringContaining('Mine'), expect.stringContaining('Open')]),
    )
  })
})

describe('the review in Settings', () => {
  it('names what each button runs, beside the label', () => {
    projectWorkbench.value = pending
    const text = section().text()
    expect(text).toContain('Open Plans')
    expect(text).toContain('ui.settings.yolo')
    expect(text).toContain(i18n.global.t('actionBar.project-refused'))
    expect(text).toContain(i18n.global.t('actionBar.project-destructive'))
  })

  it('flags each button for what it really is', () => {
    registerCommand('workbench.action.closeActivePane', () => {})
    projectWorkbench.value = pending
    const rows = section().findAll('.pws-row').map((row) => row.text())
    const [, liar, forged] = rows
    expect(liar).toContain(i18n.global.t('actionBar.project-destructive'))
    expect(liar).not.toContain(i18n.global.t('actionBar.project-refused'))
    expect(forged).toContain('ui.settings.yolo')
    expect(forged).toContain(i18n.global.t('actionBar.project-refused'))
    expect(forged).not.toContain(i18n.global.t('actionBar.project-destructive'))
  })

  it('marks a step that exists nowhere, and shows its id instead of a made-up name', () => {
    projectWorkbench.value = pending
    const [unknown] = section().findAll('.pws-row').map((row) => row.text())
    expect(unknown).toContain('a.open')
    expect(unknown).toContain(i18n.global.t('actionBar.unavailable'))
    expect(unknown).not.toContain(i18n.global.t('actionBar.project-refused'))
  })

  it('leaves a step that exists unmarked, and names it', () => {
    registerCommand('a.open', () => {})
    projectWorkbench.value = pending
    const [known] = section().findAll('.pws-row').map((row) => row.text())
    expect(known).not.toContain(i18n.global.t('actionBar.unavailable'))
    expect(known).not.toContain('a.open')
  })

  it('accepts exactly the fingerprint it showed', async () => {
    const remote = api()
    projectWorkbench.value = pending
    const wrapper = section()
    await wrapper.findAll('button').find((item) => item.text() === i18n.global.t('actionBar.project-accept'))!.trigger('click')
    await flushPromises()
    expect(remote.accept).toHaveBeenCalledWith(pending.fingerprint)
    expect(projectWorkbench.value.status).toBe('accepted')
  })

  it('says so when a file changed under the review', async () => {
    api({ accept: vi.fn().mockResolvedValue({ ok: false, reason: 'stale', snapshot: { ...pending, fingerprint: 'e'.repeat(64) } }) })
    projectWorkbench.value = pending
    const wrapper = section()
    await wrapper.findAll('button').find((item) => item.text() === i18n.global.t('actionBar.project-accept'))!.trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('stale')
  })

  it('changes the layout only on Apply, and only once accepted', async () => {
    const setMode = vi.fn()
    registerCommand('ui.layout.setMode', setMode)
    const apply = i18n.global.t('actionBar.project-apply')

    projectWorkbench.value = pending
    expect(section().findAll('button').some((item) => item.text() === apply)).toBe(false)

    projectWorkbench.value = accepted
    const wrapper = section()
    expect(setMode).not.toHaveBeenCalled()
    await wrapper.findAll('button').find((item) => item.text() === apply)!.trigger('click')
    await flushPromises()
    expect(setMode.mock.calls[0][0]).toEqual({ mode: 'spotlight' })
  })

  it('opens a suggested plugin in the Marketplace and installs nothing', async () => {
    const open = vi.fn()
    registerCommand('ui.plugins.openMarketplace', open)
    projectWorkbench.value = pending
    const wrapper = section()
    await wrapper.findAll('button').find((item) => item.text() === i18n.global.t('actionBar.project-open-plugin'))!.trigger('click')
    await flushPromises()
    expect(open.mock.calls[0][0]).toEqual({ id: 'acme.runner' })
  })

  it('offers no decision on a file it cannot read', () => {
    projectWorkbench.value = { ...NONE, status: 'invalid' }
    const wrapper = section()
    expect(wrapper.findAll('button')).toHaveLength(0)
    expect(wrapper.text()).toContain(i18n.global.t('actionBar.project-status-invalid'))
  })
})

describe('folderName', () => {
  it.each([['/work/repo', 'repo'], ['C:\\work\\repo\\', 'repo'], ['', '']])('%s', (path, name) => {
    expect(folderName(path)).toBe(name)
  })
})
