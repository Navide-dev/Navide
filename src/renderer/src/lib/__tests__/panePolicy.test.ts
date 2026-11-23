import { describe, expect, it } from 'vitest'
import {
  ANY,
  addRule,
  allowsOwnDevices,
  makeRule,
  mayApplyToOrgMachines,
  ownDevicesRule,
  readPolicy,
  removeRuleAt,
  sameRule,
  withOwnDevices,
  type PolicyDocument
} from '../panePolicy'

const MEMBER = 'member-1'

function doc(...rules: PolicyDocument['rules']): PolicyDocument {
  return { version: 1, default: 'deny', rules }
}

describe('readPolicy', () => {
  it('reads a device that has never configured anything as "refuse everything"', () => {
    for (const raw of [null, undefined, 0, 'policy', [], {}]) {
      expect(readPolicy(raw)).toEqual({ version: 1, default: 'deny', rules: [] })
    }
  })

  it('keeps well-formed allow rules', () => {
    const rule = makeRule({ memberId: MEMBER, deviceId: 'd1', workspace: 'proj', paneName: 'x' })
    expect(readPolicy({ version: 1, default: 'deny', rules: [rule] }).rules).toEqual([rule])
  })

  it('drops rules it cannot render rather than showing half of one', () => {
    const policy = {
      version: 1,
      default: 'deny',
      rules: [
        'not an object',
        { action: 'deny', from: { memberId: MEMBER, deviceId: ANY }, to: { workspace: ANY, paneName: ANY } },
        { action: 'allow', from: { memberId: MEMBER }, to: { workspace: ANY, paneName: ANY } },
        { action: 'allow', from: { memberId: MEMBER, deviceId: ANY }, to: { workspace: ANY, paneName: ANY } }
      ]
    }
    expect(readPolicy(policy).rules).toEqual([ownDevicesRule(MEMBER)])
  })

  it('refuses to reissue a policy of another version at this one', () => {
    const rules = [ownDevicesRule(MEMBER)]
    expect(readPolicy({ version: 2, default: 'deny', rules }).rules).toEqual([])
  })
})

describe('makeRule', () => {
  it('turns a blank field into "any", because the editor leaves it optional', () => {
    expect(makeRule({})).toEqual({
      from: { memberId: ANY, deviceId: ANY },
      to: { workspace: ANY, paneName: ANY },
      action: 'allow'
    })
    expect(makeRule({ workspace: '  proj  ' }).to.workspace).toBe('proj')
  })
})

describe('the own-devices switch', () => {
  it('is one rule keyed on the member, so a device bought later is covered', () => {
    expect(ownDevicesRule(MEMBER)).toEqual({
      from: { memberId: MEMBER, deviceId: ANY },
      to: { workspace: ANY, paneName: ANY },
      action: 'allow'
    })
  })

  it('reads as off until that exact rule is present', () => {
    expect(allowsOwnDevices(doc(), MEMBER)).toBe(false)
    expect(allowsOwnDevices(doc(makeRule({ memberId: MEMBER, deviceId: 'd1' })), MEMBER)).toBe(false)
    expect(allowsOwnDevices(doc(ownDevicesRule(MEMBER)), MEMBER)).toBe(true)
  })

  it('is off — and unwritable — before the link reports a member id', () => {
    const before = doc()
    expect(allowsOwnDevices(before, '')).toBe(false)
    expect(withOwnDevices(before, '', true)).toBe(before)
  })

  it('turning it off leaves narrower rules the user wrote by hand alone', () => {
    const mine = makeRule({ memberId: MEMBER, deviceId: 'd1', workspace: 'proj' })
    const on = withOwnDevices(doc(mine), MEMBER, true)
    expect(on.rules).toEqual([mine, ownDevicesRule(MEMBER)])

    expect(withOwnDevices(on, MEMBER, false).rules).toEqual([mine])
  })

  it('turning it on twice does not stack duplicates', () => {
    const on = withOwnDevices(doc(), MEMBER, true)
    expect(withOwnDevices(on, MEMBER, true).rules).toHaveLength(1)
  })
})

