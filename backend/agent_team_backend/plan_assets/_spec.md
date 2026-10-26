<!-- provisioned by Navide, spec-version: 2 -->
# Plan Document Spec (v2)

Rules for agent-authored plan documents. Navide is the browser; this file is
the contract. Read once, then copy `_template.html` to start a plan.

## Two carriers, one model

A plan carries the same fields (`name`, `overview`, `stage`, `approvedAt`,
`archivedAt`, `todos`, `reviewNotes`, `executions`) and gets the same features (stage
lifecycle, approval gate, review notes, section edit, dispatch, history) in
either carrier — the app reads/writes both through one store:

- **HTML** — a `<script type="application/json" id="plan-meta">` block (below).
  Body is HTML, rendered in a sandboxed iframe. Preferred for new plans.
- **Markdown** — a `.plan.md` file whose YAML frontmatter carries the same
  fields; body is markdown `## sections`. Legacy `.cursor/plans/*.plan.md` and
  new `.agent-team/plans/*.plan.md` both work; a file with no `stage` defaults
  to `done` if every todo is done, else `draft` (written back only when you
  act on it — legacy files stay byte-identical until then).

## Directory & naming

- Location: `.agent-team/plans/`
- Filename: `<kebab-slug>_<6-hex>.html` (HTML) or `<kebab-slug>.plan.md` (markdown)
- Files starting with `_` are infrastructure (spec, template) — viewers must
  not list them as plans.
- Legacy `.cursor/plans/*.plan.md` remain readable; don't create new ones there.

## The one hard rule: the `plan-meta` block

Every plan HTML must contain exactly one machine-readable JSON island:

```html
<script type="application/json" id="plan-meta">
{
  "schemaVersion": 1,
  "name": "Human Readable Title",
  "overview": "One-sentence purpose.",
  "stage": "in-review",
  "approvedAt": null,
  "todos": [
    { "id": "phase-a", "content": "What this phase delivers", "status": "pending" }
  ],
  "reviewNotes": [
    { "id": "n1", "author": "user", "text": "…", "resolved": false, "reply": "" }
  ]
}
</script>
```

Field rules:

- `schemaVersion`: literal `1`.
- `stage`: `draft | in-review | approved | in-progress | done | abandoned`.
- `approvedAt`: ISO-8601 string, set when stage becomes `approved`; else `null`.
- `archivedAt` (optional): ISO-8601 string, set when the document is archived.
  Archiving is *not* a stage — it answers "do I still want to see this in the
  list", while `stage` answers "where is this in its lifecycle". The Plans pane
  shows archived documents in their own section and its "Archive all done"
  button stamps every `done` document that has none. Absent or `null` means not
  archived.
- `todos[].status`: `pending | in-progress | done | skipped`. No other values.
- `todos[].owner` (optional): `user` when only the user can do it — a manual
  verification, a decision, a credential only they hold. Absent means the agent
  will do it, which is the default and is never written out. This is what tells
  a finished document that is waiting on one verification apart from a plan
  nobody has started; the listing counts unfinished user-owned todos so
  "what is waiting on me" can be answered without opening every document.
- `todos[].id`: stable kebab-case; never renumber existing ids.
- `reviewNotes[].author`: `user` or `ai`. `resolved` flips to `true` only after
  the note is addressed; put the response in `reply`.
- `reviewNotes[].anchor` (optional, defaults to `""`): heading text of the
  section the note is anchored to; empty means a document-level note.
- `executions` (optional, absent by default): dispatch log
  `[{ "agent": "<agent-key>", "startedAt": "<ISO-8601>" }]`, appended each
  time the plan is dispatched to a CLI agent for execution.
- Unknown meta fields are preserved on rewrite; never strip fields you do
  not recognize.
- A file without a valid `plan-meta` block still opens in preview but is
  listed as a plain doc (no progress tracking).

## Lifecycle & approval gate

`draft → in-review → approved → in-progress → done` (or `abandoned`).

- Agents implement code **only when stage is `approved`** (or later). A spoken
  "開始" from the user means: set stage to `approved` + `approvedAt`, then start.
- Approve only when every review note is `resolved: true`.
- On completion set stage to `done`.

## Update discipline (token + safety)

