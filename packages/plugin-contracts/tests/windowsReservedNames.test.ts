import { describe, expect, it } from 'vitest'
import {
  canonicalArchivePath,
  canonicalPackagePath,
  isValidManifestV2PluginId,
  validatePortableArchiveEntries,
} from '../src/index'

const RESERVED = ['CON', 'prn', 'Aux', 'nul', 'COM1', 'com9', 'LPT1', 'lpt9']

describe('Windows reserved device names', () => {
  it('are refused as any archive path segment, with or without an extension', () => {
    for (const name of RESERVED) {
      for (const segment of [name, `${name}.txt`, `${name}.tar.gz`, `${name} .js`]) {
        expect(canonicalArchivePath(`assets/${segment}`, 'regular'), segment).toBeNull()
        expect(canonicalArchivePath(`${segment}/index.html`, 'regular'), segment).toBeNull()
        expect(canonicalArchivePath(`${segment}/`, 'directory'), segment).toBeNull()
        expect(validatePortableArchiveEntries([{ path: `dist/${segment}`, type: 'regular' }]), segment)
          .toEqual({ kind: 'unsafe-path', path: `dist/${segment}` })
      }
    }
    expect(canonicalPackagePath('views/con.html')).toBeNull()
    for (const segment of ['con:stream', 'nul.', 'aux. ', 'CONIN$', 'conout$.txt', 'CLOCK$', 'COM\u00b9', 'lpt\u00b2.log', 'com\u00b3']) {
      expect(canonicalArchivePath(`dist/${segment}`, 'regular'), segment).toBeNull()
    }
  })

  it('leave names that only start with or contain a reserved word alone', () => {
    for (const path of ['console.js', 'icons/auxiliary.png', 'com10.txt', 'lpt0', 'com.txt', 'my-con.js', 'nullable/index.html']) {
      expect(canonicalArchivePath(path, 'regular'), path).toBe(path)
    }
  })

  it('are refused as a plugin id segment', () => {
    for (const id of ['con.tool', 'acme.nul', 'acme.com1', 'lpt9.x', 'acme.aux.view']) {
      expect(isValidManifestV2PluginId(id), id).toBe(false)
    }
    for (const id of ['acme.console', 'acme.com10', 'nulls.tool', 'acme.tool']) {
      expect(isValidManifestV2PluginId(id), id).toBe(true)
    }
  })
})
