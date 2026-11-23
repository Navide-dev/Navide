// @vitest-environment happy-dom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { shallowMount, type VueWrapper } from '@vue/test-utils'
import ControlPane from '../ControlPane.vue'
import { cliCommandKey, cliModelKey } from '@navide/plugin-shell'
import { seedSettings } from '@navide/plugin-ui/shared'

// The Manual spawn dialog's Model / Effort controls.
//
// The contract under test is "the spec decides, not a list kept in the
// component": which fields appear, which effort values are offered, and
// whether a pick is allowed to launch all come from the vendor spec passed in
// as a prop. So the specs here are FAKE on purpose — a test written against
// the real registry would silently change meaning the day a vendor gained or
// lost a flag, which is exactly the drift these controls must not have.

const specs = [
  {
    // claude's shape: a model flag and a separate effort flag.
    agentKey: 'modelcli',
    label: 'ModelCLI',
    modelArgs: (m: string) => `--model ${m}`,
    effortArgs: (e: string) => `--effort ${e}`,
    knownEfforts: ['low', 'high'],
  },
  {
    // codex's shape: a model flag, effort lives inside the model id.
    agentKey: 'modelonlycli',
    label: 'ModelOnlyCLI',
    modelArgs: (m: string) => `--model ${m}`,
  },
  {
    // claude's shape again, reserved for the stored-launch-command tests so
    // the command they seed (settings are a module cache) touches no other.
    agentKey: 'launchcli',
    label: 'LaunchCLI',
    modelArgs: (m: string) => `--model ${m}`,
    effortArgs: (e: string) => `--effort ${e}`,
    knownEfforts: ['low', 'high'],
  },
  {
    // droid / aider: neither flag. Offering a control here would be a promise
    // the spawn cannot keep — droid accepts an unknown --model and ignores it.
    agentKey: 'plaincli',
    label: 'PlainCLI',
  },
  { agentKey: 'terminal', label: 'Terminal' },
]

const localPanes = [
  {
    id: 'p1', agentLabel: 'ModelCLI', status: 'running', command: 'modelcli',
    origin: 'manual', isMinimized: false, isCommander: false,
  },
]

const workspaceRow = {
  path: '/Users/me/Desktop/Agent-Team',
  label: 'Agent-Team',
  displayPath: '~/Desktop/Agent-Team',
  isCurrent: true,
  collapsed: false,
  count: 1,
  paneIds: [],
  lineage: [],
  groups: [{ id: '', name: '', rows: [] }],
  remote: [],
}

function mountWith(extra: Record<string, unknown> = {}): VueWrapper {
  sessionStorage.setItem('agentTeam.sidebarTab', 'agents')
  return shallowMount(ControlPane as never, {
    attachTo: document.body,
    props: {
      backendStatus: 'connected',
      backendUrl: '',
      backend: { send: vi.fn().mockResolvedValue({ payload: { deps: [] } }) },
      agentSpecs: specs,
      roles: [{ key: 'reviewer', label: 'Reviewer' }],
      stages: [],
      panes: localPanes,
      pipeline: { state: 'idle' },
      yoloEnabled: false,
      analyzerModel: '',
      analyzerStatus: {
        available: false, version: '', defaultModel: '', models: [], benchmarkResults: [],
      },
      autoAnswerEnabled: false,
      workspace: '/Users/me/Desktop/Agent-Team',
      existingProject: null,
      workspaces: [workspaceRow],
      ...extra,
    } as never,
    global: { mocks: { $t: (key: string) => key } },
  })
}

/** Open the Manual spawn dialog through the ＋ menu, as a user reaches it. */
async function openDialog(wrapper: VueWrapper): Promise<void> {
  await wrapper.find('.ws-add').trigger('click')
  await wrapper.find('.ws-add-card').trigger('click')
}

/** Point the dialog at one of the fake vendors. */
async function pickAgent(wrapper: VueWrapper, agentKey: string): Promise<void> {
  await wrapper.findAll('.spawn-card--modal select')[0].setValue(agentKey)
}

const modelInput = (w: VueWrapper) => w.find('.spawn-card--modal .spawn-field input')
const effortSelect = (w: VueWrapper) => w.findAll('.spawn-card--modal .spawn-field select')

