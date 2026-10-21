import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readdir, readlink } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

// A2-3 (DESIGN-A2 G2): what a developer folder held when it was loaded. Shown
// in the folder's info card only; Navide never compares it or refuses a load
// over it. No file count or size bound: a large folder takes longer, read as a
// stream off the main thread's critical path.

export interface FolderFingerprint {
  /** sha256 hex over `path\0size\0sha256(content)\n` of every file, sorted by
   * relative path (POSIX separators). */
  fingerprint: string
  fileCount: number
}

function fileDigest(path: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash('sha256')
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolvePromise(hash.digest('hex')))
  })
}

/** Every entry under `root` but `.git/`. A symbolic link is recorded by its
 * target text and never followed. */
async function walk(root: string, dir: string, out: string[]): Promise<void> {
  for (const name of await readdir(dir)) {
    if (dir === root && name === '.git') continue
    const path = join(dir, name)
    const entry = await lstat(path)
    if (entry.isDirectory()) await walk(root, path, out)
    else if (entry.isFile() || entry.isSymbolicLink()) out.push(path)
  }
}

export async function folderFingerprint(root: string): Promise<FolderFingerprint> {
  const files: string[] = []
  await walk(root, root, files)
  const entries = files.map((path) => ({ path, rel: relative(root, path).split(sep).join('/') }))
  entries.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
  const total = createHash('sha256')
  for (const { path, rel } of entries) {
    const entry = await lstat(path)
    if (entry.isSymbolicLink()) {
      const target = await readlink(path)
      total.update(`${rel}\0link\0${createHash('sha256').update(target).digest('hex')}\n`)
    } else {
      total.update(`${rel}\0${entry.size}\0${await fileDigest(path)}\n`)
    }
  }
  return { fingerprint: total.digest('hex'), fileCount: entries.length }
}
