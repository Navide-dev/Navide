<script lang="ts">
import type { RoleProperty } from '../../lib/pipelineGraph'

export type PropertyProblem =
  | { kind: 'name-required' }
  | { kind: 'name-duplicate' }
  | { kind: 'name-invalid' }
  | { kind: 'options-empty' }
  | { kind: 'condition-unknown'; field: string }

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/

/** Per field, what would make the backend refuse the role (or make a show/
 *  hide rule point at nothing). Index-aligned with `props`. */
export function rolePropertyProblems(props: readonly RoleProperty[]): PropertyProblem[][] {
  const names = props.map((p) => p.name.trim())
  return props.map((p, i) => {
    const out: PropertyProblem[] = []
    const name = names[i]
    if (!name) out.push({ kind: 'name-required' })
    else if (names.indexOf(name) !== i) out.push({ kind: 'name-duplicate' })
    else if (!NAME_RE.test(name)) out.push({ kind: 'name-invalid' })
    if (p.type === 'options' && !(p.options?.length)) out.push({ kind: 'options-empty' })
    for (const cond of [p.displayOptions?.show, p.displayOptions?.hide]) {
      for (const field of Object.keys(cond ?? {})) {
        if (!names.includes(field) || field === name) out.push({ kind: 'condition-unknown', field })
      }
    }
    return out
  })
}
</script>

<script setup lang="ts">
// Field editor for a Role's declarative `properties`: what is declared here is
// the form a pipeline step using this role shows in its settings panel, with
// show/hide rules (displayOptions) that react to the other fields' values.
// Controlled: every change emits a whole new array.
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { RolePropertyType } from '../../lib/pipelineGraph'

type Value = string | number | boolean
type Mode = 'show' | 'hide'

const props = defineProps<{ modelValue: RoleProperty[]; disabled?: boolean }>()
const emit = defineEmits<{ (e: 'update:modelValue', v: RoleProperty[]): void }>()
const { t } = useI18n()

const TYPES: RolePropertyType[] = ['string', 'text', 'template', 'number', 'boolean', 'options']
const problems = computed(() => rolePropertyProblems(props.modelValue))

function commit(next: RoleProperty[]): void { emit('update:modelValue', next) }
function patch(i: number, change: (p: RoleProperty) => RoleProperty): void {
  commit(props.modelValue.map((p, j) => (j === i ? change(JSON.parse(JSON.stringify(p)) as RoleProperty) : p)))
}
/** Drop keys that are empty so the stored role stays minimal. */
function tidy(p: RoleProperty): RoleProperty {
  const out = { ...p }
  if (!out.label) delete out.label
  if (!out.description) delete out.description
  if (!out.required) delete out.required
  if (out.default === undefined || out.default === '') delete out.default
  if (out.type !== 'options') delete out.options
  if (out.displayOptions) {
    const d = { ...out.displayOptions }
    if (d.show && !Object.keys(d.show).length) delete d.show
    if (d.hide && !Object.keys(d.hide).length) delete d.hide
    if (!d.show && !d.hide) delete out.displayOptions
    else out.displayOptions = d
  }
  return out
}

function add(): void {
  const taken = new Set(props.modelValue.map((p) => p.name))
  let n = props.modelValue.length + 1
  while (taken.has(`field${n}`)) n++
  commit([...props.modelValue, { name: `field${n}`, type: 'string' }])
}
function remove(i: number): void { commit(props.modelValue.filter((_, j) => j !== i)) }
function move(i: number, d: -1 | 1): void {
  const j = i + d
  if (j < 0 || j >= props.modelValue.length) return
  const next = props.modelValue.slice()
  ;[next[i], next[j]] = [next[j], next[i]]
  commit(next)
}

