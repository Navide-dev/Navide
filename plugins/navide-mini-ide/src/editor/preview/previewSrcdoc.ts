// The iframe's empty sandbox already blocks scripts and forms; this CSP also
// refuses every network load, so previewed HTML (a .docx conversion, a
// notebook output) cannot fetch a tracking pixel or any other remote resource.
// A meta refresh is left to that sandbox: without allow-scripts Chromium
// refuses to follow one.
const PREVIEW_CSP_META =
  '<meta http-equiv="Content-Security-Policy" content="' +
  "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:" +
  '">'

/** The srcdoc for a sandboxed preview frame of untrusted HTML. */
export function previewSrcdoc(html: string): string {
  return PREVIEW_CSP_META + html
}
