/** Workspace file reads and writes the Host answers through the backend `fs.*`
 *  channel. Used by the diff and file previews; not tied to Git. */
export interface FileReadResult {
  ok: boolean
  content: string
  error?: string
}

export interface FileWriteResult {
  ok: boolean
  error?: string
}

export interface FileAccessPort {
  readFile(workspacePath: string, relPath: string): Promise<FileReadResult>
  writeFile(workspacePath: string, relPath: string, content: string): Promise<FileWriteResult>
  readImage(workspacePath: string, relPath: string): Promise<string>
}
