/**
 * planRuntime.ts
 *
 * Render-time interactivity layer for `.agent-team/plans/*.html` documents
 * (plan-doc-interactivity Phase B). The plan file on disk stays plain
 * presentational HTML with zero JavaScript; the plan window injects this
 * runtime when building the preview iframe's `srcdoc`
 * (`sandbox="allow-scripts"`, no same-origin).
 *
 * Security model:
 * - Any executable `<script>` the document carries is stripped; only the
 *   `type="application/json"` plan-meta island (data, not code) is kept.
 * - A CSP `<meta>` with a per-render nonce allows only the injected runtime
 *   to execute — inline handlers, `javascript:` URLs, and network access in
 *   the document are blocked.
 * - The runtime binds existing DOM markers only (`li[data-todo-id]`,
 *   section/phase headings); it never evaluates document content.
 * - Frame → host communication is limited to the whitelisted postMessage
 *   events below; the host validates every payload before any disk write.
 *
 * Host-side helpers (outline extraction, message validation) live here too so
 * the protocol has a single home.
 */


/** Frame → host events. Anything else is ignored by the host. */
export const PLAN_RUNTIME_EVENTS = [
  'todo-clicked',
  'section-comment',
  'scroll-pos',
  'open-code',
  'section-edit',
  'section-delete',
  'section-editing',
] as const

/** Upper bound for a section anchor; longer payloads are rejected. */
export const MAX_ANCHOR_LENGTH = 200

/** Upper bound for an inline section-edit HTML payload; longer is rejected. */
export const MAX_SECTION_HTML_LENGTH = 20_000

export interface PlanRuntimeConfig {
  /** Unresolved review-note count per anchor, rendered as heading badges. */
  anchors: Record<string, number>
  /** Localized label for the injected section comment button. */
  commentLabel: string
  /** Localized labels for the inline section edit/delete affordances. */
  editLabel: string
  deleteLabel: string
  saveLabel: string
  cancelLabel: string
  /** Scroll offset restored after a reload triggered by a meta write. */
  scrollY: number
}

export interface PlanRuntimeInit extends PlanRuntimeConfig {
  /** Document token bound to this preview generation. Required. */
  documentToken: string
}

export type PlanRuntimeMessage =
  | { type: 'todo-clicked'; todoId: string; alt: boolean }
  | { type: 'section-comment'; anchor: string }
  | { type: 'scroll-pos'; y: number }
  | { type: 'open-code'; path: string; line: number }
  | { type: 'section-edit'; anchor: string; html: string }
  | { type: 'section-delete'; anchor: string }
  | { type: 'section-editing'; active: boolean }

