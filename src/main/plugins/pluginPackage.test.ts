import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { deflateRawSync } from 'node:zlib'
import { readZipEntries, readManifestFromEntries, PluginPackageError } from './pluginPackage'
import { assertSafeArchiveEntries } from './pluginVerify'
import { makeZip } from './zipFixture'

const u16 = (n: number): Buffer => {
  const b = Buffer.alloc(2)
  b.writeUInt16LE(n, 0)
  return b
}
const u32 = (n: number): Buffer => {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(n, 0)
  return b
}

describe('readZipEntries', () => {
  it.each(
    (
      JSON.parse(
        readFileSync(join(process.cwd(), 'docs/plugin-contracts/archive-entry-types-v1.json'), 'utf8')
      ) as {
        cases: Array<{
          name: string
          path: string
          type: 'regular' | 'directory' | 'symlink' | 'special'
          creator: 'unix' | 'dos'
          dosDirectory: boolean
          expected: 'regular' | 'directory' | 'rejected'
        }>
      }
    ).cases
  )('$name uses the shared archive entry-type contract', ({ path, type, creator, dosDirectory, expected }) => {
    const kind = type === 'regular' ? 'file' : type
    const entries = readZipEntries(
      makeZip([{ name: path, data: '', kind, creator, dosDirectory }])
    )
    if (expected === 'rejected') {
      expect(() => assertSafeArchiveEntries(entries)).toThrow(/regular file or directory/)
    } else {
      expect(entries[0].type).toBe(expected)
    }
  })

  it('decodes stored entries and preserves directory metadata', () => {
    const zip = makeZip([
      { name: 'manifest.json', data: '{"id":"acme.demo"}' },
      { name: 'dist/', data: '' },
      { name: 'dist/main.js', data: 'console.log(1)' },
    ])
    const entries = readZipEntries(zip)
    const paths = entries.map((e) => e.path).sort()
    expect(paths).toEqual(['dist/', 'dist/main.js', 'manifest.json'])
    expect(entries.find((e) => e.path === 'dist/')?.kind).toBe('directory')
    expect(entries.find((e) => e.path === 'dist/')?.type).toBe('directory')
    expect(entries.find((e) => e.path === 'dist/main.js')?.data.toString()).toBe('console.log(1)')
  })

  it('retains only the regular-file executable intent from Unix metadata', () => {
    const entries = readZipEntries(
      makeZip([
        { name: 'backend/entry', data: 'binary', unixMode: 0o100755 },
        { name: 'frontend/index.html', data: 'html', unixMode: 0o100644 },
        { name: 'dos.exe', data: 'binary', creator: 'dos' },
        { name: 'dir/', data: '', unixMode: 0o040755 },
      ])
    )
    expect(entries.find((entry) => entry.path === 'backend/entry')?.executable).toBe(true)
    expect(entries.find((entry) => entry.path === 'frontend/index.html')?.executable).toBe(false)
    expect(entries.find((entry) => entry.path === 'dos.exe')?.executable).toBe(false)
    expect(entries.find((entry) => entry.path === 'dir/')?.executable).toBe(false)
  })

  it('keeps trailing-slash symlinks classified as symlinks', () => {
    const entries = readZipEntries(makeZip([{ name: 'link/', data: 'target', kind: 'symlink' }]))
    expect(entries[0].type).toBe('symlink')
    expect(() => assertSafeArchiveEntries(entries)).toThrow(/regular file or directory/)
  })

  it('rejects case-folded archive aliases before manifest selection', () => {
    const entries = readZipEntries(
      makeZip([
        { name: 'manifest.json', data: '{"id":"acme.demo"}' },
        { name: 'MANIFEST.JSON', data: '{"id":"acme.attacker"}' },
      ])
    )
    expect(() => readManifestFromEntries(entries)).toThrow(/duplicate archive entry path/)
  })

  it('decodes deflate (method 8) entries', () => {
    // Hand-build a single deflated entry to exercise the inflate path.
    const payload = Buffer.from('x'.repeat(500))
    const comp = deflateRawSync(payload)
    const name = Buffer.from('big.txt')
    const u16 = (n: number) => {
      const b = Buffer.alloc(2)
      b.writeUInt16LE(n, 0)
      return b
    }
    const u32 = (n: number) => {
      const b = Buffer.alloc(4)
      b.writeUInt32LE(n, 0)
      return b
    }
    const local = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0), u16(8), u16(0), u16(0), u32(0),
      u32(comp.length), u32(payload.length), u16(name.length), u16(0), name, comp,
    ])
    const central = Buffer.concat([
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(8), u16(0), u16(0), u32(0),
      u32(comp.length), u32(payload.length), u16(name.length), u16(0), u16(0), u16(0),
      u16(0), u32(0), u32(0), name,
    ])
    const eocd = Buffer.concat([
      u32(0x06054b50), u16(0), u16(0), u16(1), u16(1), u32(central.length), u32(local.length), u16(0),
    ])
    const zip = Buffer.concat([local, central, eocd])
    const entries = readZipEntries(zip)
    expect(entries[0].data.toString()).toBe(payload.toString())
  })

  it('throws on a non-zip buffer', () => {
    expect(() => readZipEntries(new Uint8Array([1, 2, 3]))).toThrow(PluginPackageError)
  })

  it('rejects ZIP64 end-of-central-directory sentinels', () => {
    const zip = makeZip([{ name: 'manifest.json', data: '{"id":"acme.demo"}' }])
    zip.writeUInt16LE(0xffff, zip.length - 14)
    zip.writeUInt16LE(0xffff, zip.length - 12)
    expect(() => readZipEntries(zip)).toThrow(/ZIP64 archives are not supported/)
  })

  it('rejects a zip bomb (deflate inflating past the per-entry limit)', () => {
    // 60 MB of zeros compresses to a few KB but exceeds the 50 MB entry cap;
    // inflating it must raise a PluginPackageError, not exhaust memory.
    const payload = Buffer.alloc(60 * 1024 * 1024)
    const comp = deflateRawSync(payload)
    const name = Buffer.from('bomb.bin')
    const local = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0), u16(8), u16(0), u16(0), u32(0),
      u32(comp.length), u32(payload.length), u16(name.length), u16(0), name, comp,
    ])
    const central = Buffer.concat([
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(8), u16(0), u16(0), u32(0),
      u32(comp.length), u32(payload.length), u16(name.length), u16(0), u16(0), u16(0),
      u16(0), u32(0), u32(0), name,
    ])
    const eocd = Buffer.concat([
      u32(0x06054b50), u16(0), u16(0), u16(1), u16(1), u32(central.length), u32(local.length), u16(0),
    ])
    const zip = Buffer.concat([local, central, eocd])
    expect(() => readZipEntries(zip)).toThrow(PluginPackageError)
  })

  it('rejects a stored entry whose declared size exceeds the per-entry limit', () => {
    const zip = makeZip([{ name: 'large.bin', data: Buffer.alloc(51 * 1024 * 1024) }])
    expect(() => readZipEntries(zip)).toThrow(/exceeds the .* limit/)
  })

  it('throws PluginPackageError (not RangeError) on an out-of-bounds local offset', () => {
    // Central directory entry whose localOffset points past the buffer end.
    const name = Buffer.from('x.js')
    const central = Buffer.concat([
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0), u32(0),
      u32(4), u32(4), u16(name.length), u16(0), u16(0), u16(0),
      u16(0), u32(0), u32(0xffffffff), name, // localOffset = huge → out of bounds
    ])
    const eocd = Buffer.concat([
      u32(0x06054b50), u16(0), u16(0), u16(1), u16(1), u32(central.length), u32(0), u16(0),
    ])
    const zip = Buffer.concat([central, eocd])
    expect(() => readZipEntries(zip)).toThrow(PluginPackageError)
  })

  // The Registry parses packages with Python's zipfile, which walks the central
  // directory by size rather than by EOCD entry count. Every archive the two
  // readers could see differently is refused here.
  it('rejects an EOCD entry count that leaves central directory entries unread', () => {
    const zip = makeZip([
      { name: 'manifest.json', data: '{"id":"acme.demo"}' },
      { name: 'hidden.js', data: 'x' },
    ])
    zip.writeUInt16LE(1, zip.length - 14)
    zip.writeUInt16LE(1, zip.length - 12)
    expect(() => readZipEntries(zip)).toThrow(/central directory does not end at/)
  })

  it('rejects bytes between the central directory and the EOCD record', () => {
    const zip = makeZip([{ name: 'manifest.json', data: '{"id":"acme.demo"}' }])
    const gapped = Buffer.concat([
      zip.subarray(0, zip.length - 22),
      Buffer.from('junk'),
      zip.subarray(zip.length - 22),
    ])
    expect(() => readZipEntries(gapped)).toThrow(/central directory does not end at/)
  })

  it('rejects a local header name that differs from the central directory name', () => {
    const zip = makeZip([{ name: 'a.js', data: 'x' }])
    zip.write('b', 30) // first byte of the local header's file name
    expect(() => readZipEntries(zip)).toThrow(/local header name does not match/)
  })
})