- To change status, stage, or notes: **edit the `plan-meta` block and the
  matching visible markup only.** Never rewrite the whole file. Locate the
  block with a text search instead of reading the whole file.
- Keep visible markup in sync with meta: the stage badge (`class="pill <stage>"`)
  and each todo's `data-status` / pill must mirror the JSON.
- The `plan-meta` block is authoritative. App-side writes (approve, review
  notes) touch only the block, so in-document markup may briefly lag; agents
  re-sync the visible markup on their next edit.

## Document rules

- Self-contained: no external scripts, styles, fonts, or images (preview runs
  in a CSP sandbox: `default-src 'none'`, `img-src data:`, `font-src data:`).
  Embed every image as a `data:` URI (base64 or inline SVG) — a `file:`,
  relative or `http(s):` image URL renders as a broken image. No executable
  JavaScript — presentation only; the JSON island is data, not code.
- Theme-aware: keep the template's CSS token structure
  (`prefers-color-scheme` + `:root[data-theme=…]` overrides).
- Wide content (tables, code, diagrams) sits in its own `overflow-x: auto`
  container.
- Click-to-enlarge images: use the template's `.zoom` CSS `:target` lightbox
  (no JavaScript). The open overlay must be `position: fixed; inset: 0;
  overflow: auto`, and no ancestor of it may set `transform`, `filter`,
  `contain` or `will-change` — any of them makes that ancestor the containing
  block for `fixed`, so the overlay covers the ancestor instead of the
  viewport and the image lands off-screen. Center a wide block with margins,
  not `translateX(-50%)`. Size the enlarged image by width
  (`max-width: min(96vw, 1600px); height: auto; max-height: none`) so a tall
  screenshot stays readable and scrolls inside the overlay instead of being
  shrunk to the viewport height; the × close link is `position: fixed`.
- Standard sections, in order: header (name / overview / stage badge), Goals,
  Phases (with todos), Risks, Validation, Review Notes.
- Content language follows the user's working language (currently 繁體中文);
  code identifiers, paths, and commands stay in their original form.

## External snapshots (e.g. claude.ai artifacts)

The in-repo file is always the single source of truth. Never publish plans
to an external sharing surface by default. Exception — explicit share request
from the user: publish the same file unchanged as a snapshot (the `plan-meta`
JSON island is invisible in any browser), and note in the snapshot that the
canonical copy lives in `.agent-team/plans/`. Never edit the external copy
directly.

## Size guidance

Aim for 300–600 lines of prose. If a plan outgrows that, split it into
multiple plans rather than growing one file.

There is **no size limit** on a plan document: every file in a plan directory
is listed in the Plan view and by `plan_list`, opens in full, and can be updated
(stage, todos, notes, review notes) however large it is — a report with embedded
screenshots can be several MB. Large files are read and written in pages, and
listing reads each file only up to the end of its `plan-meta` block, so keep
that block at the top of the file (the template does): an island further down
still works, but every listing reads the file up to it, and a large file with no
`plan-meta` at all is read in full (once, linearly) on every listing. What still scales with
size:

- **Opening** loads the whole file into the preview, so a multi-MB report takes
  a moment; prefer compressing screenshots (WebP/JPEG) before embedding.
- **Updates** rewrite the whole file (staged, then swapped in atomically), so
  updating a multi-MB plan costs proportionally; keep bulky embedded images in
  a separate read-only report if the plan is edited often.
- **`plan_list`** returns every entry with `rel_path`, `name`, `stage`,
  `overview`, `todos`, `mtime`. When a workspace has so many plans that the full
  list would exceed one 1 MiB backend message (roughly 700 KB of listing), each
  entry's `meta` is dropped to null and everything above is kept, so nothing is
  ever left out. The Plans view pages the list instead; each paged entry's
  `meta` carries the fields the list shows (name, stage, overview, archivedAt,
  todos with their owner) but not `reviewNotes`, which are read with the
  document. An entry too big for one page arrives with `meta` null and keeps
  its `todos` counts, including `awaiting_user`.
- A document whose `plan-meta` is missing or broken is still listed, marked
  "Needs attention" with the reason (`kind: "document"`, `reason`), and can be
  opened; fix the block to make it a plan again. A file that cannot be read at
  all is listed with `kind: "unreadable"` and the reason.