function setText(i: number, key: 'name' | 'label' | 'description', v: string): void {
  patch(i, (p) => tidy({ ...p, [key]: key === 'name' ? v.trim() : v }))
}
function setRequired(i: number, v: boolean): void { patch(i, (p) => tidy({ ...p, required: v })) }
function setType(i: number, type: RolePropertyType): void {
  patch(i, (p) => {
    const next: RoleProperty = { ...p, type }
    // A default of the old type would be meaningless now.
    if (p.type !== type) delete next.default
    if (type === 'options' && !next.options?.length) next.options = [{ value: 'option1', label: 'option1' }]
    return tidy(next)
  })
}
function setDefault(i: number, raw: string | boolean): void {
  patch(i, (p) => {
    let v: Value | undefined = raw
    if (p.type === 'number') v = raw === '' ? undefined : Number(raw)
    if (p.type === 'options') v = raw === '' ? undefined : (p.options?.find((o) => String(o.value) === raw)?.value ?? raw)
    return tidy({ ...p, default: v })
  })
}

// ── Options ──────────────────────────────────────────────────────────────────
function addOption(i: number): void {
  patch(i, (p) => {
    const opts = p.options ?? []
    let n = opts.length + 1
    while (opts.some((o) => String(o.value) === `option${n}`)) n++
    return { ...p, options: [...opts, { value: `option${n}`, label: `option${n}` }] }
  })
}
function setOption(i: number, k: number, key: 'value' | 'label', v: string): void {
  patch(i, (p) => {
    const opts = (p.options ?? []).map((o, m) => (m === k ? { ...o, [key]: v } : o))
    const next = { ...p, options: opts }
    // Renaming the default's value carries the default along.
    if (key === 'value' && p.default === p.options?.[k]?.value) next.default = v
    return tidy(next)
  })
}
function removeOption(i: number, k: number): void {
  patch(i, (p) => {
    const gone = p.options?.[k]?.value
    const next = { ...p, options: (p.options ?? []).filter((_, m) => m !== k) }
    if (next.default === gone) delete next.default
    return tidy(next)
  })
}

// ── Show / hide conditions ───────────────────────────────────────────────────
interface Condition { mode: Mode; field: string; values: Value[] }

function conditionsOf(p: RoleProperty): Condition[] {
  const out: Condition[] = []
  for (const mode of ['show', 'hide'] as const) {
    for (const [field, values] of Object.entries(p.displayOptions?.[mode] ?? {})) out.push({ mode, field, values })
  }
  return out
}
function writeConditions(i: number, conds: Condition[]): void {
  patch(i, (p) => {
    const show: Record<string, Value[]> = {}
    const hide: Record<string, Value[]> = {}
    for (const c of conds) (c.mode === 'show' ? show : hide)[c.field] = c.values
    return tidy({ ...p, displayOptions: { show, hide } })
  })
}
function otherFields(i: number): RoleProperty[] {
  return props.modelValue.filter((_, j) => j !== i)
}
function addCondition(i: number): void {
  const used = new Set(conditionsOf(props.modelValue[i]).map((c) => c.field))
  const target = otherFields(i).find((p) => !used.has(p.name))
  if (!target) return
  writeConditions(i, [...conditionsOf(props.modelValue[i]), { mode: 'show', field: target.name, values: [] }])
}
function updateCondition(i: number, k: number, change: Partial<Condition>): void {
  const conds = conditionsOf(props.modelValue[i]).map((c, m) => (m === k ? { ...c, ...change } : c))
  writeConditions(i, conds)
}
function removeCondition(i: number, k: number): void {
  writeConditions(i, conditionsOf(props.modelValue[i]).filter((_, m) => m !== k))
}
function fieldNamed(name: string): RoleProperty | undefined {
  return props.modelValue.find((p) => p.name === name)
}
/** The values a condition can pick from, when the referenced field has a
 *  closed set (options, boolean); undefined = free text. */
