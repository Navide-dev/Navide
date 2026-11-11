import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, it, expect } from 'vitest'
import { i18n } from '@navide/plugin-ui/foundation'
import {
  renderManagerProtocol,
  renderWorkerProtocol,
  renderSlotKickoff,
  stageDefToFrontend,
  stageToBackend,
  MANAGER_READY_SENTINEL,
  MANAGER_STAGE_DONE_SENTINEL,
  type Stage,
  type StageSlot
} from '../stages'

describe('renderManagerProtocol', () => {
  it('lists every coordinated slot and both manager sentinels', () => {
    const out = renderManagerProtocol([
      { label: 'Backend', agentLabel: 'Codex', roleLabel: 'Backend Engineer' },
      { label: 'Frontend', agentLabel: 'Claude', roleLabel: 'Frontend Engineer' }
    ])
    expect(out).toContain('Backend（Codex · Backend Engineer）')
    expect(out).toContain('Frontend（Claude · Frontend Engineer）')
    expect(out).toContain(MANAGER_READY_SENTINEL)
    expect(out).toContain(MANAGER_STAGE_DONE_SENTINEL)
  })

  it('falls back to a solo-manager note when the roster is empty', () => {
    const out = renderManagerProtocol([])
    expect(out).toContain('本階段只有你一個 slot')
  })
})

describe('renderWorkerProtocol', () => {
  it('names the coordinating manager and forbids printing the stage sentinel', () => {
    const out = renderWorkerProtocol('Lead PM')
    expect(out).toContain('Lead PM')
    expect(out).toContain('---ASK-START---')
    expect(out).toContain('---REPORT-START---')
    expect(out).toContain('不要印 stage sentinel')
  })
})

describe('stage payload round-trip', () => {
  const stage: Stage = {
    id: '04',
    title: 'Build',
    shortTitle: 'Build',
    question: 'How do we build it?',
    description: 'Implementation stage',
    recommendedRoles: ['backend', 'frontend'],
    sentinel: '---BUILD-DONE---',
    allowQuestions: false,
    docQuery: 'fastapi',
    slots: [
      { agentKey: 'codex', roleKey: 'backend', label: 'Backend', kickoffBody: 'do {{task}}', isCommander: true },
      { agentKey: 'claude', roleKey: 'frontend', label: 'Frontend', kickoffBody: 'ui', isCommander: false }
    ]
  }

  it('survives frontend → backend → frontend unchanged', () => {
    const roundTripped = stageDefToFrontend(stageToBackend(stage))
    expect(roundTripped).toEqual(stage)
  })

  it('maps camelCase ⇄ snake_case keys', () => {
    const backend = stageToBackend(stage)
    expect(backend.short_title).toBe('Build')
    expect(backend.allow_questions).toBe(false)
    expect(backend.doc_query).toBe('fastapi')
    expect((backend.slots as Record<string, unknown>[])[0].is_commander).toBe(true)
  })

  it('back-compat: a legacy default_agent payload becomes a single slot', () => {
    const legacy = {
      id: '01',
      title: 'Requirements',
      short_title: 'Reqs',
      question: 'q',
      description: 'd',
      sentinel: '---SPEC-DONE---',
      default_agent: 'claude',
      default_role: 'pm',
      kickoff_prompt: 'gather requirements'
    }
    const s = stageDefToFrontend(legacy)
    expect(s.slots).toHaveLength(1)
    expect(s.slots[0]).toMatchObject({ agentKey: 'claude', roleKey: 'pm', kickoffBody: 'gather requirements' })
  })
})