// Anchors are the leading text of section `<h2>`s and `.phase-head`s (text up
// to the first child element), whitespace-collapsed — the runtime computes the
// same value from the live DOM, so host and frame agree on anchor identity.
const OUTLINE_RE =
  /<h2\b[^>]*>([^<]+)|<div\b[^>]*class=["'][^"']*\bphase-head\b[^"']*["'][^>]*>([^<]+)/gi

/**
 * Extract the outline anchors (document order, deduplicated) from raw plan
 * HTML. Doubles as the whitelist of valid `section-comment` anchors.
 */
export function extractPlanOutline(content: string): string[] {
  const anchors: string[] = []
  for (const match of content.matchAll(OUTLINE_RE)) {
    const text = (match[1] ?? match[2] ?? '').replace(/\s+/g, ' ').trim()
    if (text && text.length <= MAX_ANCHOR_LENGTH && !anchors.includes(text)) anchors.push(text)
  }
  return anchors
}

/** Apply confirmed todo writes without replacing the iframe document. */
export function buildTodoStatusRuntime(documentToken: string, todoIds: string[]): string {
  return `;(function () {
    var documentToken = ${JSON.stringify(documentToken).replace(/</g, '\\u003c')};
    var validTodoIds = ${JSON.stringify(todoIds).replace(/</g, '\\u003c')};
    window.addEventListener('message', function (event) {
      if (event.source !== window.parent) return;
      var message = event.data;
      if (!message || message.type !== 'todo-status-updated' || message.documentToken !== documentToken) return;
      if (validTodoIds.indexOf(message.todoId) === -1 || ['pending', 'in-progress', 'done', 'skipped'].indexOf(message.status) === -1) return;
      var todo = document.querySelector('[data-todo-id="' + CSS.escape(message.todoId) + '"]');
      if (!todo) return;
      todo.setAttribute('data-status', message.status);
      todo.setAttribute('data-todo-status', message.status);
      todo.classList.toggle('is-complete', message.status === 'done');
      var label = todo.querySelector('.st');
      if (label) label.textContent = message.status;
      var checkbox = todo.querySelector('input[type="checkbox"]');
      if (checkbox) checkbox.checked = message.status === 'done';
      if (checkbox) checkbox.setAttribute('aria-checked', message.status === 'done' ? 'true' : 'false');
    });
  })();`
}

export interface PlanRuntimeHostHooks {
  /** The plan preview iframe's contentWindow; messages from any other source are ignored. */
  getSourceWindow: () => Window | null | undefined
  /** The current expected document token; messages with mismatched/missing token are rejected. */
  getDocumentToken: () => string
  /** Todo ids present in the parsed plan-meta; unknown ids are rejected. */
  getTodoIds: () => readonly string[]
  /** Valid outline anchors; unknown anchors are rejected. */
  getAnchors: () => readonly string[]
  onTodoClicked: (todoId: string, alt: boolean) => void
  onSectionComment: (anchor: string) => void
  onScrollPos: (y: number) => void
  onOpenCode: (path: string, line: number) => void
  /** Inline edit submitted for an anchored section; `html` is raw and must be sanitized host-side. */
  onSectionEdit: (anchor: string, html: string) => void
  /** Inline delete requested for an anchored section. */
  onSectionDelete: (anchor: string) => void
  /** Frame entered/left inline section editing (drives ESC overlay priority). */
  onSectionEditing: (active: boolean) => void
}

/** Upper bounds for open-code payloads; anything beyond is rejected. */
export const MAX_OPEN_CODE_PATH_LENGTH = 512
export const MAX_OPEN_CODE_LINE = 1_000_000

const NONCE_PATTERN = /^[0-9a-f]{32}$/

function generateSecureHex(bytesLength = 16): string {
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const bytes = new Uint8Array(bytesLength)
    crypto.getRandomValues(bytes)
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  }
  return Array.from({ length: bytesLength * 2 }, () => Math.floor(Math.random() * 16).toString(16)).join('')
}

export interface PlanMessageValidationOptions {
  getSourceWindow: () => Window | null | undefined
  getDocumentToken: () => string
}

export function validatePlanMessageEvent(
  event: MessageEvent,
  options: PlanMessageValidationOptions,
): Record<string, unknown> | null {
  const source = options.getSourceWindow()
  if (!source || event.source !== source) return null

  const data: unknown = event.data
  if (typeof data !== 'object' || data === null) return null

  const msg = data as Record<string, unknown>

  // Strictly reject messages carrying the legacy 'token' field, even if documentToken is also present
  if (Object.prototype.hasOwnProperty.call(msg, 'token')) return null

  const expectedToken = options.getDocumentToken()
  if (!expectedToken || typeof expectedToken !== 'string') return null

  if (typeof msg.documentToken !== 'string' || !msg.documentToken) return null
  if (msg.documentToken !== expectedToken) return null

  return msg
}

export interface SafeTodoClickHandlerOptions extends PlanMessageValidationOptions {
  getValidTodoIds: () => readonly string[]
  onTodoClicked: (todoId: string, alt: boolean) => void
}

