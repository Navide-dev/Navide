// Card K4 (review LOW-2 on #428): the main process words its Developer Mode
// refusals in English after a stable code (`CODE [id]: text`, the English
// text kept for logs); the user reads them in their own language.
const CODED = /^(?<code>[A-Z_]+)(?: \[(?<id>[^\]]+)\])?: (?<detail>[\s\S]*)$/

const KEYS: Readonly<Record<string, string>> = {
  DEVELOPER_FOLDER_HOLDS_ID: 'holdsId',
  ANOTHER_DEVELOPER_FOLDER: 'anotherFolder',
  DEVELOPER_FOLDER_ID_INSTALLED: 'idInstalled',
  DEVELOPER_MODE_OFF: 'modeOff',
  DEVELOPER_FOLDER_V2_ONLY: 'v2Only',
  DEVELOPER_FOLDER_RESERVED_ID: 'reservedId',
  DEVELOPER_FOLDER_CHANGED: 'changed',
  DEVELOPER_FOLDER_TAKEN_DOWN: 'takenDown',
  // A file install the same flows show: a file on Navide's blocked-digest list.
  DIGEST_BLOCKED: 'settings.extensions.localInstall.errors.digestBlocked',
  // A Registry install or update refused over the computer's clock.
  TRUST_METADATA_NOT_YET_VALID: 'settings.extensions.registryTrust.errors.notYetValid',
  REGISTRY_SIGNATURE_NOT_YET_VALID: 'settings.extensions.registryTrust.errors.signatureNotYetValid',
  TRUST_METADATA_EXPIRED: 'settings.extensions.registryTrust.errors.expired',
}

/** The localized text of a coded Developer Mode refusal; any other message
 *  is returned as it is. */
export function localizeDeveloperModeError(
  message: string,
  t: (key: string, values?: Record<string, unknown>) => string,
): string {
  const groups = CODED.exec(message)?.groups
  const key = groups ? KEYS[groups.code] : undefined
  if (!groups || !key) return message
  const path = key.includes('.') ? key : `settings.extensions.developerMode.errors.${key}`
  return t(path, { id: groups.id ?? '', detail: groups.detail })
}
