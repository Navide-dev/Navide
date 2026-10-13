// @vitest-environment happy-dom
// The Roles tab's field editor: what a role declares here becomes the form a
// pipeline step using it shows in the node inspector.
import { describe, expect, it } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { i18n } from '@navide/plugin-ui/foundation'
import type { RoleProperty } from '../../../lib/pipelineGraph'
import RolePropertiesEditor, { rolePropertyProblems } from '../RolePropertiesEditor.vue'

i18n.global.locale.value = 'en-US'

function mountEditor(modelValue: RoleProperty[]): VueWrapper {
  const w = mount(RolePropertiesEditor, {
    props: { modelValue, 'onUpdate:modelValue': (v: RoleProperty[]) => w.setProps({ modelValue: v }) },
    global: { plugins: [i18n] },
  })
  return w
}
const value = (w: VueWrapper) => (w.props() as { modelValue: RoleProperty[] }).modelValue

describe('RolePropertiesEditor', () => {
  it('invites adding a first field when the role declares none', async () => {
    const w = mountEditor([])
    expect(w.find('.rpe-empty').exists()).toBe(true)
    await w.find('.rpe-add').trigger('click')
    expect(value(w)).toEqual([{ name: 'field1', type: 'string' }])
  })

  it('edits name, label, type and required', async () => {
    const w = mountEditor([{ name: 'effort', type: 'string' }])
    await w.find('.rpe-name').setValue('effortLevel')
    await w.find('.rpe-label').setValue('Effort')
    await w.find('.rpe-type').setValue('number')
    await w.find('.rpe-required input').setValue(true)
    expect(value(w)).toEqual([{ name: 'effortLevel', label: 'Effort', type: 'number', required: true }])
  })

  it('gives an options field its option list and a default picked from it', async () => {
    const w = mountEditor([{ name: 'mode', type: 'string' }])
    await w.find('.rpe-type').setValue('options')
    expect(value(w)[0].options).toEqual([{ value: 'option1', label: 'option1' }])
    await w.find('.rpe-opt-add').trigger('click')
    await w.findAll('.rpe-opt-value')[1].setValue('fast')
    await w.find('.rpe-default').setValue('fast')
    expect(value(w)[0]).toMatchObject({ type: 'options', default: 'fast', options: [{ value: 'option1' }, { value: 'fast' }] })
  })

  it('drops the options list and a mistyped default when the type changes away', async () => {
    const w = mountEditor([{ name: 'mode', type: 'options', default: 'a', options: [{ value: 'a' }] }])
    await w.find('.rpe-type').setValue('boolean')
    expect(value(w)).toEqual([{ name: 'mode', type: 'boolean' }])
  })

  it('reorders and removes fields', async () => {
    const w = mountEditor([{ name: 'a', type: 'string' }, { name: 'b', type: 'string' }, { name: 'c', type: 'string' }])
    await w.findAll('.rpe-field')[2].find('.rpe-up').trigger('click')
    expect(value(w).map((p) => p.name)).toEqual(['a', 'c', 'b'])
    await w.findAll('.rpe-field')[0].find('.rpe-remove').trigger('click')
    expect(value(w).map((p) => p.name)).toEqual(['c', 'b'])
  })

  it('writes a show condition that names another field and its values', async () => {
    const w = mountEditor([
      { name: 'doneWhen', type: 'options', options: [{ value: 'turnEnd' }, { value: 'message' }] },
      { name: 'reportKey', type: 'string' },
    ])
    const report = w.findAll('.rpe-field')[1]
    await report.find('.rpe-cond-add').trigger('click')
    // A new condition picks the first other field and offers its options.
    await report.findAll('.rpe-cond-chip')[1].trigger('click') // "message"
    expect(value(w)[1].displayOptions).toEqual({ show: { doneWhen: ['message'] } })
    // Switching the rule to hide moves the condition across.
    await report.find('.rpe-cond-mode').setValue('hide')
    expect(value(w)[1].displayOptions).toEqual({ hide: { doneWhen: ['message'] } })
  })

  it('parses free-text condition values by the referenced field type', async () => {
    const w = mountEditor([{ name: 'retries', type: 'number' }, { name: 'note', type: 'string' }])
    const note = w.findAll('.rpe-field')[1]
    await note.find('.rpe-cond-add').trigger('click')
    await note.find('.rpe-cond-values').setValue('1, 3')
    expect(value(w)[1].displayOptions).toEqual({ show: { retries: [1, 3] } })
  })

  it('names the problems that would make the backend refuse the role', () => {
    expect(rolePropertyProblems([
      { name: '', type: 'string' },
      { name: 'a', type: 'string' },
      { name: 'a', type: 'string' },
      { name: '1bad', type: 'string' },
      { name: 'o', type: 'options', options: [] },
      { name: 'c', type: 'string', displayOptions: { show: { ghost: ['x'] } } },
    ])).toEqual([
      [{ kind: 'name-required' }],
      [],
      [{ kind: 'name-duplicate' }],
      [{ kind: 'name-invalid' }],
      [{ kind: 'options-empty' }],
      [{ kind: 'condition-unknown', field: 'ghost' }],
    ])
  })

  it('shows a field\'s problem beside it', () => {
    const w = mountEditor([{ name: 'a', type: 'string' }, { name: 'a', type: 'string' }])
    expect(w.findAll('.rpe-field')[1].find('.rpe-problem').text()).toContain('Another field already uses this name')
  })
})
