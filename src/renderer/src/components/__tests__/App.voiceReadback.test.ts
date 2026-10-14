import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// App.vue is too large to mount, so — as App.paneMute.test.ts does — these pin
// the readback wiring by reading the source. With readback off (the default)
// every hook below is inert: announce() returns before queueing (see
// useReadbackAnnouncer.test.ts), the Esc handler only consumes the key when
// stop() reports something was playing, and the 🔊 toggle is not rendered.

const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

function fn(name: string): string {
  const at = appSource.indexOf(`function ${name}(`)
  if (at < 0) throw new Error(`${name} not found`)
  return appSource.slice(at, appSource.indexOf('\n}', at) + 2)
}

describe('voice readback wiring in App.vue', () => {
  it('speaks from the existing done and attention notifications', () => {
    expect(fn('scheduleDoneNotify')).toContain("readback.announce(paneId, 'done')")
    expect(fn('notifyAttention')).toContain("readback.announce(paneId, 'attention')")
  })

  it('Esc is consumed only when something was actually stopped', () => {
    expect(fn('onReadbackKeydown')).toContain("if (e.key !== 'Escape' || !readback.stop()) return")
  })

  it('starting dictation stops the readback (barge-in), and switching it off stops it', () => {
    expect(appSource).toContain("if (phase === 'starting' || phase === 'recording') readback.stop()")
    expect(appSource).toContain('watch(voiceReadbackEnabled, (on) => { if (!on) readback.stop() })')
  })

  it('the 🔊 toggle is offered only while readback is on', () => {
    expect(appSource).toContain(':readback-available="readbackOffered"')
    expect(appSource).toContain('const readbackOffered = computed(() => voiceReadbackEnabled.value && readbackSupported)')
  })

  it('dictation wiring is untouched: the voice capsule still only dismisses', () => {
    expect(appSource).toContain('<VoiceCapsule :state="voiceInput.state" @dismiss="voiceInput.dismiss" />')
  })
})