function choicesFor(name: string): Value[] | undefined {
  const f = fieldNamed(name)
  if (f?.type === 'options') return (f.options ?? []).map((o) => o.value)
  if (f?.type === 'boolean') return [true, false]
  return undefined
}
function toggleChoice(i: number, k: number, v: Value): void {
  const c = conditionsOf(props.modelValue[i])[k]
  const has = c.values.includes(v)
  updateCondition(i, k, { values: has ? c.values.filter((x) => x !== v) : [...c.values, v] })
}
function parseValues(name: string, raw: string): Value[] {
  const isNumber = fieldNamed(name)?.type === 'number'
  return raw.split(',').map((s) => s.trim()).filter(Boolean)
    .map((s) => (isNumber && Number.isFinite(Number(s)) ? Number(s) : s))
}

function problemText(p: PropertyProblem): string {
  if (p.kind === 'condition-unknown') return t('pipelineEditor.roleFields.problem-condition', { field: p.field })
  return t(`pipelineEditor.roleFields.problem-${p.kind}`)
}
const valueOf = (e: Event): string => (e.target as HTMLInputElement).value
</script>

<template>
  <section class="rpe" :class="{ 'is-disabled': disabled }">
    <header class="rpe-head">
      <div class="rpe-head-text">
        <h4 class="rpe-title">{{ t('pipelineEditor.roleFields.title') }}</h4>
        <p class="rpe-desc">{{ t('pipelineEditor.roleFields.desc') }}</p>
      </div>
      <button type="button" class="rpe-add" :disabled="disabled" @click="add">{{ t('pipelineEditor.roleFields.add') }}</button>
    </header>

    <p v-if="!modelValue.length" class="rpe-empty">{{ t('pipelineEditor.roleFields.empty') }}</p>

    <ol v-else class="rpe-list">
      <li v-for="(p, i) in modelValue" :key="i" class="rpe-field" :class="{ 'has-problem': problems[i].length }">
        <div class="rpe-row">
          <span class="rpe-order">
            <button type="button" class="rpe-icon rpe-up" :disabled="disabled || i === 0" :aria-label="t('pipelineEditor.roleFields.move-up')" :title="t('pipelineEditor.roleFields.move-up')" @click="move(i, -1)">
              <svg viewBox="0 0 16 16"><path d="M4 10l4-4 4 4" /></svg>
            </button>
            <button type="button" class="rpe-icon rpe-down" :disabled="disabled || i === modelValue.length - 1" :aria-label="t('pipelineEditor.roleFields.move-down')" :title="t('pipelineEditor.roleFields.move-down')" @click="move(i, 1)">
              <svg viewBox="0 0 16 16"><path d="M4 6l4 4 4-4" /></svg>
            </button>
          </span>
          <label class="rpe-cell rpe-cell--name">
            <span class="rpe-cap">{{ t('pipelineEditor.roleFields.name') }}</span>
            <input class="rpe-name" :value="p.name" spellcheck="false" :disabled="disabled" @change="setText(i, 'name', valueOf($event))" />
          </label>
          <label class="rpe-cell">
            <span class="rpe-cap">{{ t('pipelineEditor.roleFields.label') }}</span>
            <input class="rpe-label" :value="p.label ?? ''" spellcheck="false" :placeholder="p.name" :disabled="disabled" @change="setText(i, 'label', valueOf($event))" />
          </label>
          <label class="rpe-cell rpe-cell--type">
            <span class="rpe-cap">{{ t('pipelineEditor.roleFields.type') }}</span>
            <select class="rpe-type" :value="p.type" :disabled="disabled" @change="setType(i, valueOf($event) as RolePropertyType)">
              <option v-for="ty in TYPES" :key="ty" :value="ty">{{ t(`pipelineEditor.roleFields.type-${ty}`) }}</option>
            </select>
          </label>
          <label class="rpe-cell rpe-cell--default">
            <span class="rpe-cap">{{ t('pipelineEditor.roleFields.default') }}</span>
            <select v-if="p.type === 'options'" class="rpe-default" :value="p.default === undefined ? '' : String(p.default)" :disabled="disabled" @change="setDefault(i, valueOf($event))">
              <option value="">{{ t('pipelineEditor.roleFields.no-default') }}</option>
              <option v-for="o in p.options" :key="String(o.value)" :value="String(o.value)">{{ o.label || o.value }}</option>
            </select>
            <span v-else-if="p.type === 'boolean'" class="rpe-check">
              <input class="rpe-default" type="checkbox" :checked="p.default === true" :disabled="disabled" @change="setDefault(i, ($event.target as HTMLInputElement).checked)" />
            </span>
            <input v-else class="rpe-default" :type="p.type === 'number' ? 'number' : 'text'" :value="p.default ?? ''" spellcheck="false" :disabled="disabled" @change="setDefault(i, valueOf($event))" />
          </label>
          <label class="rpe-cell rpe-required">
            <span class="rpe-cap">{{ t('pipelineEditor.roleFields.required') }}</span>
            <span class="rpe-check"><input type="checkbox" :checked="!!p.required" :disabled="disabled" @change="setRequired(i, ($event.target as HTMLInputElement).checked)" /></span>
          </label>
          <button type="button" class="rpe-icon rpe-remove" :disabled="disabled" :aria-label="t('pipelineEditor.roleFields.remove', { name: p.name })" :title="t('pipelineEditor.roleFields.remove', { name: p.name })" @click="remove(i)">
            <svg viewBox="0 0 16 16"><path d="m4.5 4.5 7 7m0-7-7 7" /></svg>
          </button>
        </div>

        <!-- Options of an options field. -->
        <div v-if="p.type === 'options'" class="rpe-sub">
          <span class="rpe-sub-cap">{{ t('pipelineEditor.roleFields.options') }}</span>
          <div class="rpe-opts">
            <span v-for="(o, k) in p.options" :key="k" class="rpe-opt">
              <input class="rpe-opt-value" :value="String(o.value)" spellcheck="false" :aria-label="t('pipelineEditor.roleFields.option-value')" :disabled="disabled" @change="setOption(i, k, 'value', valueOf($event))" />
              <input class="rpe-opt-label" :value="o.label ?? ''" spellcheck="false" :placeholder="t('pipelineEditor.roleFields.option-label')" :aria-label="t('pipelineEditor.roleFields.option-label')" :disabled="disabled" @change="setOption(i, k, 'label', valueOf($event))" />
              <button type="button" class="rpe-icon" :disabled="disabled" :aria-label="t('pipelineEditor.roleFields.option-remove')" @click="removeOption(i, k)">
                <svg viewBox="0 0 16 16"><path d="m4.5 4.5 7 7m0-7-7 7" /></svg>
              </button>
            </span>
            <button type="button" class="rpe-link rpe-opt-add" :disabled="disabled" @click="addOption(i)">{{ t('pipelineEditor.roleFields.option-add') }}</button>
          </div>
        </div>

        <!-- Show / hide rules. -->
        <div class="rpe-sub">
          <span class="rpe-sub-cap">{{ t('pipelineEditor.roleFields.conditions') }}</span>
          <div class="rpe-conds">
            <span v-for="(c, k) in conditionsOf(p)" :key="c.mode + c.field" class="rpe-cond">
              <select class="rpe-cond-mode" :value="c.mode" :disabled="disabled" :aria-label="t('pipelineEditor.roleFields.condition-mode')" @change="updateCondition(i, k, { mode: valueOf($event) as Mode })">
                <option value="show">{{ t('pipelineEditor.roleFields.show-when') }}</option>
                <option value="hide">{{ t('pipelineEditor.roleFields.hide-when') }}</option>
              </select>
              <select class="rpe-cond-field" :value="c.field" :disabled="disabled" :aria-label="t('pipelineEditor.roleFields.condition-field')" @change="updateCondition(i, k, { field: valueOf($event), values: [] })">
                <option v-for="o in otherFields(i)" :key="o.name" :value="o.name">{{ o.label || o.name }}</option>
                <option v-if="!fieldNamed(c.field)" :value="c.field">{{ c.field }}</option>
              </select>
              <span class="rpe-cond-is">{{ t('pipelineEditor.roleFields.is-one-of') }}</span>
              <span v-if="choicesFor(c.field)" class="rpe-chips">
                <button
                  v-for="v in choicesFor(c.field)" :key="String(v)" type="button" class="rpe-cond-chip"
                  :class="{ 'is-on': c.values.includes(v) }" :aria-pressed="c.values.includes(v)" :disabled="disabled"
                  @click="toggleChoice(i, k, v)"
                >{{ String(v) }}</button>
              </span>
              <input
                v-else class="rpe-cond-values" :value="c.values.join(', ')" spellcheck="false" :disabled="disabled"
                :placeholder="t('pipelineEditor.roleFields.values-placeholder')"
                @change="updateCondition(i, k, { values: parseValues(c.field, valueOf($event)) })"
              />
              <button type="button" class="rpe-icon" :disabled="disabled" :aria-label="t('pipelineEditor.roleFields.condition-remove')" @click="removeCondition(i, k)">
                <svg viewBox="0 0 16 16"><path d="m4.5 4.5 7 7m0-7-7 7" /></svg>
              </button>
            </span>
            <button
              v-if="otherFields(i).length > conditionsOf(p).length" type="button" class="rpe-link rpe-cond-add" :disabled="disabled"
              @click="addCondition(i)"
            >{{ conditionsOf(p).length ? t('pipelineEditor.roleFields.condition-add-more') : t('pipelineEditor.roleFields.condition-add') }}</button>
            <span v-else-if="!conditionsOf(p).length" class="rpe-always">{{ t('pipelineEditor.roleFields.always') }}</span>
          </div>
        </div>

        <p v-for="(pr, k) in problems[i]" :key="k" class="rpe-problem">{{ problemText(pr) }}</p>
      </li>
    </ol>
  </section>
