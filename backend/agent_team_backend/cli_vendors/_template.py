"""CONTRIBUTOR TEMPLATE — copy to ``<your_key>.py`` and fill in.

Files starting with ``_`` are ignored by the registry and its tests. Steps to
add a vendor (full guide: ``docs/adding-a-cli-vendor.md``):

1. Declare how the CLI is launched and resumed, and where it sits in the
   app's lists, once, in ``native/navide-cli-runtime/src/vendors/<key>.rs``
   (program, flags, env, resume syntax, order), and regenerate the checked-in
   declarations (see ``docs/en-US/cli-extension-guide.md``).
2. Copy this file to ``<key>.py`` (short lowercase key, e.g. ``mycli``): the
   name is how ``registry.py`` finds it. Nothing registers it.
3. Fill in SPEC below. Leave any capability at its default until you
   implement it — ``None`` means the app treats that capability as
   unsupported for your vendor (it does NOT fall back to another vendor).
4. Add a log reader section below if your CLI writes local conversation
   logs, plus ``backend/tests/vendors/test_<key>.py``.
5. Add the frontend spec in ``src/renderer/src/platform/plugin-shell/agents/<key>.ts``
   (found by its name too).
6. Run the structural tests — they tell you what is missing or forbidden:
   ``uv --project backend run pytest backend/tests/test_cli_vendors_registry.py``

Nothing needs adding to the PyInstaller spec: it collects every module of
this package (``collect_submodules``), and ``cli_declarations.json`` is
bundled once for all vendors.

Import rules (CI-enforced): only ``base``, ``_declared``, ``_protocols``, the
standard library, and httpx. Never import another vendor module or any
app/ws/vault module.
"""

from .base import VendorSpec

# In a real vendor file: ``from ._declared import declared``.

SPEC = VendorSpec(
    key="_template",          # your vendor key — must match the filename
    # --- label, launch and resume: from the declaration, never retyped here ---
    # The display label (e.g. "MyCLI"), model and effort support, the effort
    # vocabulary, the environment a spawn adds and strips, the interrupt byte,
    # whether a session resumes by id and how a saved command names it:
    # **declared("mycli"),
    # --- credentials: only if the CLI stores a login the vault can park ---
    # live_file=(".mycli", "auth.json"),
    # slot_file="auth.json",
    # login_home_secret_file=(".mycli", "auth.json"),
    # profile_home_secret_file=(".mycli", "auth.json"),
    # How the vault switches the account and what the switch must do to a
    # running pane; None = never offered for switching. Declare only what
    # the CLI's source or docs establish, and say so in ``evidence``.
    # account_switch=AccountSwitchSpec(
    #     auth_scope="_template", method="restart", store="file",
    #     evidence="source", verified_version="1.2.3",
    #     todo="no A -> B -> A round-trip on two real accounts recorded"),
    # --- usage quota: async (home) -> snapshot dict ---
    # fetch_usage=fetch_usage,
    # Regex sources for THIS CLI's own "quota exhausted" text; never a
    # generic 429 / rate-limit / login message. Mirror the frontend spec's
    # ``quotaExhausted.pattern`` exactly (a test compares the two).
    # quota_exhausted_patterns=(r"usage limit reached",),
    # --- session lookup ---
    # session_path=session_path,
    # session_exists=session_exists,
    # --- log reading ---
    # make_log_reader=lambda: MyCliLogReader(),
    # --- install wizard: detection + install/update commands (see base.Dep) ---
    # install_dep=Dep("_template", "Human Name", "One-line description", "agent_cli",
    #     ["mycli", "--version"], r"(\d+\.\d+\.\d+)",
    #     install_cmd="npm install -g mycli", needs_terminal=True,
    #     requires_binaries=("npm",), optional=True, docs_url="https://mycli.dev"),
)
