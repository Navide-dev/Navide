// Content-Security-Policy for the main window only.
//
// Why a <meta> added at runtime rather than a header or a static tag:
// - The packaged app loads index.html over file://, which never passes through
//   session.webRequest.onHeadersReceived, so a header would only cover dev.
// - index.html is shared by every `?window=` app (editor, plans, token-monitor)
//   and srcdoc frames inherit their parent's policy. The plan preview runs a
//   nonce'd script inside such a frame, so a static tag would break the Plans
//   and Editor windows. Inserting the tag here scopes it to the main shell.
// Chromium enforces a meta policy from the moment it is inserted, so it is
// added before the main root (App.vue and everything it lazy-loads) is fetched.
//
// The policy is deliberately broad (security fixes must not remove features):
// it covers every source the main window loads today —
// - the backend on 127.0.0.1 (dynamic port; ws + http, /fs/raw media and fonts),
// - remote images (Marketplace icons, https://dl.navide.dev/help/ screenshots,
//   markdown previews) and https fetches,
// - plugin <webview>s (file:, navide-plugin-frame:, dev-server http) and file
//   previews in iframes (127.0.0.1, srcdoc),
// - blob: workers and the voice AudioWorklet (script-src blob:),
// - inline styles (Vue style bindings, the pre-splash) and data: fonts/images,
// - the dev server and its HMR socket (covered by 'self' plus localhost).
// What it does block: scripts from anywhere but the app itself and blob:,
// eval, plugins (<object>/<embed>), and <base> rewrites.
export const MAIN_WINDOW_CSP = [
  "default-src 'self'",
  "script-src 'self' blob:",
  "style-src 'self' 'unsafe-inline' https: http://127.0.0.1:* http://localhost:*",
  "img-src * 'self' data: blob: file: navide-plugin-frame:",
  "media-src * 'self' data: blob: file:",
  "font-src 'self' data: https: http://127.0.0.1:* http://localhost:*",
  "connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:* http://localhost:* ws://localhost:* https: wss: data: blob:",
  "worker-src 'self' blob: data:",
  "frame-src * 'self' data: blob: about: file: navide-plugin-frame:",
  "object-src 'none'",
  "base-uri 'self'",
].join('; ')

export function installMainWindowCsp(doc: Document = document): void {
  if (doc.querySelector('meta[http-equiv="Content-Security-Policy"]')) return
  const meta = doc.createElement('meta')
  meta.httpEquiv = 'Content-Security-Policy'
  meta.content = MAIN_WINDOW_CSP
  doc.head.appendChild(meta)
}
