# Import from n8n

Navide can turn a workflow exported from n8n into a new pipeline. The import
is one-way and one-time: Navide builds a pipeline from the workflow, keeps
the (redacted) workflow JSON next to it on this machine, and never writes
back to n8n. An existing pipeline is never overwritten.

## Importing a workflow

1. In n8n, export the workflow (Download, or copy its nodes) to get its JSON.
2. In Navide, open the **Pipeline Manager** and choose **Import from n8n**
   (on the pipeline list, or in a pipeline's ⋯ menu).
3. Paste the JSON, or use **Choose File…**. A workflow file can be at most
   5 MB.
4. Pick the **CLI for agent steps** (Claude by default). An AI Agent
   node picks its own CLI from its model: Anthropic → Claude, OpenAI →
   Codex, Gemini → Gemini.
5. Choose **Preview**. Nothing is written yet. Read the preview (below).
6. Choose **Import**. The preview says how many pipelines the import creates
   (**Importing creates N pipelines**). The new pipeline opens and a message
   says it was imported and how many steps need review; those steps carry a
   review mark in the editor until you check them. A name that is already
   taken gets " (2)", " (3)"…. An import is all or nothing: when one of
   several workflows cannot be stored, none of them is kept.

If an import takes so long that the dialog says it may still finish, press
**Import** again: it opens the pipeline if it was made, and never makes a
copy.

An agent can do the same through the MCP tool `pipeline_import_n8n`, which
defaults to a dry run and returns the same report (see
[External MCP control](external-mcp-control.md)). Imports are refused while
the workspace has a pipeline run in progress.

## Reading the preview

The canvas colors each step by how it was converted:

- **Converted directly** — Navide runs it as the workflow meant: Manual, Chat and
  Execute Workflow triggers, AI Agent clusters (model, memory, tools and
  output parser fold into one step), Wait and send-and-wait approvals
  (gates), IF and Switch (branches), Merge in Append or Choose Branch mode, error outputs and retries,
  and Execute Workflow calling a workflow Navide has (a sub-pipeline, see below).
- **Run by an agent** — HTTP Request, Code, Set, Merge that combines data (by fields, position, all combinations or SQL; the agent follows its merge rule), app nodes (Google
  Sheets, Slack, Gmail…), community nodes and unknown node types or
  versions. A CLI agent does the step from the node's original parameters;
  expressions and Code are passed on verbatim. Results can differ from
  n8n's. Runs of these steps with no branching become one step, so a
  workflow does not open one pane per node.
- **Needs review** — imported, but it needs something Navide does not have yet:
  Schedule, Webhook, Form and app triggers (start the pipeline by hand, or
  schedule it in **Turn Stats ▸ Schedule**),
  Respond to Webhook, Execute Workflow calling a workflow Navide does not
  have, Call n8n Workflow Tool (see below), and steps best left in n8n (see
  below), shown as **Not supported**.

Below the canvas, the report lists every n8n node with what it became and
what to do about it (rows that need review come first; a step that took in
several n8n nodes says how many), every step's full kickoff and every gate's prompt —
the exact text each pane will receive — the credentials to set up, where
secrets were removed, and how many steps need review. None of this blocks
**Import**: it is there so you know before you run.

### Branches, errors, retries and data between steps

- **IF** becomes branch edges `true` / `false`; **Switch** one branch per
  rule (its output name when renamed, else its number) and `default` for
  the fallback output. The step's agent reports the branch it took, the
  way Navide's signal instructions at the end of its kickoff say, and only
  that branch runs; an Append or Choose Branch
  Merge after it runs on the inputs that arrived.
- Any other node with several outputs, such as Compare Datasets: a small
  region becomes one step that follows every output that has items. A region
  too large for that, or holding an agent or approval gate, stays as separate
  steps. Every output then runs, also one n8n would leave without items, so
  that node and the Merge after it show as **Needs review**.
- A node with **On Error → Continue (using error output)** gets an error
  edge: the next step runs only when it fails. A workflow that is its own
  error workflow (Settings → Error Workflow) has its Error Trigger steps
  wired as error edges from every step.
- **Retry On Fail** becomes the step's retry: at most 5 tries in all and
  300000 ms between them. The report marks any node whose n8n settings were
  higher.
- A loop (Loop Over Items, or an IF that leads back to an earlier node) is
  merged into one step that processes the items one by one, or repeats until
  the condition that leaves the loop holds. A Wait inside the loop pauses
  that step between rounds; it is not an approval gate.
- An expression that reads another node, such as `$('Lookup').item.json`,
  gets that step's result as `{{node.<step id>.output}}` in its kickoff, and
  that step is asked to end with its result as JSON.

### Sub-workflows

An **Execute Workflow** node becomes a sub-pipeline node when Navide has the
workflow it calls: the run pauses there, runs that pipeline in the same
workspace and goes on with its result. Navide always waits for it, even
where n8n was set not to wait. Its error output and Retry On Fail map as for
any other step.

To import a workflow with its sub-workflows, paste them together as one JSON
array (the format `n8n export:workflow --all` writes) and import once: the
called workflows become pipelines of their own first, and the workflow no
other one calls is the one that opens. A workflow you imported before is
reused instead: import the called workflow first, then the one that calls
it. The preview's **Called workflows** list says for each one whether it is
imported now, already in Navide, or missing.

A call that would come back around (A calls B and B calls A, or a workflow
calls itself) stays **Needs review**, because a sub-pipeline cannot run
itself. So does a call to a workflow Navide does not have, a workflow
chosen by an expression, and one passed as JSON, a file or a URL.

**Call n8n Workflow Tool** lets an AI Agent call a workflow as a tool. A
pipeline cannot be called as a tool from a step, so it is not converted: the
step's kickoff names the pipeline that workflow was imported as, if any, and
the report marks it for review.

## Credentials and secrets

Credentials are not imported. The report lists each credential the workflow
uses by type and name, with the nodes that use it; n8n credential ids are
dropped. Set up access on this machine instead: an MCP server for the
service in **Settings → MCP**, or the service's own CLI login (for example
`gh`, `gcloud`). Nothing is put into a pane's environment.

