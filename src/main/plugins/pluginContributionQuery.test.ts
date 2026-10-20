import { describe, expect, it } from 'vitest'
import { composePluginContributionQuery, composePluginFrameQuery } from './pluginContributionQuery'
import {
  HostLocaleManager,
  readPersistedLocaleFromSettings,
  resolveInitialHostLocale,
} from '../hostLocale'

describe('composePluginContributionQuery', () => {
  it.each(['navide.git.left', 'navide.plans.window', 'navide.mini-ide.window'])('preserves Japanese for %s', (contributionKey) => {
    const params = new URLSearchParams(composePluginContributionQuery({ contributionKey, workspacePath: '/workspace', theme: 'dark', locale: 'ja-JP' }))
    expect(params.get('locale')).toBe('ja-JP')
  })

  it('identifies an embedded Git contribution as the v2 left view with validated locale', () => {
    expect(composePluginContributionQuery({
      contributionKey: 'navide.git.left',
      workspacePath: '/workspace',
      theme: 'dark',
      locale: 'zh-TW',
      gitReadOnly: {
        git_yolo: '0',
        git_analyzer_model: 'qwen2:latest',
        git_theme_custom: '{}',
      },
    })).toBe(
      '?workspace_path=%2Fworkspace&theme=dark&locale=zh-TW&git_yolo=0&git_analyzer_model=qwen2%3Alatest&git_theme_custom=%7B%7D&v2=1&contribution=left'
    )
  })

  it('carries the workspace alias for a window contribution and omits it when blank', () => {
    const aliased = new URLSearchParams(composePluginContributionQuery({
      contributionKey: 'navide.plans.window',
      workspacePath: '/Users/dev/projects/agent-team',
      theme: 'dark',
      workspaceDisplayName: 'Navide',
    }))
    expect(aliased.get('workspace_display_name')).toBe('Navide')
    // The path stays the identity; the alias is display only.
    expect(aliased.get('workspace_path')).toBe('/Users/dev/projects/agent-team')

    const padded = new URLSearchParams(composePluginContributionQuery({
      contributionKey: 'navide.plans.window',
      workspacePath: '/Users/dev/projects/agent-team',
      theme: 'dark',
      workspaceDisplayName: '  Navide  ',
    }))
    expect(padded.get('workspace_display_name')).toBe('Navide')

    // Blank, whitespace-only and absent all mean "no alias": the param must
    // stay out so the view cannot tell them apart from an alias equal to the
    // folder name.
    for (const workspaceDisplayName of ['', '   ', undefined]) {
      const plain = new URLSearchParams(composePluginContributionQuery({
        contributionKey: 'navide.plans.window',
        workspacePath: '/Users/dev/projects/agent-team',
        theme: 'dark',
        workspaceDisplayName,
      }))
      expect(plain.has('workspace_display_name')).toBe(false)
    }
  })

  it('identifies a standalone Git contribution as the v2 window view with validated locale', () => {
    const query = composePluginContributionQuery({
      contributionKey: 'navide.git.window',
      workspacePath: '/workspace',
      theme: 'dark',
      locale: 'en-US',
      httpUrl: 'http://127.0.0.1:8787',
      gitReadOnly: {
        git_yolo: '1',
        git_analyzer_model: '',
        git_theme_custom: '{\"accent\":\"blue\"}',
      },
      extraParams: {
        git_diff_filepath: 'src/main.ts',
        git_diff_staged: '1',
      },
    })

    expect(Object.fromEntries(new URLSearchParams(query))).toEqual({
      git_diff_filepath: 'src/main.ts',
      git_diff_staged: '1',
      workspace_path: '/workspace',
      http_url: 'http://127.0.0.1:8787',
      theme: 'dark',
      locale: 'en-US',
      git_yolo: '1',
      git_analyzer_model: '',
      git_theme_custom: '{\"accent\":\"blue\"}',
      v2: '1',
      contribution: 'window',
    })
  })

  it('identifies Plans left and window contributions with Host-authoritative validated locale', () => {
    const left = new URLSearchParams(composePluginContributionQuery({
      contributionKey: 'navide.plans.left',
      workspacePath: '/workspace',
      theme: 'dark',
      locale: 'zh-TW',
    }))
    const window = new URLSearchParams(composePluginContributionQuery({
      contributionKey: 'navide.plans.window',
      workspacePath: '/workspace',
      theme: 'dark',
      locale: 'en-US',
      extraParams: { rel_path: '.agent-team/plans/example.html' },
    }))

    expect(left.get('contribution')).toBe('left')
    expect(left.get('locale')).toBe('zh-TW')
    expect(window.get('contribution')).toBe('window')
    expect(window.get('locale')).toBe('en-US')
    expect(window.get('rel_path')).toBe('.agent-team/plans/example.html')
  })

  it('fails closed to zh-TW for invalid Host locale without adding an absent locale', () => {
    const invalidLocale = new URLSearchParams(composePluginContributionQuery({
      contributionKey: 'navide.plans.window',
      workspacePath: '/workspace',
      theme: 'dark',
      locale: 'it-IT',
    }))
    const recognizedLocale = new URLSearchParams(composePluginContributionQuery({
      contributionKey: 'navide.plans.window',
      workspacePath: '/workspace',
      theme: 'dark',
      locale: 'fr-FR',
    }))
    const missingLocale = new URLSearchParams(composePluginContributionQuery({
      contributionKey: 'navide.plans.left',
      workspacePath: '/workspace',
      theme: 'dark',
    }))

    expect(invalidLocale.get('locale')).toBe('zh-TW')
    // A recognized UI locale passes through; the view falls back to en-US
    // itself when it has no catalog for it.
    expect(recognizedLocale.get('locale')).toBe('fr-FR')
    expect(missingLocale.get('locale')).toBeNull()
  })

  it('composes both Git and Plans contribution queries from persisted raw/JSON canonical locales via HostLocaleManager', () => {
    // 1. Raw persisted zh-TW
    const rawZhSettings = { 'agent-team:language': 'zh-TW' }
    const rawZhManager = {
      getLocale: () => resolveInitialHostLocale({
        persistedSetting: readPersistedLocaleFromSettings(rawZhSettings),
        systemLocale: 'en-US',
      }),
    }
    const gitLeftRawZh = new URLSearchParams(composePluginContributionQuery({
      contributionKey: 'navide.git.left',
      workspacePath: '/workspace',
      theme: 'dark',
      locale: rawZhManager.getLocale(),
      gitReadOnly: { git_yolo: '0' },
    }))
    expect(gitLeftRawZh.get('locale')).toBe('zh-TW')
    expect(gitLeftRawZh.get('contribution')).toBe('left')
    expect(gitLeftRawZh.get('workspace_path')).toBe('/workspace')
    expect(gitLeftRawZh.get('git_yolo')).toBe('0')
    expect(gitLeftRawZh.get('v2')).toBe('1')

    const leftRawZh = new URLSearchParams(composePluginContributionQuery({
      contributionKey: 'navide.plans.left',
      workspacePath: '/workspace',
      theme: 'dark',
      locale: rawZhManager.getLocale(),
    }))
    const windowRawZh = new URLSearchParams(composePluginContributionQuery({
      contributionKey: 'navide.plans.window',
      workspacePath: '/workspace',
      theme: 'dark',
      locale: rawZhManager.getLocale(),
      extraParams: { rel_path: '.agent-team/plans/my-plan.html' },
    }))

    expect(leftRawZh.get('locale')).toBe('zh-TW')
    expect(leftRawZh.get('contribution')).toBe('left')
    expect(windowRawZh.get('locale')).toBe('zh-TW')
    expect(windowRawZh.get('contribution')).toBe('window')
    expect(windowRawZh.get('rel_path')).toBe('.agent-team/plans/my-plan.html')

    // 2. Legacy JSON-encoded "en-US"
    const jsonEnSettings = { 'agent-team:language': '\"en-US\"' }
    const jsonEnManager = {
      getLocale: () => resolveInitialHostLocale({
        persistedSetting: readPersistedLocaleFromSettings(jsonEnSettings),
        systemLocale: 'zh-TW',
      }),
    }
    const gitWindowJsonEn = new URLSearchParams(composePluginContributionQuery({
      contributionKey: 'navide.git.window',
      workspacePath: '/workspace',
      theme: 'light',
      locale: jsonEnManager.getLocale(),
      httpUrl: 'http://127.0.0.1:8787',
      extraParams: { git_diff_filepath: 'src/main.ts' },
    }))
    expect(gitWindowJsonEn.get('locale')).toBe('en-US')
    expect(gitWindowJsonEn.get('contribution')).toBe('window')
    expect(gitWindowJsonEn.get('http_url')).toBe('http://127.0.0.1:8787')
    expect(gitWindowJsonEn.get('git_diff_filepath')).toBe('src/main.ts')

    const leftJsonEn = new URLSearchParams(composePluginContributionQuery({
      contributionKey: 'navide.plans.left',
      workspacePath: '/workspace',
      theme: 'light',
      locale: jsonEnManager.getLocale(),
    }))
    const windowJsonEn = new URLSearchParams(composePluginContributionQuery({
      contributionKey: 'navide.plans.window',
      workspacePath: '/workspace',
      theme: 'light',
      locale: jsonEnManager.getLocale(),
      extraParams: { rel_path: '.agent-team/plans/spec.html' },
    }))

    expect(leftJsonEn.get('locale')).toBe('en-US')
    expect(leftJsonEn.get('contribution')).toBe('left')
    expect(windowJsonEn.get('locale')).toBe('en-US')
    expect(windowJsonEn.get('contribution')).toBe('window')
    expect(windowJsonEn.get('rel_path')).toBe('.agent-team/plans/spec.html')
  })

  it('keeps Host-owned context authoritative over extra entry parameters including locale', () => {
    const query = composePluginContributionQuery({
      contributionKey: 'navide.git.window',
      workspacePath: '/trusted-workspace',
      theme: 'dark',
      locale: 'en-US',
      httpUrl: 'http://127.0.0.1:8787',
      gitReadOnly: { git_yolo: '0' },
      extraParams: {
        workspace_path: '/untrusted-workspace',
        theme: 'light',
        locale: 'zh-TW',
        http_url: 'https://example.invalid',
        git_yolo: '1',
        v2: '0',
        contribution: 'left',
        git_diff_filepath: 'src/main.ts',
      },
    })

    expect(Object.fromEntries(new URLSearchParams(query))).toEqual({
      git_diff_filepath: 'src/main.ts',
      workspace_path: '/trusted-workspace',
      http_url: 'http://127.0.0.1:8787',
      theme: 'dark',
      locale: 'en-US',
      git_yolo: '0',
      v2: '1',
      contribution: 'window',
    })
  })

  it('gives a composed frame its workspace, its runtime and its view id', () => {
    // A detail frame mounts the wrong surface without the view id: the shipped
    // Git detail page boots its window app instead and drops the Host target.
    const detail = new URLSearchParams(composePluginFrameQuery('navide.git.branch-detail', '/workspace'))
    expect(detail.get('workspace_path')).toBe('/workspace')
    expect(detail.get('v2')).toBe('1')
    expect(detail.get('contribution')).toBe('branch-detail')

    expect(new URLSearchParams(composePluginFrameQuery('navide.git.left', '/w')).get('contribution')).toBe('left')
    expect(new URLSearchParams(composePluginFrameQuery('navide.plans.window', '/w')).get('contribution')).toBe('window')
  })

  it('drops an extra locale when the Host did not provide one', () => {
    const query = new URLSearchParams(composePluginContributionQuery({
      contributionKey: 'navide.git.left',
      workspacePath: '/workspace',
      theme: 'dark',
      extraParams: { locale: 'zh-TW' },
    }))

    expect(query.get('locale')).toBeNull()
  })
})