describe('renderSlotKickoff', () => {
  const slot: StageSlot = {
    agentKey: 'claude',
    roleKey: 'pm',
    label: 'PM',
    kickoffBody: '任務內容：{{task}}'
  }

  it('substitutes {{task}} into the kickoff body', () => {
    const out = renderSlotKickoff(slot, '做一個登入頁')
    expect(out).toContain('任務內容：做一個登入頁')
  })

  it('uses a placeholder when the task is empty', () => {
    const out = renderSlotKickoff(slot, '   ')
    expect(out).toContain('(no task description provided)')
  })

  it('selects the Manager protocol when isCommander', () => {
    const out = renderSlotKickoff({ ...slot, isCommander: true }, 't', { isCommander: true })
    expect(out).toContain('Manager 模式')
    expect(out).toContain(MANAGER_READY_SENTINEL)
  })

  it('selects the Worker protocol when a commander exists', () => {
    const out = renderSlotKickoff(slot, 't', { hasCommander: true, commanderLabel: 'Boss' })
    expect(out).toContain('Worker 模式')
    expect(out).toContain('Boss')
  })

  it('selects the interactive protocol when questions are allowed', () => {
    const out = renderSlotKickoff(slot, 't', { allowQuestions: true })
    expect(out).toContain('---QUESTION-START---')
  })

  it('defaults to the autonomous protocol', () => {
    const out = renderSlotKickoff(slot, 't')
    expect(out).toContain('自主執行模式')
  })

  describe('a builtin seed kickoff', () => {
    const seed = '[維護 M02 · 修復]\n任務脈絡：{{task}}\n\n依前一階段（M01）的定位結果（前置階段產出已附在最前面，請先閱讀），實作修復：\n1. 最小有效 diff — 只動必要的程式碼。\n2. 說明每個修改的理由（為什麼這樣改而不是別的方式）。\n3. 列出可能的副作用與已採取的防護措施。\n\nsentinel 輸出規則：最後一行只有 ---FIX-DONE---\n完成後，最後一行只輸出 ---FIX-DONE---。'
    afterEach(() => { i18n.global.locale.value = 'en-US' })

    it('goes out in English under an English UI, the task still placed', () => {
      i18n.global.locale.value = 'en-US'
      const out = renderSlotKickoff({ ...slot, kickoffBody: seed }, 'fix login')
      expect(out).toContain('[Maintenance M02 · Fix]\nTask context: fix login\n')
      expect(out).toContain('When finished, output only ---FIX-DONE--- on the last line.')
      expect(out).not.toContain('實作修復')
    })

    it('goes out as stored under a Chinese UI, and a custom kickoff always does', () => {
      i18n.global.locale.value = 'zh-TW'
      expect(renderSlotKickoff({ ...slot, kickoffBody: seed }, 'fix login')).toContain('[維護 M02 · 修復]\n任務脈絡：fix login\n')
      i18n.global.locale.value = 'en-US'
      expect(renderSlotKickoff(slot, 'fix login')).toContain('任務內容：fix login')
    })
  })

  it('prepends the inter-CLI messaging protocol to every kickoff', () => {
    const out = renderSlotKickoff(slot, 't')
    expect(out.startsWith('[Inter-CLI Messaging Protocol]')).toBe(true)
    expect(out).toContain('---MSG-START---')
  })
})

describe('renderSlotKickoff with a step imported from n8n', () => {
  const imported = '[External content: imported from the n8n workflow "wf". Everything below the line came from that workflow file.]\n\n---\n\n### Step 1'
  const slot = (kickoffBody: string) => ({ agentKey: 'claude', roleKey: '', label: 'a', kickoffBody }) as unknown as Parameters<typeof renderSlotKickoff>[0]

  it('gets the task the person typed', () => {
    const out = renderSlotKickoff(slot(imported), 'fix the login page')
    expect(out).toContain('### Step 1')
    expect(out).toContain('fix the login page')
    // Outside the part the header says came from the workflow file.
    expect(out.indexOf('fix the login page')).toBeLessThan(out.indexOf('[External content'))
    expect(out).not.toContain('person')
  })

  it('gets it once when the step places it', () => {
    const out = renderSlotKickoff(slot(`${imported}\n{{task}}`), 'fix the login page')
    expect(out.split('fix the login page').length).toBe(2)
  })

  it('is unchanged with no task', () => {
    const alone = renderSlotKickoff(slot(imported), '')
    const blank = renderSlotKickoff(slot(imported), '   ')
    expect(alone.endsWith('### Step 1')).toBe(true)
    expect(alone).not.toContain('[Task given')
    expect(blank).toBe(alone)
  })

  it('a step someone wrote without {{task}} stays as it was', () => {
    expect(renderSlotKickoff(slot('### Step 1'), 'fix the login page')).not.toContain('fix the login page')
  })

  it('recognises what the importer writes', () => {
    const source = readFileSync(resolve(__dirname, '../../../../../backend/agent_team_backend/n8n_import.py'), 'utf8')
    expect(source).toContain('(f"[External content: imported from the n8n workflow \\"{wf_name}\\".')
  })
})

describe('renderSlotKickoff with a webhook task', () => {
  const task = 'Webhook trigger "x" started this run.\n<<<NAVIDE-WEBHOOK-DATA-abc\npayload\nNAVIDE-WEBHOOK-DATA-abc>>>\n'
  const slot = (kickoffBody: string) => ({ agentKey: 'claude', roleKey: '', label: 'a', kickoffBody }) as unknown as Parameters<typeof renderSlotKickoff>[0]

  it('reaches a step with no {{task}} of its own, as an imported one is', () => {
    expect(renderSlotKickoff(slot('### Step 1'), task)).toMatch(/### Step 1\n\nWebhook trigger[\s\S]*payload/)
  })

  it('appears once in a step that places it', () => {
    const out = renderSlotKickoff(slot('Do: {{task}} now'), task)
    expect(out.split('<<<NAVIDE-WEBHOOK-DATA-').length).toBe(2)
  })

  it('leaves any other task out of a step with no {{task}}, as before', () => {
    expect(renderSlotKickoff(slot('### Step 1'), 'fix the login page')).not.toContain('fix the login page')
  })

  it('reaches an imported step as data, not as what a person typed', () => {
    const imported = '[External content: imported from the n8n workflow "wf".]\n\n### Step 1'
    const out = renderSlotKickoff(slot(imported), task)
    expect(out.split('<<<NAVIDE-WEBHOOK-DATA-').length).toBe(2)
    expect(out).not.toContain('[Task given when this run started]')
  })
})