describe('readManifestFromEntries', () => {
  it('reads and parses the root manifest.json', () => {
    const zip = makeZip([{ name: 'manifest.json', data: '{"id":"acme.demo","version":"1.0.0"}' }])
    const manifest = readManifestFromEntries(readZipEntries(zip))
    expect(manifest.id).toBe('acme.demo')
  })

  it('throws when manifest.json is absent', () => {
    const zip = makeZip([{ name: 'readme.md', data: '# hi' }])
    expect(() => readManifestFromEntries(readZipEntries(zip))).toThrow(/no manifest\.json/)
  })

  it('throws on invalid manifest JSON', () => {
    const zip = makeZip([{ name: 'manifest.json', data: '{ not json' }])
    expect(() => readManifestFromEntries(readZipEntries(zip))).toThrow(/not valid JSON/)
  })

  it('rejects invalid UTF-8 in manifest bytes instead of replacing it', () => {
    const zip = makeZip([
      { name: 'manifest.json', data: Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d]) },
    ])
    expect(() => readManifestFromEntries(readZipEntries(zip))).toThrow(
      /manifest\.json is not valid UTF-8/
    )
  })

  it('rejects duplicate keys from the shared contract fixture', () => {
    const raw = readFileSync(
      join(process.cwd(), 'docs/plugin-contracts/fixtures/invalid-raw/duplicate-permission-key.json'),
      'utf8'
    )
    const zip = makeZip([{ name: 'manifest.json', data: raw }])
    expect(() => readManifestFromEntries(readZipEntries(zip))).toThrow(
      /duplicate JSON object key: system/
    )
  })

  it('rejects a UTF-8 BOM in manifest bytes', () => {
    const raw = readFileSync(
      join(process.cwd(), 'docs/plugin-contracts/fixtures/invalid-raw/manifest-utf8-bom.json')
    )
    const zip = makeZip([{ name: 'manifest.json', data: raw }])
    expect(() => readManifestFromEntries(readZipEntries(zip))).toThrow(/BOM/)
  })
})
