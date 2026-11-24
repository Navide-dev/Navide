// @vitest-environment node
// The per-vendor launch overrides in Settings → CLI Agents, and the search
// entries for that tab's sections.
//
// Asserted against the source text rather than by mounting: the modal pulls in
// the analyzer, the updater and the MCP catalog, none of which this touches
// (same reasoning as SettingsModal.pushChannels.test.ts). What is worth pinning
// here is shape, not styling — a Model field that became a dropdown, or a
// search entry pointing at a section that does not exist, are both silent.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/components/SettingsModal.vue'),
  'utf8',
)

/** The `<section …data-settings-section="id">…</section>` block. */
function section(id: string): string {
  const start = source.indexOf(`data-settings-section="${id}"`)
  expect(start, `a section for ${id} should exist`).toBeGreaterThan(-1)
  const end = source.indexOf('</section>', start)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

describe('launch overrides section', () => {
  const body = section('cli-agents-launch')

  it('takes the model as free text — there is no list of model ids to offer', () => {
    // cliModel.ts: ids change with every vendor release, so a build-time list
    // would reject valid values. A <select> here would have to invent one.
    expect(body).toContain("$t('settings.cliLaunch.model-placeholder')")
    expect(body).toContain('@change="onLaunchModelInput(row.agentKey, $event)"')
    expect(body).not.toMatch(/opus-5"|sonnet"|gpt-5/)
  })

  it('takes the effort from the vendor spec, plus a "vendor default" empty option', () => {
    expect(body).toContain('v-for="level in row.knownEfforts"')
    expect(body).toContain("<option value=\"\">{{ $t('settings.cliLaunch.effort-vendor-default') }}</option>")
  })

  it('hints at an id whose level differs from the effort, after any refusal', () => {
    // A hint, not a refusal: applyLaunchModel still saves the pair.
    expect(body).toContain('v-else-if="launchEffortConflict(row.agentKey)" class="launch-effort-conflict"')
    expect(source).toContain('effortSuffixConflict({ spec, request })')
  })

  it('shows each field only when the vendor declares the flag behind it', () => {
    expect(body).toContain('v-if="row.supportsModel"')
    expect(body).toContain('v-if="row.supportsEffort"')
    // aider / droid declare neither, so the row says so instead of rendering
    // an empty body.
    expect(body).toContain('v-if="!row.supportsModel && !row.supportsEffort"')
  })

  it('says out loud that a launch command switches model and effort off', () => {
    // resolveCommand returns a non-empty override verbatim. That is existing
    // behaviour and is not changing, so the page has to state it — otherwise
    // setting both looks like it works.
    expect(body).toContain("$t('settings.cliLaunch.command-shadows-model')")
    expect(body).toContain('v-if="(launchCommands[row.agentKey] ?? \'\').trim()"')
  })

  it('says out loud that a rebuild or a restore launches on the default command', () => {
    // The setting only reaches a FRESH spawn: resume / rebuild / cold-restore
    // pass a rebuilt resume command as the override, which outranks it (see
    // App.launchOverride.test.ts). Leaving that in a code comment is how a
    // setting goes quietly missing after someone presses rebuild.
    expect(body).toContain("$t('settings.cliLaunch.command-shadows-resume')")
    // Both sentences hang off the same condition, so the second cannot be lost
    // while the first still shows.
    const warn = body.slice(body.indexOf('class="launch-warn"'))
    const shadowsModel = warn.indexOf('command-shadows-model')
    const shadowsResume = warn.indexOf('command-shadows-resume')
    expect(shadowsModel).toBeGreaterThan(-1)
    expect(shadowsResume).toBeGreaterThan(shadowsModel)
    expect(warn.indexOf('</div>')).toBeGreaterThan(shadowsResume)
  })

  it('marks a reserved env name without refusing it — soft block, not hard', () => {
    expect(body).toContain("isReservedSpawnEnvKey(entry.name, { foldCase: platformId() === 'win32' })")
    expect(body).toContain("$t('settings.cliLaunch.env-reserved-chip')")
    // The add button is gated on the NAME being usable, never on it being
    // reserved: the decision on record is that a reserved key may be saved.
    expect(body).toContain(':disabled="envDraftBlocked"')
  })

  it('derives the reserved list from the shared constant, not a second copy', () => {
    expect(source).toContain('SPAWN_ENV_RESERVED_KEYS.join')
    expect(body).toContain("$t('settings.cliLaunch.reserved-note', { list: reservedEnvKeyList })")
  })
})

describe('settings search — the CLI Agents tab', () => {
  const SECTIONS = [
    'cli-agents-list',
    'cli-agents-launch',
    'cli-agents-permissions',
    'cli-agents-push',
    'cli-agents-maintenance',
  ]

  it('has an entry for every section of the tab', () => {
    const items = [...source.matchAll(/section: '(cli-agents-[a-z]+)'/g)].map((m) => m[1])
    expect([...items].sort()).toEqual([...SECTIONS].sort())
  })

  it('points every entry at a section that exists — a jump target, not a guess', () => {
    // settingsSearchItems scrolls by querySelector on the attribute, so an id
    // with no matching element selects the tab and then silently does nothing.
    for (const id of SECTIONS) {
      expect(source, id).toContain(`data-settings-section="${id}"`)
    }
  })

  it('gives every entry both of its i18n keys', () => {
    for (const id of SECTIONS) {
      expect(source, id).toContain(`t('settings.search.item.${id}.title')`)
      expect(source, id).toContain(`t('settings.search.item.${id}.summary')`)
    }
  })
})
