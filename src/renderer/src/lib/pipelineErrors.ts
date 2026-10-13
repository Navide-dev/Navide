// Turns a backend rejection from the pipeline/stage/role handlers into text in
// the UI language. The handlers answer with a stable `code` plus an English
// sentence; codes the editor understands get their own translated message, and
// anything else falls back to the backend's sentence (better than a bare
// "failed") or, without one, the caller's generic key.

export interface BackendErrorLike {
  code?: string
  message?: string
}

type Translate = (key: string, named?: Record<string, unknown>) => string

const KNOWN_CODES: Record<string, string> = {
  PIPELINE_RUNNING: 'pipelineEditor.error.pipeline-running',
  PIPELINE_NOT_FOUND: 'pipelineEditor.error.pipeline-not-found',
}

export function backendErrorText(
  t: Translate,
  error: BackendErrorLike | null | undefined,
  fallbackKey: string
): string {
  const known = error?.code ? KNOWN_CODES[error.code] : undefined
  if (known) return t(known)
  return error?.message || t(fallbackKey)
}
