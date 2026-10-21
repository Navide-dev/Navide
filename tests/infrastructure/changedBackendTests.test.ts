import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { importsOf, moduleOf, parseArgs, selectTests } from '../../scripts/changed-backend-tests.mjs'

const fixture: Record<string, string> = {
  'backend/agent_team_backend/__init__.py': '',
  'backend/agent_team_backend/alpha.py': 'import os\n',
  'backend/agent_team_backend/pkg/__init__.py': 'from . import beta\n',
  'backend/agent_team_backend/pkg/beta.py': 'from ..alpha import thing\n',
  'backend/tests/conftest.py': 'import pytest\n',
  'backend/tests/helpers.py': '',
  'backend/tests/test_alpha.py': 'from agent_team_backend import alpha\n',
  'backend/tests/test_beta.py': 'from agent_team_backend.pkg.beta import (\n    run,  # used below\n    stop,\n)\n',
  'backend/tests/test_patch.py': 'def test(m):\n    m.setattr("agent_team_backend.alpha.thing", 1)\n',
  'backend/tests/test_reads_ui.py': 'SEED = ROOT / "src" / "renderer" / "seed.ts"\n',
  'backend/tests/test_unrelated.py': 'import json\n',
  'src/renderer/seed.ts': '',
  'src/renderer/App.vue': '',
}
const repo = { files: Object.keys(fixture), read: (path: string) => fixture[path] }

describe('changed backend test selection', () => {
  it('names backend modules and packages', () => {
    expect(moduleOf('backend/agent_team_backend/pkg/beta.py')).toBe('agent_team_backend.pkg.beta')
    expect(moduleOf('backend/agent_team_backend/pkg/__init__.py')).toBe('agent_team_backend.pkg')
    expect(moduleOf('backend/tests/test_alpha.py')).toBeNull()
    expect(moduleOf('src/main/index.ts')).toBeNull()
  })

  it('reads absolute, relative and multi-line imports', () => {
    expect([...importsOf(fixture['backend/agent_team_backend/pkg/beta.py'], 'agent_team_backend.pkg.beta', false)])
      .toEqual(['agent_team_backend.alpha', 'agent_team_backend.alpha.thing'])
    expect([...importsOf(fixture['backend/agent_team_backend/pkg/__init__.py'], 'agent_team_backend.pkg', true)])
      .toEqual(['agent_team_backend.pkg', 'agent_team_backend.pkg.beta'])
    expect([...importsOf(fixture['backend/tests/test_beta.py'], '', false)])
      .toEqual(['agent_team_backend.pkg.beta', 'agent_team_backend.pkg.beta.run', 'agent_team_backend.pkg.beta.stop'])
  })

  it('selects a changed test file itself', () => {
    expect(selectTests(['backend/tests/test_unrelated.py'], repo)).toEqual(['backend/tests/test_unrelated.py'])
  })

  it('selects the tests that import or patch a changed module', () => {
    expect(selectTests(['backend/agent_team_backend/alpha.py'], repo))
      .toEqual(['backend/tests/test_alpha.py', 'backend/tests/test_patch.py'])
    expect(selectTests(['backend/agent_team_backend/pkg/beta.py'], repo)).toEqual(['backend/tests/test_beta.py'])
  })

  it('counts a changed package for the submodules imported from it', () => {
    expect(selectTests(['backend/agent_team_backend/pkg/__init__.py'], repo)).toEqual(['backend/tests/test_beta.py'])
  })

  it('selects the tests that name a changed non-backend file', () => {
    expect(selectTests(['src/renderer/seed.ts'], repo)).toEqual(['backend/tests/test_reads_ui.py'])
    expect(selectTests(['src/renderer/App.vue'], repo)).toEqual([])
  })

  it.each([
    'backend/tests/conftest.py',
    'backend/tests/helpers.py',
    'backend/tests/fixtures/data.json',
    'backend/pyproject.toml',
    'backend/uv.lock',
    'backend/agent_team_backend.spec',
  ])('runs the whole suite when %s changes', (file) => {
    expect(selectTests([file, 'backend/tests/test_alpha.py'], repo)).toEqual(['backend/tests'])
  })

  it('ignores a deleted test file', () => {
    expect(selectTests(['backend/tests/test_gone.py'], repo)).toEqual([])
  })
})

describe('changed backend tests arguments', () => {
  it('reads the base, --list and the pytest arguments', () => {
    expect(parseArgs([])).toEqual({ base: 'origin/main', list: false, pytestArgs: [] })
    expect(parseArgs(['main~3', '--list', '--', '-x', '--help'])).toEqual({ base: 'main~3', list: true, pytestArgs: ['-x', '--help'] })
  })

  it('answers --help with the usage and runs nothing', () => {
    for (const flag of ['--help', '-h']) expect(parseArgs([flag])).toEqual({ help: true })
  })

  it('refuses an unknown flag or a second base with the usage', () => {
    for (const argv of [['--bogus'], ['-x'], ['--list', '--lsit'], ['main', 'other']]) {
      expect(parseArgs(argv)).toEqual({ error: expect.stringContaining(argv[argv.length - 1]) })
    }
  })
})

describe('changed backend test selection on this repository', () => {
  const files = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean)
  const real = { files, read: (path: string) => readFileSync(path, 'utf8') }

  it('finds the known readers of a module and of a renderer file', () => {
    expect(selectTests(['backend/agent_team_backend/prompt_skills.py'], real)).toContain('backend/tests/test_prompt_skills.py')
    expect(selectTests(['src/renderer/src/lib/promptSkillSeed.ts'], real)).toContain('backend/tests/test_prompt_skills.py')
  })

  // 0.2.27 time-shift follow-up: a changed product module selects its tests,
  // not only changed test files (the approval TTLs and confirm_by).
  it('selects the tests of changed product code the 0.2.27 time-shift run missed', () => {
    expect(selectTests(['backend/agent_team_backend/skills_approvals.py'], real)).toContain('backend/tests/test_plugin_agent_approvals.py')
    expect(selectTests(['backend/agent_team_backend/mcp_server/server.py'], real)).toContain('backend/tests/test_plan_mcp_ui_invoke.py')
  })
})

describe('changed backend tests run isolated', () => {
  const list = (path: string) => readFileSync(path, 'utf8').match(/NO_SANDBOX_FILES=\(\n([^)]*)\)/)?.[1].trim().split(/\s+/)

  it('keeps the no-sandbox list equal to the release gate', () => {
    expect(list('scripts/isolated-pytest.sh')).toEqual(list('scripts/release-backend-tests.sh'))
    expect(list('scripts/isolated-pytest.sh')?.length).toBeGreaterThan(0)
  })

  it('never runs pytest outside the isolated runner, and never syncs', () => {
    const runner = readFileSync('scripts/changed-backend-tests.mjs', 'utf8')
    expect(runner).toContain("'scripts/isolated-pytest.sh'")
    expect(runner).not.toMatch(/spawnSync\(\s*'uv'/)
    const isolated = readFileSync('scripts/isolated-pytest.sh', 'utf8')
    const uvRuns = isolated.split('\n').filter((line) => line.includes('"$UV" --project'))
    expect(uvRuns.length).toBeGreaterThan(0)
    for (const line of uvRuns) expect(line).toContain('run --no-sync pytest')
    for (const guard of ['env -i', 'HOME="$SCRATCH/home"', 'PATH="$SCRATCH/bin:', '(deny process-exec (literal "/usr/bin/security"))']) {
      expect(isolated).toContain(guard)
    }
  })
})