export function createSafeTodoClickHandler(
  options: SafeTodoClickHandlerOptions,
): (event: MessageEvent) => boolean {
  return (event: MessageEvent): boolean => {
    const msg = validatePlanMessageEvent(event, options)
    if (!msg) return false

    if (msg.type !== 'todo-clicked') return false

    const todoId = msg.todoId
    if (typeof todoId !== 'string' || !options.getValidTodoIds().includes(todoId)) {
      return false
    }

    options.onTodoClicked(todoId, msg.alt === true)
    return true
  }
}

/**
 * Build the host's `message` listener. Every event is validated against the
 * whitelist and its payload schema before the matching hook runs — malformed
 * or non-whitelisted messages are silently dropped, so nothing reaches the
 * meta write path.
 */
export function createPlanRuntimeMessageHandler(
  hooks: PlanRuntimeHostHooks,
): (event: MessageEvent) => void {
  const handleTodoClick = createSafeTodoClickHandler({
    getSourceWindow: hooks.getSourceWindow,
    getDocumentToken: hooks.getDocumentToken,
    getValidTodoIds: hooks.getTodoIds,
    onTodoClicked: (todoId, alt) => hooks.onTodoClicked(todoId, alt),
  })

  return (event) => {
    if (handleTodoClick(event)) return

    const msg = validatePlanMessageEvent(event, {
      getSourceWindow: hooks.getSourceWindow,
      getDocumentToken: hooks.getDocumentToken,
    })
    if (!msg) return

    switch (msg.type) {
      case 'section-comment': {
        const anchor = msg.anchor
        if (typeof anchor !== 'string' || anchor.length === 0 || anchor.length > MAX_ANCHOR_LENGTH)
          return
        if (!hooks.getAnchors().includes(anchor)) return
        hooks.onSectionComment(anchor)
        return
      }
      case 'scroll-pos': {
        const y = msg.y
        if (typeof y !== 'number' || !Number.isFinite(y) || y < 0) return
        hooks.onScrollPos(y)
        return
      }
      case 'open-code': {
        // Workspace-relative path only: no absolute paths, no backslashes, no
        // `..` traversal, no drive/scheme colons.
        const path = msg.path
        const line = msg.line
        if (typeof path !== 'string' || path.length === 0 || path.length > MAX_OPEN_CODE_PATH_LENGTH)
          return
        if (path.startsWith('/') || path.includes('\\') || path.includes(':')) return
        if (path.split('/').includes('..')) return
        if (typeof line !== 'number' || !Number.isInteger(line) || line < 1) return
        if (line > MAX_OPEN_CODE_LINE) return
        hooks.onOpenCode(path, line)
        return
      }
      case 'section-edit': {
        const anchor = msg.anchor
        const html = msg.html
        if (typeof anchor !== 'string' || anchor.length === 0 || anchor.length > MAX_ANCHOR_LENGTH)
          return
        if (!hooks.getAnchors().includes(anchor)) return
        if (typeof html !== 'string' || html.length > MAX_SECTION_HTML_LENGTH) return
        hooks.onSectionEdit(anchor, html)
        return
      }
      case 'section-delete': {
        const anchor = msg.anchor
        if (typeof anchor !== 'string' || anchor.length === 0 || anchor.length > MAX_ANCHOR_LENGTH)
          return
        if (!hooks.getAnchors().includes(anchor)) return
        hooks.onSectionDelete(anchor)
        return
      }
      case 'section-editing': {
        if (typeof msg.active !== 'boolean') return
        hooks.onSectionEditing(msg.active)
        return
      }
      default:
        return // non-whitelisted event — ignored
    }
  }
}

// ── Host-side HTML sanitizer for inline section edits ──────────────────────
// The frame is untrusted: its section-edit payload is parsed in a detached
// document (no script execution, no network) and rebuilt from a tag/attribute
// whitelist. Disallowed elements are unwrapped (children kept); script/style
// are dropped whole; only `href` (non-javascript:/data:) survives on `<a>`.
const SECTION_ALLOWED_TAGS = new Set([
  'p', 'ul', 'ol', 'li', 'strong', 'em', 'code', 'pre', 'a', 'br', 'h3',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
])

