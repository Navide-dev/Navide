import { afterEach, describe, it, expect } from 'vitest'
import { platformId, setPlatformId, type PlatformId } from '../shared/osplat'
import { applyLinuxSpeechDispatcher } from './linuxSpeech'

describe('applyLinuxSpeechDispatcher', () => {
  const BASELINE = platformId()
  afterEach(() => setPlatformId(BASELINE))

  function run(platform: PlatformId) {
    setPlatformId(platform)
    const appended: Array<[string, string | undefined]> = []
    const applied = applyLinuxSpeechDispatcher({ appendSwitch: (name, value) => appended.push([name, value]) })
    return { applied, appended }
  }

  it('enables speech-dispatcher on Linux so speechSynthesis has voices', () => {
    expect(run('linux')).toEqual({ applied: true, appended: [['enable-speech-dispatcher', undefined]] })
  })

  it.each(['darwin', 'win32'] as const)('touches nothing on %s', (platform) => {
    expect(run(platform)).toEqual({ applied: false, appended: [] })
  })
})
