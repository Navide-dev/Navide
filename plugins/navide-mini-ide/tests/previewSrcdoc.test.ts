import { describe, expect, it } from 'vitest'
import { previewSrcdoc } from '../src/editor/preview/previewSrcdoc'

describe('previewSrcdoc', () => {
  it('prefixes a CSP that refuses every network load', () => {
    const doc = previewSrcdoc('<img src="https://evil.test/x.png">')
    expect(doc.startsWith(
      '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; style-src \'unsafe-inline\'; font-src data:">',
    )).toBe(true)
    expect(doc).toContain('<img src="https://evil.test/x.png">')
  })
})
