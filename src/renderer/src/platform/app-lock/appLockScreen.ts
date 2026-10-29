import type { AppLockResult, AppLockScreenBridge, AppLockScreenInit } from '../../../../shared/appLock'
import { APP_LOCK_BACKGROUND } from '../../../../shared/appLock'

// The App Lock screen main lays over each window. Deliberately independent of
// the Host app, backend clients and vue-i18n: its preload exposes only the
// unlock IPC, and its strings arrive from main with the init data.

const STYLE = `
  html, body, #app { margin: 0; height: 100%; }
  body { background: ${APP_LOCK_BACKGROUND}; color: #e6e8eb; user-select: none;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  .lock { height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px; padding: 0 16px; text-align: center; }
  .lock-icon { width: 44px; height: 44px; opacity: 0.85; }
  h1 { font-size: 20px; font-weight: 600; margin: 0; }
  .sub { font-size: 13px; color: #9aa1ab; margin: 0 0 6px; }
  form { display: flex; gap: 8px; }
  input { width: 180px; font-size: 16px; letter-spacing: 0.2em; padding: 8px 10px; border-radius: 8px;
    border: 1px solid #3a3f47; background: #0f1115; color: inherit; outline: none; text-align: center; }
  input:focus { border-color: #5b8def; }
  button { font-size: 13px; padding: 8px 14px; border-radius: 8px; border: 1px solid #3a3f47; background: #23272e; color: inherit; cursor: pointer; }
  button.primary { background: #3b6fd8; border-color: #3b6fd8; color: #fff; }
  button:disabled { opacity: 0.5; cursor: default; }
  .msg { min-height: 18px; font-size: 12.5px; color: #f08a7e; margin: 0; }
  .hint { font-size: 12px; color: #7d848e; max-width: 420px; margin: 8px 0 0; }
`

const LOCK_ICON = '<svg class="lock-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4.5" y="10.5" width="15" height="10" rx="2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/></svg>'

function element<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}): HTMLElementTagNameMap[K] {
  return Object.assign(document.createElement(tag), props)
}

/** Builds the lock screen into `root`; exported for tests. */
export function mountAppLockScreen(root: HTMLElement, bridge: AppLockScreenBridge, init: AppLockScreenInit): void {
  const s = init.strings
  const box = element('div', { className: 'lock' })
  box.innerHTML = LOCK_ICON
  const pin = element('input', { type: 'password', inputMode: 'numeric', autocomplete: 'off', maxLength: 12, placeholder: s.pinLabel })
  pin.setAttribute('aria-label', s.pinLabel)
  const unlock = element('button', { type: 'submit', className: 'primary', textContent: s.unlock })
  const form = element('form')
  form.append(pin, unlock)
  const msg = element('p', { className: 'msg' })
  msg.setAttribute('role', 'alert')
  box.append(element('h1', { textContent: s.title }), element('p', { className: 'sub', textContent: s.subtitle }), form)

  let busy = false
  const show = (result: AppLockResult): void => {
    if (result.ok) return
    if (result.error === 'cooldown') {
      msg.textContent = s.cooldown.replace('{seconds}', String(Math.ceil((result.retryAfterMs ?? 0) / 1000)))
    } else if (result.error === 'system-failed' || result.error === 'system-unavailable') {
      msg.textContent = s.systemFailed
    } else {
      msg.textContent = s.wrongPin
    }
  }
  const run = async (attempt: () => Promise<AppLockResult>): Promise<void> => {
    if (busy) return
    busy = true
    unlock.disabled = true
    try {
      show(await attempt())
    } finally {
      busy = false
      unlock.disabled = false
      pin.value = ''
      pin.focus()
    }
  }

  form.addEventListener('submit', event => {
    event.preventDefault()
    if (pin.value) void run(() => bridge.unlockWithPin(pin.value))
  })
  pin.addEventListener('input', () => {
    pin.value = pin.value.replace(/\D/g, '')
    msg.textContent = ''
  })

  const offerSystem = init.systemUnlockAvailable && init.preferSystem
  if (offerSystem) {
    const system = element('button', { type: 'button', textContent: s.unlockWithSystem })
    system.addEventListener('click', () => void run(() => bridge.unlockWithSystem()))
    box.append(system)
  }
  box.append(msg)
  if (offerSystem) box.append(element('p', { className: 'hint', textContent: s.forgotPin }))
  root.replaceChildren(box)
  pin.focus()
}

const bridge = (window as unknown as { navideAppLock?: AppLockScreenBridge }).navideAppLock
if (bridge) {
  document.head.append(element('style', { textContent: STYLE }))
  const root = document.getElementById('app') ?? document.body
  root.replaceChildren()
  void bridge.init().then(init => mountAppLockScreen(root, bridge, init))
}