function isSafeHref(href: string): boolean {
  // Browsers strip embedded tab/newline and leading control chars from a URL
  // before resolving its scheme, so `java\tscript:` and `\x01javascript:` run
  // as javascript:. Strip all C0 controls + space for the scheme test only —
  // the stored href keeps its original form.
  const v = href.replace(/[\u0000-\u0020]/g, '').toLowerCase()
  return !v.startsWith('javascript:') && !v.startsWith('data:') && !v.startsWith('vbscript:')
}

function sanitizeInto(src: Node, dst: Node, doc: Document): void {
  src.childNodes.forEach((node) => {
    if (node.nodeType === 3 /* text */) {
      dst.appendChild(doc.createTextNode(node.nodeValue ?? ''))
      return
    }
    if (node.nodeType !== 1 /* element */) return // drop comments / others
    const el = node as Element
    const tag = el.tagName.toLowerCase()
    if (tag === 'script' || tag === 'style') return // drop entirely, no recurse
    if (!SECTION_ALLOWED_TAGS.has(tag)) {
      sanitizeInto(el, dst, doc) // unwrap: keep sanitized children only
      return
    }
    const clean = doc.createElement(tag)
    if (tag === 'a') {
      const href = el.getAttribute('href') ?? ''
      if (href && isSafeHref(href)) clean.setAttribute('href', href)
    }
    sanitizeInto(el, clean, doc)
    dst.appendChild(clean)
  })
}

/**
 * Sanitize untrusted section-edit HTML from the frame against the whitelist.
 * Runs in the host (renderer) using a detached document — never in the iframe.
 */
export function sanitizePlanSectionHtml(html: string): string {
  const doc = document.implementation.createHTMLDocument('')
  const container = doc.createElement('div')
  container.innerHTML = html
  const out = doc.createElement('div')
  sanitizeInto(container, out, doc)
  return out.innerHTML
}

/**
 * Build the runtime script source injected into the plan document. Pure DOM
 * binding over existing markers; posts only whitelisted events to the host.
 */
