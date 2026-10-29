import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { createI18n } from 'vue-i18n'
import { describe, expect, it } from 'vitest'

// vue-i18n reads | as a plural separator, { } as a placeholder and @ as a
// linked message, so a literal one has to be written {'|'}, {'{'} or {'@'}.
// Left bare, `curl | sh` turned guard.policy.levels into a two-case plural and
// the Security page showed only the text before the pipe.
const localeDirs = [
  'packages/plugin-ui/src/foundation/i18n/locales',
  'plugins/navide-plans/src/locales',
  'plugins/navide-browser/src/locales'
]
// Every catalog in the folder, so a new language is checked without editing this.
const localesIn = (dir: string): string[] =>
  readdirSync(resolve(dir)).filter((name) => name.endsWith('.json')).map((name) => name.replace(/\.json$/, '')).sort()
const LOCALES = localesIn(localeDirs[0])

// Keys that are meant to be plurals (called with a count).
const PLURAL_KEYS = [
  'plans.share.days',
  'settings.credentials.banner-high',
  'settings.cliAgents.chip.accounts',
  'settings.skills.delivery-auto',
  'time.ago-minutes',
  'time.ago-hours',
  'time.ago-days',
  'time.ago-months',
  'pipelineEditor.lane.more',
  'pipelineEditor.run.reset-message',
  'pipelineImport.needs-review',
  'pipelineImport.imported-review',
  'pipelineImport.merged-nodes',
  'pipelineImport.will-create',
  'editorWindow.problems.errors',
  'editorWindow.problems.warnings',
  'git.branch-diff.file-count',
  'git.branch-diff.hidden-lines',
  'editorWindow.paths-copied',
  'editorWindow.replaced-occurrences',
  'editorWindow.close-editor-dirty',
  'editorWindow.close-others-dirty',
  'editorWindow.close-right-dirty',
  'editorWindow.close-left-dirty',
  'editorWindow.close-all-dirty',
  'editorWindow.reload-dirty',
  'editorWindow.quit-dirty',
  'confirm-close.sidebar-ws-body',
  'confirm-close.sidebar-ws-body-pipeline-only',
  'git.auto-commit-lint-aborted',
  'pane.plans.archive-all-confirm',
  'pane.plans.archived-count',
  'pane.plans.history-diff-todos-added',
  'pane.plans.history-diff-todos-removed',
  'pane.plans.delete-completed-confirm',
  'pane.plans.deleted-count',
  'pane.terminal.session-resumed',
  'pane.terminal.session-resume-failed',
  'pane.terminal.idle-reclaimed',
  'pane.terminal.rebuild-busy-skipped-batch',
  'pane.terminal.rebuild-running-confirm-body-batch',
  'pane.terminal.rebuild-batch-confirm-body',
  'pane.terminal.subtree-tooltip',
  'action.open-files',
  'action.stage-files',
  'action.unstage-files',
  'action.discard-files',
  'settings.extensions.pack.uninstallWithMembers',
  'settings.general.idle-reclaim-now-hint',
  'settings.sharing.bundle.preview-intro',
  'settings.p2p.pair.commands-summary',
  'settings.p2p.trust.pending-panes',
  'settings.keybindings.export-done',
  'settings.keybindings.import-done',
  'settings.keybindings.customized-count',
  'settings.accounts.cli.account-dir-in-use-error',
  'settings.analyzer.models',
  'label.role-rename-repointed',
  'label.stage-count',
  'label.pipeline-count',
  'label.exported-stages',
  'label.imported-stages',
  'label.exported-roles',
  'label.imported-roles',
  'label.nested-repos-title',
  'label.conflict-files',
  'label.merge-conflict-files',
  'label.pipeline-log-manager-ready',
  'label.question-answer-all',
  'stageTab.close-running-confirm-body',
  'stageTab.free-mode-untouched',
  'updater.check-failure',
  'announce.quota.not-switched',
  'restore.dialog-message',
  'restore.skipped-title',
  'restore.scope-message',
  'backfill.tidying',
  'reconnect.banner',
  'reconnect.auto-toast',
  'cli-account.panes-running',
  'cli-account.switch-restart-confirm-body',
  'cli-account.login-blocked-by-live-panes',
  'closeAll.confirm',
  'closeAll.done',
  'usage.follow-hint',
  'usage.pinned-hint',
  'channels.bot.remove-ask',
  'channels.bindings.children',
  'channels.bindings.selected',
  'channels.bindings.batch-ask',
  'channels.bindings.batch-note',
  'pipelineEditor.exec.unattributed',
  'evolve.panel.legacy-disabled',
  'evolve.panel.legacy-hint',
  'account-follow.switch-confirm',
  'account-follow.quota-confirm',
  'account-follow.follow-title',
  'account-follow.unpin-title',
  'pluginDisclosure.scan.shell.dynamic',
  'pluginDisclosure.scan.code.eval.frontend',
  'pluginDisclosure.scan.code.eval.backend',
  'pluginDisclosure.registry.secretFindings'
]

function leaves(value: unknown, prefix = ''): Array<[string, string]> {
  if (typeof value === 'string') return [[prefix, value]]
  if (!value || typeof value !== 'object') return []
  return Object.entries(value).flatMap(([key, child]) => leaves(child, prefix ? `${prefix}.${key}` : key))
}

function load(dir: string, locale: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(dir, `${locale}.json`), 'utf8'))
}

describe('locale message syntax', () => {
  for (const dir of localeDirs) {
    it.each(localesIn(dir))(`${dir}/%s has no accidental plurals`, (locale) => {
      // Outside a {…} placeholder every | splits the message into plural cases.
      const plurals = leaves(load(dir, locale))
        .filter(([, text]) => text.replace(/\{[^{}]*\}/g, '').includes('|'))
        .map(([key]) => key)
        .filter((key) => !PLURAL_KEYS.includes(key))
      expect(plurals, `unescaped | in: ${plurals.join(', ')}`).toEqual([])
    })
  }

  it.each(LOCALES)('renders guard.policy.levels in %s with the literal curl | sh', (locale) => {
    const messages = load(localeDirs[0], locale)
    const i18n = createI18n({ legacy: false, locale, messages: { [locale]: messages } as Record<string, Record<string, string>> })
    // The full message tree is too deep for vue-i18n's key typing (TS2589).
    const { t } = i18n.global as unknown as { t: (key: string) => string }
    const text = t('guard.policy.levels')
    expect(text).toContain('curl | sh')
    expect(text).toContain('rm -rf')
  })
})
