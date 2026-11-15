#!/usr/bin/env node
// Upload Settings → Help screenshots to the S3 bucket behind dl.navide.dev.
//
//   node scripts/upload-help-screenshots.mjs <dir>            # dry run (default)
//   node scripts/upload-help-screenshots.mjs <dir> --apply    # upload, then write the manifest
//
// <dir> holds `<locale>/<shot-id>.png` (or .webp), e.g. `zh-TW/cliAgents.menu.png`.
// Each file goes to `help/<shot-id>/<locale>/<sha256-12>.<ext>`: the key carries
// the content hash, so a changed picture is a new URL and the old one can stay
// cached forever. The manifest the App reads
// (src/renderer/src/lib/helpScreenshots.json) is rewritten only after every
// upload succeeded.
//
// Safety: this script writes nothing but `help/` keys, one `aws s3api
// put-object` at a time. It never lists, syncs or deletes — the bucket also
// serves `releases/`, which mirror.yml keeps with `--delete`. Credentials come
// from the AWS CLI's own chain (profile, SSO, env); none are read or stored here.
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const DEFAULT_BUCKET = 'navide-releases'
export const HELP_PREFIX = 'help/'
export const CACHE_CONTROL = 'public, max-age=31536000, immutable'
const MANIFEST = fileURLToPath(new URL('../src/renderer/src/lib/helpScreenshots.json', import.meta.url))

const SHOT_ID = /^[A-Za-z0-9][A-Za-z0-9.-]*$/
const LOCALE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/
const KEY = /^help\/[A-Za-z0-9][A-Za-z0-9.-]*\/[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*\/[0-9a-f]{12}\.(png|webp)$/
const TYPES = { png: 'image/png', webp: 'image/webp' }

/** Throws unless `key` is a content-hashed object under help/. */
export function assertHelpKey(key) {
  if (typeof key !== 'string' || !key.startsWith(HELP_PREFIX) || key.includes('..') || !KEY.test(key)) {
    throw new Error(`refusing to write outside help/: ${JSON.stringify(key)}`)
  }
  return key
}

/** One upload per screenshot file found in `dir`. */
export function planUploads(dir) {
  const plans = []
  for (const locale of readdirSync(dir).sort()) {
    const localeDir = join(dir, locale)
    if (!statSync(localeDir).isDirectory()) continue
    if (!LOCALE.test(locale)) throw new Error(`not a locale folder: ${locale}`)
    for (const name of readdirSync(localeDir).sort()) {
      const match = /^(.+)\.(png|webp)$/.exec(name)
      if (!match) continue
      const [, id, ext] = match
      if (!SHOT_ID.test(id)) throw new Error(`not a screenshot id: ${locale}/${name}`)
      const file = join(localeDir, name)
      const hash = createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 12)
      const fileName = `${hash}.${ext}`
      plans.push({ id, locale, file, fileName, contentType: TYPES[ext], key: assertHelpKey(`${HELP_PREFIX}${id}/${locale}/${fileName}`) })
    }
  }
  return plans
}

/** The `aws` argv that uploads one planned file; PutObject only. */
export function putObjectArgs(plan, bucket = DEFAULT_BUCKET) {
  return [
    's3api', 'put-object',
    '--bucket', bucket,
    '--key', assertHelpKey(plan.key),
    '--body', plan.file,
    '--content-type', plan.contentType,
    '--cache-control', CACHE_CONTROL,
  ]
}

/** `manifest` with every planned file recorded under its id and locale. */
export function mergeManifest(manifest, plans) {
  const shots = { ...manifest.shots }
  for (const p of plans) shots[p.id] = { ...shots[p.id], [p.locale]: p.fileName }
  const sorted = Object.fromEntries(Object.keys(shots).sort().map((id) => [id, shots[id]]))
  return { ...manifest, shots: sorted }
}

function main(argv) {
  const args = argv.filter((a) => !a.startsWith('--'))
  const apply = argv.includes('--apply')
  const bucketArg = argv.find((a) => a.startsWith('--bucket='))
  const bucket = bucketArg ? bucketArg.slice('--bucket='.length) : DEFAULT_BUCKET
  if (args.length !== 1) {
    console.error('usage: upload-help-screenshots.mjs <dir> [--apply] [--bucket=name]')
    return 2
  }
  const dir = resolve(args[0])
  const plans = planUploads(dir)
  if (plans.length === 0) {
    console.error(`no <locale>/<id>.png|webp files under ${dir}`)
    return 1
  }
  for (const p of plans) {
    console.log(`${apply ? 'upload' : 'would upload'} ${relative(dir, p.file)} -> s3://${bucket}/${p.key}`)
  }
  if (!apply) {
    console.log(`dry run: ${plans.length} file(s), nothing uploaded, manifest unchanged. Re-run with --apply once approved.`)
    return 0
  }
  for (const p of plans) {
    const run = spawnSync('aws', putObjectArgs(p, bucket), { stdio: ['ignore', 'ignore', 'inherit'] })
    if (run.status !== 0) {
      console.error(`upload failed for ${p.key}; manifest left unchanged`)
      return 1
    }
  }
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))
  writeFileSync(MANIFEST, `${JSON.stringify(mergeManifest(manifest, plans), null, 2)}\n`)
  console.log(`uploaded ${plans.length} file(s); updated ${relative(process.cwd(), MANIFEST)}`)
  return 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2))
}