describe('rule list editing', () => {
  it('never adds a duplicate, which would grant nothing and only hide the list', () => {
    const rule = makeRule({ memberId: ANY, deviceId: 'd1' })
    const once = addRule(doc(), rule)
    expect(addRule(once, makeRule({ deviceId: 'd1' })).rules).toHaveLength(1)
  })

  it('removes by position, leaving the rest in order', () => {
    const a = makeRule({ deviceId: 'd1' })
    const b = makeRule({ deviceId: 'd2' })
    const c = makeRule({ deviceId: 'd3' })
    expect(removeRuleAt(doc(a, b, c), 1).rules).toEqual([a, c])
    expect(removeRuleAt(doc(a), 4).rules).toEqual([a])
    expect(removeRuleAt(doc(a), -1).rules).toEqual([a])
  })

  it('compares every field, so two rules differing anywhere stay apart', () => {
    const base = makeRule({ memberId: MEMBER, deviceId: 'd1', workspace: 'proj', paneName: 'x' })
    expect(sameRule(base, { ...base })).toBe(true)
    expect(sameRule(base, makeRule({ memberId: MEMBER, deviceId: 'd1', workspace: 'proj', paneName: 'y' }))).toBe(false)
  })

  it('does not mutate the document it was handed', () => {
    const before = doc(makeRule({ deviceId: 'd1' }))
    const snapshot = JSON.parse(JSON.stringify(before))
    addRule(before, makeRule({ deviceId: 'd2' }))
    removeRuleAt(before, 0)
    withOwnDevices(before, MEMBER, true)
    expect(before).toEqual(snapshot)
  })
})

describe('a rule tied to an organization grant', () => {
  const tagged = {
    from: { memberId: 'm-org', deviceId: 'dev-org' },
    to: { workspace: 'proj', paneName: 'lead' },
    action: 'allow',
    grantId: 'g_1',
  }
  const raw = { version: 1, default: 'deny', rules: [tagged] }

  it('keeps its grantId through reading', () => {
    expect(readPolicy(raw).rules).toEqual([tagged])
  })

  it('keeps its grantId when any other rule is added, removed or toggled', () => {
    const doc = readPolicy(raw)
    const added = addRule(doc, makeRule({ memberId: 'm2', workspace: 'w', paneName: 'p' }))
    expect(added.rules[0]).toEqual(tagged)
    expect(removeRuleAt(added, 1).rules).toEqual([tagged])
    expect(withOwnDevices(doc, 'm1', true).rules[0]).toEqual(tagged)
    expect(withOwnDevices(withOwnDevices(doc, 'm1', true), 'm1', false).rules).toEqual([tagged])
  })

  it('is not the same rule as the untagged one', () => {
    const { grantId: _drop, ...untagged } = tagged
    expect(sameRule(readPolicy(raw).rules[0], untagged as never)).toBe(false)
    expect(addRule(readPolicy(raw), untagged as never).rules).toHaveLength(2)
  })
})

describe('mayApplyToOrgMachines', () => {
  const rule = (memberId: string, deviceId: string, grantId?: string) => ({
    ...makeRule({ memberId, deviceId, workspace: 'w', paneName: 'p' }),
    ...(grantId ? { grantId } : {}),
  })

  it('flags wildcard members and other accounts, not this account or a grant-tagged rule', () => {
    expect(mayApplyToOrgMachines(rule(ANY, ANY), MEMBER)).toBe(true)
    expect(mayApplyToOrgMachines(rule('someone-else', 'dev-x'), MEMBER)).toBe(true)
    expect(mayApplyToOrgMachines(rule(MEMBER, ANY), MEMBER)).toBe(false)
    expect(mayApplyToOrgMachines(ownDevicesRule(MEMBER), MEMBER)).toBe(false)
    expect(mayApplyToOrgMachines(rule('m-org', 'dev-org', 'g_1'), MEMBER)).toBe(false)
  })
})