export function buildPlanRuntimeScript(init: PlanRuntimeInit): string {
  // JSON-escape "<" so init data (anchor text comes from the document) can
  // never form a "</script>" sequence that terminates the runtime block.
  const initJson = JSON.stringify(init).replace(/</g, '\\u003c')
  return `(function () {
  'use strict';
  var INIT = ${initJson};
  function post(msg) {
    if (INIT.documentToken) {
      msg.documentToken = INIT.documentToken;
    }
    parent.postMessage(msg, '*');
  }

  var style = document.createElement('style');
  style.textContent =
    'li[data-todo-id]{cursor:pointer}' +
    'li[data-todo-id]:hover{background:rgba(125,125,125,0.09)}' +
    '.plan-rt-badge{display:inline-block;margin-left:8px;padding:0 8px;border-radius:99px;' +
    'font-size:11px;font-weight:700;line-height:1.7;vertical-align:2px;' +
    'background:var(--accent-soft,#E8EDFB);color:var(--accent,#3B5BDB)}' +
    '.plan-rt-comment{position:absolute;z-index:9;padding:2px 10px;border-radius:99px;' +
    'border:1px solid var(--accent,#3B5BDB);background:var(--surface,#FFFFFF);' +
    'color:var(--accent,#3B5BDB);font-size:12px;cursor:pointer}' +
    '.plan-rt-comment:hover{background:var(--accent-soft,#E8EDFB)}' +
    '.plan-rt-secbar{position:absolute;z-index:9;display:flex;gap:6px}' +
    '.plan-rt-secbar button{padding:2px 10px;border-radius:99px;' +
    'border:1px solid var(--line,#DDE1E9);background:var(--surface,#FFFFFF);' +
    'color:var(--ink,#1D2530);font-size:12px;cursor:pointer;font-family:inherit}' +
    '.plan-rt-secbar button:hover{background:var(--surface-2,#EDEFF4)}' +
    '.plan-rt-secdel{color:var(--danger,#C0392B) !important;border-color:var(--danger,#C0392B) !important}' +
    // Layout overrides for template documents: long code wraps inside table
    // cells instead of being clipped, and the column uses the frame width.
    '.tablewrap td,.tablewrap td code{overflow-wrap:anywhere}' +
    '.wrap{max-width:1180px}' +
    '.wrap td ul,.wrap td p{max-width:none}';
  (document.head || document.documentElement).appendChild(style);

  // Leading text (up to the first child element), whitespace-collapsed —
  // matches the host's extractPlanOutline() regex semantics.
  function leadText(el) {
    var s = '';
    for (var n = el.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 1) break;
      if (n.nodeType === 3) s += n.data;
    }
    return s.replace(/\\s+/g, ' ').trim();
  }

  var targets = [];
  var seen = {};
  function addTarget(head, region, kind, body) {
    var anchor = leadText(head);
    if (!anchor || seen[anchor] === true) return;
    seen[anchor] = true;
    targets.push({ anchor: anchor, head: head, region: region, kind: kind, body: body || region });
  }
  var h2s = document.querySelectorAll('h2');
  for (var i = 0; i < h2s.length; i++) {
    var head = h2s[i];
    var section = head.closest('section');
    if (section) {
      addTarget(head, section, 'section', null);
      continue;
    }
    // A preview-only wrapper gives a heading's sibling prose an editable
    // region. Only its body is serialized back into the original document.
    var region = document.createElement('div');
    region.className = 'plan-rt-section';
    var body = document.createElement('div');
    head.parentNode.insertBefore(region, head);
    var next = head.nextSibling;
    region.appendChild(head);
    region.appendChild(body);
    while (next && !(next.nodeType === 1 && /^H[12]$/.test(next.tagName))) {
      var following = next.nextSibling;
      body.appendChild(next);
      next = following;
    }
    addTarget(head, region, 'heading', body);
  }
  var phaseHeads = document.querySelectorAll('.phase-head');
  for (var j = 0; j < phaseHeads.length; j++) {
    var phase = phaseHeads[j].closest('.phase') || phaseHeads[j];
    addTarget(phaseHeads[j], phase, 'phase', phase.querySelector('.phase-body') || phase);
  }

  // Metadata-only updates keep the current iframe and any inline edit alive.
  function updateAnchorBadges(anchors) {
    for (var k = 0; k < targets.length; k++) {
      var head = targets[k].head;
      var badge = head.querySelector('.plan-rt-badge');
      var count = anchors[targets[k].anchor];
      if (typeof count === 'number' && Number.isSafeInteger(count) && count > 0) {
        if (!badge) {
          badge = document.createElement('span');
          badge.className = 'plan-rt-badge';
          head.appendChild(badge);
        }
        badge.textContent = String(count);
      } else if (badge) {
        badge.remove();
      }
    }
  }
  updateAnchorBadges(INIT.anchors);

  // Floating comment button shown while hovering a section/phase. Hiding is
  // delayed so moving the pointer onto the button (a body child overlapping
  // the region) does not dismiss it before the click lands.
  var btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'plan-rt-comment';
  btn.textContent = INIT.commentLabel;
  btn.style.display = 'none';
  document.body.appendChild(btn);
  var currentAnchor = '';
  var hideTimer = null;
  function cancelHide() { if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; } }
  function scheduleHide() {
    cancelHide();
    hideTimer = setTimeout(function () { btn.style.display = 'none'; }, 250);
  }
  btn.addEventListener('mouseenter', cancelHide);
  btn.addEventListener('mouseleave', scheduleHide);
  btn.addEventListener('click', function () {
    if (currentAnchor) post({ type: 'section-comment', anchor: currentAnchor });
  });
  targets.forEach(function (t) {
    t.region.addEventListener('mouseenter', function () {
      cancelHide();
      currentAnchor = t.anchor;
      btn.style.display = 'block';
      var rect = t.region.getBoundingClientRect();
      btn.style.top = (rect.top + window.scrollY + 6) + 'px';
      btn.style.left = Math.max(0, rect.right + window.scrollX - btn.offsetWidth - 6) + 'px';
    });
    t.region.addEventListener('mouseleave', scheduleHide);
  });

  // In-document todo rows: click cycles, right-click toggles skip — the host
  // routes both through the review toolbar's existing write path.
  var todoRows = document.querySelectorAll('li[data-todo-id]');
  todoRows.forEach(function (row) {
    var todoId = row.getAttribute('data-todo-id') || '';
    if (!todoId) return;
    row.addEventListener('click', function () {
      post({ type: 'todo-clicked', todoId: todoId, alt: false });
    });
    row.addEventListener('contextmenu', function (ev) {
      ev.preventDefault();
      post({ type: 'todo-clicked', todoId: todoId, alt: true });
    });
  });

  // Same-document "#id" links (in-page jumps, CSS :target lightboxes). In an
  // about:srcdoc frame "#id" resolves against the host's URL, so the default
  // click is a cross-document navigation the sandbox blocks and nothing
  // happens; set the hash on the frame's own URL instead.
  document.addEventListener('click', function (ev) {
    var link = ev.target && ev.target.closest ? ev.target.closest('a[href^="#"]') : null;
    if (!link || ev.defaultPrevented) return;
    ev.preventDefault();
    location.hash = link.getAttribute('href').slice(1);
  });

  // file:line references in <code> elements become clickable and ask the
  // host to open the editor at that line. Workspace-relative paths only.
  // Extracted so a cancelled section edit can rebind links in the restored
  // subtree (contenteditable restore replaces the original bound elements).
  var CODE_REF_RE = /^([A-Za-z0-9_\\-./]+\\.[A-Za-z0-9]+):(\\d{1,7})$/;
  function bindCodeLinks(root) {
    var codeEls = root.querySelectorAll('code');
    codeEls.forEach(function (el) {
      if (el.getAttribute('data-rt-code') === '1') return;
      var m = CODE_REF_RE.exec((el.textContent || '').trim());
      if (!m) return;
      var path = m[1];
      if (path.charAt(0) === '/' || path.indexOf('..') !== -1) return;
      var line = parseInt(m[2], 10);
      el.setAttribute('data-rt-code', '1');
      el.style.cursor = 'pointer';
      el.style.textDecoration = 'underline';
      el.addEventListener('click', function () {
        post({ type: 'open-code', path: path, line: line });
      });
    });
  }
  bindCodeLinks(document);

  // In-document section editing: an inline Edit/Delete bar floats over each
  // editable region (an outline target that carries no todo list — todos are
  // managed by the toolbar and must never pass through the host sanitizer).
  // Edit turns the region body contenteditable (its heading stays locked);
  // Save posts the raw body HTML for host sanitization + write; Delete asks
  // the host (which confirms) to remove the whole region. The document on
  // disk stays plain HTML — the frame never writes.
  var secbar = document.createElement('div');
  secbar.className = 'plan-rt-secbar';
  secbar.style.display = 'none';
  document.body.appendChild(secbar);
  var editBtn = document.createElement('button');
  editBtn.type = 'button';
  editBtn.textContent = INIT.editLabel;
  var delBtn = document.createElement('button');
  delBtn.type = 'button';
  delBtn.className = 'plan-rt-secdel';
  delBtn.textContent = INIT.deleteLabel;
  var saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.textContent = INIT.saveLabel;
  var cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.textContent = INIT.cancelLabel;
  var editing = null;
  var secHideTimer = null;
  function secCancelHide() { if (secHideTimer) { clearTimeout(secHideTimer); secHideTimer = null; } }
  function secScheduleHide() {
    secCancelHide();
    if (editing) return;
    secHideTimer = setTimeout(function () { if (!editing) secbar.style.display = 'none'; }, 250);
  }
  function placeSecbar(region) {
    var rect = region.getBoundingClientRect();
    secbar.style.top = (rect.top + window.scrollY + 6) + 'px';
    secbar.style.left = (rect.left + window.scrollX + 6) + 'px';
  }
  function setSecbar() {
    secbar.innerHTML = '';
    for (var a = 0; a < arguments.length; a++) secbar.appendChild(arguments[a]);
  }
  function editableEl(t) { return t.body; }
  function serializeBody(t) {
    var container = editableEl(t);
    var html = '';
    var kids = container.childNodes;
    for (var i = 0; i < kids.length; i++) {
      var n = kids[i];
      if (n === t.head) continue;
      if (n.nodeType === 1) {
        if (n.classList && (n.classList.contains('plan-rt-secbar') ||
          n.classList.contains('plan-rt-comment') || n.classList.contains('todos'))) continue;
        html += n.outerHTML;
      } else if (n.nodeType === 3) {
        html += n.data;
      }
    }
    return html;
  }
  function enterEdit(t) {
    if (editing) return;
    editing = t;
    var el = editableEl(t);
    t._snap = el.innerHTML;
    el.setAttribute('contenteditable', 'true');
    el.style.outline = '2px solid var(--accent,#3B5BDB)';
    if (t.head !== el) t.head.setAttribute('contenteditable', 'false');
    setSecbar(saveBtn, cancelBtn);
    placeSecbar(t.region);
    secbar.style.display = 'flex';
    secCancelHide();
    btn.style.display = 'none';
    post({ type: 'section-editing', active: true });
    el.focus();
  }
  function exitEdit(t) {
    var el = editableEl(t);
    el.removeAttribute('contenteditable');
    el.style.outline = '';
    if (t.head !== el) t.head.removeAttribute('contenteditable');
    editing = null;
    secbar.style.display = 'none';
    post({ type: 'section-editing', active: false });
  }
  function saveEdit(t) {
    post({ type: 'section-edit', anchor: t.anchor, html: serializeBody(t) });
    exitEdit(t);
  }
  function cancelEdit(t) {
    editableEl(t).innerHTML = t._snap;
    bindCodeLinks(editableEl(t));
    exitEdit(t);
  }
  editBtn.addEventListener('click', function () { if (secbar._t) enterEdit(secbar._t); });
  delBtn.addEventListener('click', function () {
    if (secbar._t) post({ type: 'section-delete', anchor: secbar._t.anchor });
  });
  saveBtn.addEventListener('click', function () { if (editing) saveEdit(editing); });
  cancelBtn.addEventListener('click', function () { if (editing) cancelEdit(editing); });
  secbar.addEventListener('mouseenter', secCancelHide);
  secbar.addEventListener('mouseleave', secScheduleHide);
  targets.forEach(function (t) {
    // Editable = outline region with no todo list (prose section / prose phase).
    if (editableEl(t).querySelector && editableEl(t).querySelector('ul.todos')) return;
    if (t.region.querySelector && t.region.querySelector('ul.todos')) return;
    t.region.addEventListener('mouseenter', function () {
      if (editing) return;
      secCancelHide();
      secbar._t = t;
      setSecbar(editBtn, delBtn);
      placeSecbar(t.region);
      secbar.style.display = 'flex';
    });
    t.region.addEventListener('mouseleave', secScheduleHide);
  });

  // Throttled scroll reporting so the host can restore position after the
  // iframe reloads on a meta write.
  var scrollTimer = null;
  window.addEventListener('scroll', function () {
    if (scrollTimer) return;
    scrollTimer = setTimeout(function () {
      scrollTimer = null;
      post({ type: 'scroll-pos', y: window.scrollY });
    }, 250);
  }, { passive: true });
  if (INIT.scrollY > 0) window.scrollTo(0, INIT.scrollY);

  // Escape while editing cancels the inline edit (focus is inside the frame,
  // so the host's window-level ESC never sees it); other ESC keys pass through.
  window.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape' && editing) {
      ev.preventDefault();
      ev.stopPropagation();
      cancelEdit(editing);
    }
  });

  // Host -> frame inbound messages: outline navigation, and cancel-edit (the
  // host's ESC priority layer when focus is outside the frame).
  window.addEventListener('message', function (ev) {
    var d = ev.data;
    if (!d) return;
    if (d.type === 'review-note-anchors-updated') {
      if (ev.source !== parent || d.documentToken !== INIT.documentToken) return;
      if (!d.anchors || typeof d.anchors !== 'object' || Array.isArray(d.anchors)) return;
      updateAnchorBadges(d.anchors);
      return;
    }
    if (d.type === 'cancel-edit') {
      if (editing) cancelEdit(editing);
      return;
    }
    if (d.type !== 'scroll-to' || typeof d.anchor !== 'string') return;
    for (var m = 0; m < targets.length; m++) {
      if (targets[m].anchor === d.anchor) {
        targets[m].head.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
      }
    }
  });
})();`
}

