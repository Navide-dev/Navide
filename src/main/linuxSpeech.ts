import { isLinux } from '../shared/osplat'

/** The slice of Electron's `app.commandLine` this needs. */
export interface SpeechCommandLine {
  appendSwitch(name: string, value?: string): void
}

/**
 * On Linux, Chromium's speechSynthesis talks to speech-dispatcher only when
 * --enable-speech-dispatcher is set; without it getVoices() is empty and every
 * utterance fails, so voice readback is silent. Must run before the app is
 * ready. Off Linux it touches nothing.
 */
export function applyLinuxSpeechDispatcher(commandLine: SpeechCommandLine): boolean {
  if (!isLinux()) return false
  commandLine.appendSwitch('enable-speech-dispatcher')
  return true
}