describe('ControlPane – the spawn dialog\'s model pick', () => {
  let wrapper: VueWrapper
  afterEach(() => {
    wrapper?.unmount()
    localStorage.clear()
    sessionStorage.clear()
  })

  it('shows both fields for a vendor that declares both flags', async () => {
    wrapper = mountWith()
    await openDialog(wrapper)
    await pickAgent(wrapper, 'modelcli')
    expect(modelInput(wrapper).exists()).toBe(true)
    expect(effortSelect(wrapper).length).toBe(1)
  })

  it('offers exactly the spec\'s knownEfforts, plus the vendor default', async () => {
    // Never a list kept in the component: the vocabulary is small and closed,
    // and the spec is where it is stated.
    wrapper = mountWith()
    await openDialog(wrapper)
    await pickAgent(wrapper, 'modelcli')
    const values = effortSelect(wrapper)[0].findAll('option').map((o) => o.attributes('value'))
    expect(values).toEqual(['', 'low', 'high'])
  })

  it('hides Effort for a vendor whose effort lives in the model id', async () => {
    wrapper = mountWith()
    await openDialog(wrapper)
    await pickAgent(wrapper, 'modelonlycli')
    expect(modelInput(wrapper).exists()).toBe(true)
    expect(effortSelect(wrapper).length).toBe(0)
  })

  it('hides BOTH for a vendor that declares neither', async () => {
    // droid and aider. The whole row disappears rather than rendering
    // disabled controls: a greyed-out Model box still says the app knows how
    // to set one here.
    wrapper = mountWith()
    await openDialog(wrapper)
    await pickAgent(wrapper, 'plaincli')
    expect(modelInput(wrapper).exists()).toBe(false)
    expect(effortSelect(wrapper).length).toBe(0)
  })

  it('carries the pick on the spawn payload', async () => {
    wrapper = mountWith()
    await openDialog(wrapper)
    await pickAgent(wrapper, 'modelcli')
    await modelInput(wrapper).setValue('opus-9')
    await effortSelect(wrapper)[0].setValue('high')
    await wrapper.find('.spawn-card--modal button.primary').trigger('click')
    expect(wrapper.emitted('spawn')?.[0]?.[0]).toMatchObject({
      agentKey: 'modelcli',
      model: 'opus-9',
      effort: 'high',
    })
  })

  it('leaves both off the payload when nothing is picked', async () => {
    // The byte-for-byte regression: a spawn with no model must look to every
    // downstream path exactly as it did before these fields existed.
    wrapper = mountWith()
    await openDialog(wrapper)
    await pickAgent(wrapper, 'modelcli')
    await wrapper.find('.spawn-card--modal button.primary').trigger('click')
    const payload = wrapper.emitted('spawn')?.[0]?.[0] as Record<string, unknown>
    expect(payload.model).toBeUndefined()
    expect(payload.effort).toBeUndefined()
  })

  it('warns, without blocking, when the id names a different level than the effort', async () => {
    // agy exits 1 on `--model gemini-4-neon-low --effort high`; the dialog
    // says so but launches the pick as chosen.
    wrapper = mountWith()
    await openDialog(wrapper)
    await pickAgent(wrapper, 'modelcli')
    await modelInput(wrapper).setValue('gemini-4-neon-low')
    await effortSelect(wrapper)[0].setValue('high')
    expect(wrapper.find('.spawn-card--modal .hint.warn').exists()).toBe(true)
    await wrapper.find('.spawn-card--modal button.primary').trigger('click')
    expect(wrapper.emitted('spawn')?.[0]?.[0]).toMatchObject({
      model: 'gemini-4-neon-low',
      effort: 'high',
    })
  })

  it('refuses a model id that would split into two arguments', async () => {
    // `--model "x --dangerously-skip-permissions"` is three argv entries, not
    // one. ARGUMENT_SAFE in cliModel.ts is the check; this proves the dialog
    // is behind it rather than beside it.
    wrapper = mountWith()
    await openDialog(wrapper)
    await pickAgent(wrapper, 'modelcli')
    await modelInput(wrapper).setValue('opus-9 --yolo')
    expect(wrapper.find('.spawn-card--modal .hint.warn').exists()).toBe(true)
    expect(
      wrapper.find('.spawn-card--modal button.primary').attributes('disabled'),
    ).toBeDefined()
  })

  it('seeds the fields from the vendor\'s stored default', async () => {
    seedSettings({ [cliModelKey('modelcli')]: { model: 'opus-5', effort: 'low' } })
    wrapper = mountWith()
    await openDialog(wrapper)
    await pickAgent(wrapper, 'modelcli')
    expect((modelInput(wrapper).element as HTMLInputElement).value).toBe('opus-5')
    expect((effortSelect(wrapper)[0].element as HTMLSelectElement).value).toBe('low')
  })

  it('re-seeds when the dialog is pointed at another vendor', async () => {
    // A model id belongs to one vendor's namespace. Carrying `opus-5` over to
    // the next CLI would spawn a refusal the user never typed.
    seedSettings({ [cliModelKey('modelcli')]: { model: 'opus-5', effort: '' } })
    wrapper = mountWith()
    await openDialog(wrapper)
    await pickAgent(wrapper, 'modelcli')
    expect((modelInput(wrapper).element as HTMLInputElement).value).toBe('opus-5')
    await pickAgent(wrapper, 'modelonlycli')
    expect((modelInput(wrapper).element as HTMLInputElement).value).toBe('')
  })

  it('spawns a ＋-menu pick on that vendor\'s stored default, not the dialog\'s', async () => {
    // The ＋ menu never renders the dialog, so reading its fields there would
    // launch whichever CLI's model happened to be left in them.
    seedSettings({ [cliModelKey('modelonlycli')]: { model: 'stored-9', effort: '' } })
    wrapper = mountWith()
    await openDialog(wrapper)
    await pickAgent(wrapper, 'modelcli')
    await modelInput(wrapper).setValue('typed-in-dialog')
    // Close the dialog and use the ＋ menu instead.
    await wrapper.find('.spawn-modal-backdrop').trigger('click')
    await wrapper.find('.ws-add').trigger('click')
    const option = wrapper
      .findAll('.ws-add-scroll .ws-add-opt')
      .find((o) => o.text().includes('ModelOnlyCLI'))
    await option?.trigger('click')
    expect(wrapper.emitted('spawn')?.[0]?.[0]).toMatchObject({
      agentKey: 'modelonlycli',
      model: 'stored-9',
    })
  })

  describe('when a stored launch command is set', () => {
    // The trap to avoid: the dialog seeds the stored model default, so
    // "override + model = refuse" would block EVERY dialog spawn for a user
    // who set both. The fields step aside instead, and the spawn carries no
    // pick the CLI could not receive.
    const seedBoth = () => seedSettings({
      [cliCommandKey('launchcli')]: 'ccr code',
      [cliModelKey('launchcli')]: { model: 'opus-5', effort: 'high' },
    })

    it('disables both fields, leaves them unseeded and says why', async () => {
      seedBoth()
      wrapper = mountWith()
      await openDialog(wrapper)
      await pickAgent(wrapper, 'launchcli')
      expect(modelInput(wrapper).attributes('disabled')).toBeDefined()
      expect(effortSelect(wrapper)[0].attributes('disabled')).toBeDefined()
      expect((modelInput(wrapper).element as HTMLInputElement).value).toBe('')
      expect(wrapper.find('.spawn-card--modal .model-shadowed').text())
        .toBe('spawn.model.shadowed-by-command')
    })

    it('still spawns — the stored model default does not turn into a refusal', async () => {
      seedBoth()
      wrapper = mountWith()
      await openDialog(wrapper)
      await pickAgent(wrapper, 'launchcli')
      const button = wrapper.find('.spawn-card--modal button.primary')
      expect(button.attributes('disabled')).toBeUndefined()
      await button.trigger('click')
      const payload = wrapper.emitted('spawn')?.[0]?.[0] as Record<string, unknown>
      expect(payload.agentKey).toBe('launchcli')
      expect(payload.model).toBeUndefined()
      expect(payload.effort).toBeUndefined()
    })

    it('sends no stored default from the ＋ menu either', async () => {
      seedBoth()
      wrapper = mountWith()
      await wrapper.find('.ws-add').trigger('click')
      const option = wrapper
        .findAll('.ws-add-scroll .ws-add-opt')
        .find((o) => o.text().includes('LaunchCLI'))
      await option?.trigger('click')
      const payload = wrapper.emitted('spawn')?.[0]?.[0] as Record<string, unknown>
      expect(payload.agentKey).toBe('launchcli')
      expect(payload.model).toBeUndefined()
    })
  })

  it('sends no model with a plain shell', async () => {
    // A shell has nothing to be told. Both entry points that spawn one bypass
    // emitSpawn, and must keep doing so.
    wrapper = mountWith()
    await wrapper.find('.ws-add').trigger('click')
    await wrapper.find('.ws-add-term').trigger('click')
    const payload = wrapper.emitted('spawn')?.[0]?.[0] as Record<string, unknown>
    expect(payload.agentKey).toBe('terminal')
    expect(payload.model).toBeUndefined()
  })
})