function stripExecutableScripts(content: string): string {
  return content.replace(/<script\b(?![^>]*\btype=["']application\/json["'])[\s\S]*?<\/script\s*>/gi, '')
}

function buildPlanCspMeta(nonce: string): string {
  return (
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; ' +
    `style-src 'unsafe-inline'; img-src data:; font-src data:; script-src 'nonce-${nonce}'">`
  )
}

/**
 * Build the full srcdoc for the plan preview iframe: strip executable
 * document scripts, inject a nonce'd CSP meta (only the runtime may execute;
 * inline styles and data: images stay allowed for self-contained docs), and
 * append the runtime script before `</body>`.
 *
 * @deprecated Unused copy that predates the Plans CSP fix (#462). Plans
 * renders through `preparePlanDocHtml` in `../planSecurity`; import that one,
 * never this.
 */
export function preparePlanDocHtml(
  content: string,
  config?: PlanRuntimeConfig,
  overrides?: { nonce?: string },
): { html: string; nonce: string; documentToken: string } {
  let nonce: string
  if (overrides?.nonce !== undefined) {
    if (!NONCE_PATTERN.test(overrides.nonce)) {
      throw new Error(`Invalid plan security nonce: expected 32 lowercase hex characters, got ${overrides.nonce}`)
    }
    nonce = overrides.nonce
  } else {
    nonce = generateSecureHex(16)
  }
  const documentToken = generateSecureHex(16)
  const effectiveConfig: PlanRuntimeConfig = config ?? {
    anchors: {},
    commentLabel: 'Comment',
    editLabel: 'Edit',
    deleteLabel: 'Delete',
    saveLabel: 'Save',
    cancelLabel: 'Cancel',
    scrollY: 0,
  }

  const runtimeScript = buildPlanRuntimeScript({ ...effectiveConfig, documentToken })
  if (runtimeScript.toLowerCase().includes('</script')) {
    throw new Error('trustedRuntimeScript cannot contain closing script tag')
  }

  const cspMeta = buildPlanCspMeta(nonce)
  const sanitizedContent = cspMeta + stripExecutableScripts(content)
  const runtimeTag = `<script nonce="${nonce}">${runtimeScript}</scr` + 'ipt>'

  const bodyClose = sanitizedContent.search(/<\/body>/i)
  const html =
    bodyClose === -1
      ? sanitizedContent + runtimeTag
      : sanitizedContent.slice(0, bodyClose) + runtimeTag + sanitizedContent.slice(bodyClose)

  return { html, nonce, documentToken }
}