</template>

<style scoped>
.rpe { display: flex; flex-direction: column; gap: var(--space-3); }
.rpe-head { display: flex; align-items: flex-start; gap: var(--space-3); }
.rpe-head-text { flex: 1; min-width: 0; display: grid; gap: 2px; }
.rpe-title { margin: 0; font-size: var(--font-sm); font-weight: 600; color: var(--text-primary); }
.rpe-desc { margin: 0; font-size: var(--font-xs); line-height: var(--lh-base); color: var(--text-muted); }
.rpe-add, .rpe-link {
  flex: none;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-control);
  background: var(--bg-elevated);
  color: var(--text-primary);
  font: inherit;
  font-size: var(--font-xs);
  height: var(--control-h-sm);
  padding: 0 var(--space-3);
  cursor: pointer;
}
.rpe-link { border-style: dashed; color: var(--text-secondary); background: transparent; }
.rpe-add:hover:not(:disabled), .rpe-link:hover:not(:disabled) { border-color: var(--accent-emphasis); color: var(--accent-fg); }
.rpe-add:disabled, .rpe-link:disabled { opacity: 0.5; cursor: not-allowed; }
.rpe-add:focus-visible, .rpe-link:focus-visible { outline: 2px solid var(--accent-focus); outline-offset: 1px; }
.rpe-empty {
  margin: 0;
  padding: var(--space-4);
  border: 1px dashed var(--border-default);
  border-radius: var(--radius-card);
  font-size: var(--font-xs);
  line-height: var(--lh-base);
  color: var(--text-muted);
  text-align: center;
}
.rpe-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--space-2); }
.rpe-field {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3);
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-card);
  background: var(--bg-subtle);
}
.rpe-field.has-problem { border-color: color-mix(in srgb, var(--danger-emphasis) 55%, var(--border-muted)); }
.rpe-row { display: flex; align-items: flex-end; gap: var(--space-2); }
.rpe-order { display: flex; flex-direction: column; gap: 0; padding-bottom: 2px; }
.rpe-cell { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
.rpe-cell--name { flex: 1.1; }
.rpe-cell--type { flex: 0.9; }
.rpe-cell--default { flex: 1; }
.rpe-required { flex: none; align-items: center; }
.rpe-cap, .rpe-sub-cap { font-size: var(--font-2xs); color: var(--text-muted); white-space: nowrap; }
.rpe input:not([type='checkbox']), .rpe select {
  width: 100%;
  box-sizing: border-box;
  height: var(--control-h-sm);
  padding: 0 var(--space-2);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-control);
  background: var(--bg-inset);
  color: var(--text-primary);
  font: inherit;
  font-size: var(--font-xs);
}
.rpe .rpe-name, .rpe .rpe-opt-value { font-family: var(--font-mono); }
.rpe input:focus, .rpe select:focus { outline: none; border-color: var(--accent-emphasis); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent-emphasis) 18%, transparent); }
.rpe-check { display: flex; align-items: center; height: var(--control-h-sm); }
.rpe-icon {
  display: grid;
  place-items: center;
  flex: none;
  width: 22px;
  height: 22px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
}
.rpe-icon svg { width: 13px; height: 13px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
.rpe-icon:hover:not(:disabled) { background: var(--bg-hover); color: var(--text-primary); }
.rpe-icon:disabled { opacity: 0.3; cursor: default; }
.rpe-icon:focus-visible { outline: 2px solid var(--accent-focus); outline-offset: 1px; }
.rpe-remove { margin-bottom: 4px; }
.rpe-remove:hover:not(:disabled) { color: var(--danger-fg); }

.rpe-sub { display: grid; grid-template-columns: 88px minmax(0, 1fr); align-items: start; gap: var(--space-2); padding-left: 26px; }
.rpe-sub-cap { padding-top: 6px; }
.rpe-opts, .rpe-conds { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); }
/* One choice = one chip: value and label share a border, so the pair reads
   as a unit rather than two loose inputs. */