Secrets written into the workflow itself — Authorization headers, API keys,
bearer tokens and other common token shapes, often left by a cURL import —
are replaced with `<removed: add credential for …>` everywhere, the stored
workflow JSON included. The report says only which field of which node lost
one; the values are not kept.

The stored workflow JSON and the credential list stay on this machine: the
settings bundle export leaves them out, and pipelines are in no Cloud sync
or share.

## Imported content is external content

Everything taken from the workflow — parameters, notes, prompts — is
treated as external content. An imported pipeline shows **Imported from
n8n** in the Pipeline Manager and the editor, every kickoff starts with an
external-content notice, and every run of it, whoever starts it, marks its
panes with Navide Guard's external-content taint. This cannot be switched
off. Read the kickoffs in the preview before running a workflow you did not
write.

## Keeping steps in n8n through n8n's MCP server

Some steps are better left in n8n — large deterministic data jobs, binary
file flows, vector stores. The report marks them **Keep it in n8n** and a step
can call the n8n workflow through n8n's own MCP server instead. Menu names
and availability depend on your n8n version; follow what your instance
shows.

1. **In n8n**, an owner or admin enables instance-level MCP access
   (Settings → Instance-level MCP → Enable MCP access).
2. **Connect Navide as a client.** Under **Connect a client**, use the
   **API key** tab: copy the Server URL (it ends in `/mcp-server/http`) and
   the access token. The token is shown in full only once.
3. **In Navide**, add an MCP server in **Settings → MCP** with that URL and
   the token as its `Authorization: Bearer <token>` header. Enter the token
   on this machine only: MCP sync copies which servers are installed, never
   their tokens.
4. **Expose the workflow.** In n8n, turn on **Available in MCP** for the
   workflow (the workflow's `…` menu → Settings), or enable it on the
   Workflows enabled page.
5. **Execute it.** The agent calls n8n's `execute_workflow` tool. Navide
   does not wait for that n8n execution to finish or hand its result to the
   next step; check the run in n8n.

Source: n8n's documentation, "Connect to n8n MCP server"
(docs.n8n.io/advanced-ai/accessing-n8n-mcp-server).

## Known limits

- Execute Workflow becomes a sub-pipeline only for a workflow Navide has;
  recursive calls and Call n8n Workflow Tool stay for review.
- `pinData` becomes test input shown in the kickoff, not a frozen step.
- More than about 8 steps only warns; each step opens a CLI pane.
- The node table follows n8n's public documentation by node type and
  version; a node it does not know is carried out by an agent and marked
  for review.
