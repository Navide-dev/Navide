// Cloud issue shapes and the text Navide sends an agent pane when the Git
// plugin hands it an issue (dispatch to a running pane, or a kickoff for a new
// one). The issue panel itself belongs to the navide-git plugin.

export type IssueProvider = 'github' | 'gitlab' | 'unknown'

export interface IssueComment {
  author: string
  body: string
  created_at: string
}

export interface Issue {
  number: number
  title: string
  state: string // 'open' | 'closed'
  author: string
  labels: string[]
  assignees: string[]
  updated_at: string
  url: string
}

export interface IssueDetail extends Issue {
  body: string
  created_at: string
  comments: IssueComment[]
}

export type IssueHandlerMode = 'guided' | 'auto'

// Build a kickoff prompt for a new dedicated agent pane that will handle the
// issue end-to-end. Pure function — no component dependencies.
// The issue list row has no body, so the agent is instructed to fetch full
// details itself via the provider CLI.
export function buildIssueKickoff(
  issue: Issue,
  provider: IssueProvider,
  mode: IssueHandlerMode,
): string {
  const isGitLab = provider === 'gitlab'
  const viewCmd = isGitLab ? `glab issue view ${issue.number}` : `gh issue view ${issue.number}`
  const closeCmd = isGitLab ? `glab issue close ${issue.number}` : `gh issue close ${issue.number}`

  const steps =
    mode === 'guided'
      ? `1. Run \`${viewCmd}\` to read the full description and comments.
2. Analyze the issue and the relevant code in this repository.
3. Propose a specific fix plan with file paths. **STOP here — do not modify any files until I approve.**
4. After receiving approval, implement the fix and run tests to verify.
5. Once verified, close the issue: \`${closeCmd} --comment "Fixed: <one-line summary>"\``
      : `1. Run \`${viewCmd}\` to read the full description and comments.
2. Analyze the issue and the relevant code in this repository.
3. Implement the fix and run tests to verify.
4. Close the issue: \`${closeCmd} --comment "Fixed: <one-line summary>"\`

Work autonomously end-to-end. No approval checkpoint needed.`

  return `You are an autonomous agent working on Issue #${issue.number}: "${issue.title}".

## Your Task
${steps}`
}

// Format an issue as the task text injected into a running agent pane. Pure so
// it can be unit-tested without a component. No role/protocol preamble — the
// target agent is already running with its own context.
export function formatIssueForDispatch(issue: IssueDetail): string {
  const parts: string[] = [
    'Please work on this issue:',
    '',
    `#${issue.number} ${issue.title}`,
  ]
  if (issue.body.trim()) {
    parts.push('', issue.body.trim())
  }
  if (issue.comments.length) {
    parts.push('', '--- comments ---')
    for (const c of issue.comments) {
      parts.push(`${c.author}: ${c.body}`)
    }
  }
  if (issue.url) {
    parts.push('', `Link: ${issue.url}`)
  }
  return parts.join('\n')
}