.rpe-opt {
  display: inline-flex;
  align-items: center;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-control);
  background: var(--bg-inset);
  overflow: hidden;
}
.rpe-opt:focus-within { border-color: var(--accent-emphasis); }
.rpe .rpe-opt input { width: 104px; border: none; border-radius: 0; background: transparent; box-shadow: none; }
.rpe .rpe-opt .rpe-opt-label { border-left: 1px solid var(--border-muted); color: var(--text-secondary); }
.rpe-cond { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); width: 100%; }
.rpe-cond select { width: auto; max-width: 160px; }
.rpe-cond-is, .rpe-always { font-size: var(--font-xs); color: var(--text-muted); }
.rpe-always { padding-top: 4px; }
.rpe-cond-values { flex: 1; min-width: 120px; width: auto !important; }
.rpe-chips { display: inline-flex; flex-wrap: wrap; gap: var(--space-1); }
.rpe-cond-chip {
  height: 22px;
  padding: 0 var(--space-2);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-pill);
  background: var(--bg-elevated);
  color: var(--text-secondary);
  font: inherit;
  font-size: var(--font-2xs);
  font-family: var(--font-mono);
  cursor: pointer;
}
.rpe-cond-chip.is-on { border-color: var(--accent-emphasis); background: color-mix(in srgb, var(--accent-emphasis) 14%, transparent); color: var(--accent-fg); }
.rpe-cond-chip:focus-visible { outline: 2px solid var(--accent-focus); outline-offset: 1px; }
.rpe-problem { margin: 0; padding-left: 26px; font-size: var(--font-2xs); color: var(--danger-fg); }
</style>
