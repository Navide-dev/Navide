import { describe, expect, it } from 'vitest'
import { registryClockRefusal, registryClockRefusalText } from './registryClock'

const notYet =
  "TRUST_METADATA_NOT_YET_VALID: registry trust metadata was generated at 2026-08-16T12:10:00.000Z, later than this computer's clock (2026-08-16T12:00:00.000Z); check the computer's date and time"
const signature =
  "REGISTRY_SIGNATURE_NOT_YET_VALID: registry signature was made at 2026-08-16T12:10:00.000Z, later than this computer's clock (2026-08-16T12:00:00.000Z); check the computer's date and time"
const expired =
  "TRUST_METADATA_EXPIRED: registry trust metadata expired at 2026-08-17T10:00:00.000Z by this computer's clock (2026-08-18T00:00:00.000Z); check the computer's date and time"

describe('registryClockRefusal', () => {
  it('reads which way the clock looks off', () => {
    expect(registryClockRefusal(notYet)).toBe('behind')
    expect(registryClockRefusal(signature)).toBe('behind')
    expect(registryClockRefusal(expired)).toBe('ahead')
  })

  it('finds the code after a caller\'s own words', () => {
    expect(registryClockRefusal(`staged candidate quarantined: ${expired}`)).toBe('ahead')
    expect(registryClockRefusalText(`installed plugin quarantined: ${notYet}`)).toBe(notYet)
    expect(registryClockRefusalText(notYet)).toBe(notYet)
  })

  it('leaves every other refusal alone', () => {
    for (const message of [
      'registry trust metadata signature failed verification against the pinned root',
      "TESTPLACE_EXPIRED: testplace version 'acme.beta@0.3.0' expired at 2026-08-16T13:00:00.000Z",
      'mentions TRUST_METADATA_EXPIRED without a code',
    ]) {
      expect(registryClockRefusal(message)).toBeNull()
      expect(registryClockRefusalText(message)).toBeNull()
    }
  })
})
