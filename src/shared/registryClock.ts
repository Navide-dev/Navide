/** Which way this computer's clock looks off when a Registry trust check
 *  refuses over it (pluginRegistryTrust.ts words those refusals `CODE: text`,
 *  possibly after a caller's own prefix). Trust data or a signature dated
 *  later than the clock means the clock is behind; trust data expired by it
 *  means the clock may be ahead (or, for a stored copy, that Navide has not
 *  reached the Registry for over a day). Wording only: it decides nothing. */
export type RegistryClockRefusal = 'behind' | 'ahead'

const CLOCK_REFUSAL =
  /(?:^|: )(?<code>TRUST_METADATA_NOT_YET_VALID|REGISTRY_SIGNATURE_NOT_YET_VALID|TRUST_METADATA_EXPIRED): /

export function registryClockRefusal(message: string): RegistryClockRefusal | null {
  const code = CLOCK_REFUSAL.exec(message)?.groups?.code
  if (!code) return null
  return code === 'TRUST_METADATA_EXPIRED' ? 'ahead' : 'behind'
}

/** The coded clock refusal inside `message`, from its code on. */
export function registryClockRefusalText(message: string): string | null {
  const match = CLOCK_REFUSAL.exec(message)
  if (!match) return null
  return message.slice(match.index + (match[0].startsWith(': ') ? 2 : 0))
}
