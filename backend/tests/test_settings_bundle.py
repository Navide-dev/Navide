"""Bundle v1: what a shareable settings document carries, and what it refuses.

The tests that matter here are the negative ones. A bundle leaves this machine
for somebody else's, so the interesting assertions are not "the prompt arrived"
but "the API key did not", "the repository's CLAUDE.md did not", and "the
skill the user wrote themselves was never opened".

Real stores are used wherever a fake would let a refusal pass: the MCP document
validates, and the skills library decides for itself which directories are
Navide's. ``ui_settings_store`` is the one stand-in, because the renderer owns
that document and the backend only reads and writes keys in it.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from agent_team_backend import native_memory, settings_bundle, sync_scopes
from agent_team_backend.mcp_settings import MCPSettingsStore
from agent_team_backend.skills_store import SkillsStore


class FakeSettings:
    """The renderer's settings document, in memory."""

    def __init__(self, doc: dict | None = None) -> None:
        self.doc = dict(doc or {})

    def get(self) -> dict:
        return dict(self.doc)

    def set(self, updates: dict) -> dict:
        self.doc.update(updates)
        return dict(updates)


@pytest.fixture
def settings(monkeypatch) -> FakeSettings:
    from agent_team_backend import app

    fake = FakeSettings()
    monkeypatch.setattr(app, "ui_settings_store", fake)
    return fake


@pytest.fixture
def mcp_store(tmp_path, monkeypatch) -> MCPSettingsStore:
    from agent_team_backend import app

    store = MCPSettingsStore(path=tmp_path / "mcp_servers.json")
    monkeypatch.setattr(app, "mcp_settings_store", store)
    return store


@pytest.fixture
def skills(tmp_path, monkeypatch) -> tuple[SkillsStore, Path]:
    from agent_team_backend import app

    root = tmp_path / "agents" / "skills"
    store = SkillsStore(
        root=root,
        state_path=tmp_path / "skills.json",
        runtime_root=tmp_path / "runtime",
        native_roots=[tmp_path / "native"],
    )
    monkeypatch.setattr(app, "skills_store", store)
    return store, root


@pytest.fixture
def home() -> Path:
    """The isolated home conftest points the instruction-file scan at."""
    return Path(native_memory._home())


def _prompt(item_id: str, **extra) -> dict:
    return {"id": item_id, "name": item_id, "prompt": "do the thing", **extra}


# ── secrets ──────────────────────────────────────────────────────────────────
def test_env_and_header_values_never_leave_the_machine(settings, mcp_store, skills):
    """Every value, not the secret-looking ones: a bundle goes to someone else."""
    mcp_store.replace_servers(
        [
            {
                "name": "stdio-one",
                "transport": "stdio",
                "command": "npx",
                "args": ["-y", "thing"],
                "env": {"API_KEY": "sk-live-1234", "MODE": "fast"},
            },
            {
                "name": "http-one",
                "transport": "http",
                "url": "https://example.test/mcp",
                "headers": {"Authorization": "Bearer abcdef", "X-Trace": "on"},
            },
        ]
    )

    bundle = settings_bundle.export_bundle({"mcp": ["stdio-one", "http-one"]}, name="kit")

    items = bundle["scopes"]["mcp"]["items"]
    assert items["stdio-one"]["env"] == {"API_KEY": "", "MODE": ""}
    assert items["http-one"]["headers"] == {"Authorization": "", "X-Trace": ""}
    # Nothing that was ever a value is anywhere in the document, under any key.
    serialized = json.dumps(bundle)
    assert "sk-live-1234" not in serialized
    assert "abcdef" not in serialized
    # ... and the far side is told precisely what it has to supply.
    redactions = {r["item"]: set(r["fields"]) for r in bundle["redactions"]}
    assert redactions["stdio-one"] == {"env.API_KEY", "env.MODE"}
    assert redactions["http-one"] == {"headers.Authorization", "headers.X-Trace"}


def test_the_inventory_flags_a_server_that_carries_secrets(settings, mcp_store, skills):
    mcp_store.replace_servers(
        [
            {"name": "keyed", "transport": "stdio", "command": "npx", "env": {"API_KEY": "x"}},
            {"name": "bare", "transport": "stdio", "command": "npx", "env": {}},
        ]
    )

    rows = {row["id"]: row for row in settings_bundle.inventory()["mcp"]}

    assert rows["keyed"]["hasSecrets"] is True
    assert rows["bare"]["hasSecrets"] is False


def test_importing_a_changed_server_does_not_hand_it_this_machines_key(settings, mcp_store, skills):
    """A colleague's bundle that changes what the server runs gets no token of yours."""
    mcp_store.replace_servers(
        [{"name": "keyed", "transport": "stdio", "command": "npx", "env": {"API_KEY": "mine"}}]
    )
    bundle = _bundle(
        {
            "mcp": {
                "keyed": {
                    "name": "keyed",
                    "transport": "stdio",
                    "command": "npx",
                    "args": ["--new"],
                    "env": {"API_KEY": "", "NEW_ONE": ""},
                    "enabled": True,
                }
            }
        }
    )

    outcome = settings_bundle.apply_import(bundle, {"mcp": ["keyed"]})

    assert [row["ok"] for row in outcome["results"]] == [True]
    assert outcome["mcp_changed"] is True
    stored = {s["name"]: s for s in mcp_store.list_servers()}["keyed"]
    assert stored["args"] == ["--new"]  # the bundle's record did land
    # It runs something else than this machine's record (new args), so this
    # machine's key is not handed to it (security review R9-2).
    assert stored["env"]["API_KEY"] == ""
    # A key with nothing local stays visible and unset, so the user can fill it.
    assert stored["env"]["NEW_ONE"] == ""


def test_importing_the_same_server_keeps_the_key_this_machine_already_had(settings, mcp_store, skills):
    """A colleague's bundle for the very same server must not blank out the
    token you are using."""
    mcp_store.replace_servers(
        [{"name": "keyed", "transport": "stdio", "command": "npx", "args": ["--x"], "env": {"API_KEY": "mine"}}]
    )
    bundle = _bundle({"mcp": {"keyed": {"name": "keyed", "transport": "stdio", "command": "npx",
                                         "args": ["--x"], "env": {"API_KEY": ""}, "enabled": False}}})
    settings_bundle.apply_import(bundle, {"mcp": ["keyed"]})
    stored = {s["name"]: s for s in mcp_store.list_servers()}["keyed"]
    assert stored["env"] == {"API_KEY": "mine"} and stored["enabled"] is False


def test_the_preview_names_the_values_the_importer_has_to_supply(settings, mcp_store, skills):
    bundle = _bundle(
        {
            "mcp": {
                "keyed": {
                    "name": "keyed",
                    "transport": "stdio",
                    "command": "npx",
                    "env": {"API_KEY": ""},
                }
            }
        }
    )

    row = settings_bundle.preview_import(bundle)[0]

    assert row["action"] == "create"
    assert "env.API_KEY" in row["reason"]


def test_no_canary_this_machine_keeps_private_survives_an_export(
    settings, mcp_store, skills, home
):
    """Search the whole serialized document, not the redactions list.

    Asserting that ``redactions`` mentions a field only proves the bookkeeping
    agrees with itself. A value can leave by a path nobody thought about — a
    second copy of the record, a scope that packs more than it was asked for —
    and the only check that covers every path at once is "this string is not in
    the file".
    """
    store, root = skills
    mcp_store.replace_servers(
        [
            {
                "name": "keyed",
                "transport": "stdio",
                "command": "npx",
                "env": {"API_KEY": "SEKRIT-env-a1b2c3"},
            },
            {
                "name": "remote",
                "transport": "http",
                "url": "https://example.test/mcp",
                "headers": {"Authorization": "SEKRIT-header-d4e5f6"},
            },
            # Not selected below: a scope must pack what it was asked for and
            # nothing else.
            {
                "name": "unpicked",
                "transport": "stdio",
                "command": "npx",
                "env": {"TOKEN": "SEKRIT-unpicked-mcp"},
            },
        ]
    )
    settings.doc[sync_scopes.PROMPT_SKILLS_KEY] = [
        _prompt("shared", isDefault=True),
        _prompt("private", prompt="SEKRIT-unpicked-prompt"),
    ]
    store.create_skill("shared", "shared", consent=True)
    store.create_skill("private", "private", consent=True)
    (root / "private" / "notes.txt").write_bytes(b"SEKRIT-unpicked-skill\n")
    (home / ".claude").mkdir(parents=True, exist_ok=True)
    (home / ".claude" / "CLAUDE.md").write_text("shared rules\n", encoding="utf-8")
    (home / ".codex").mkdir(parents=True, exist_ok=True)
    (home / ".codex" / "AGENTS.md").write_text("SEKRIT-unpicked-memory\n", encoding="utf-8")

    bundle = settings_bundle.export_bundle(
        {
            "prompts": ["shared"],
            "mcp": ["keyed", "remote"],
            "skills": ["shared"],
            "memory": [".claude/CLAUDE.md"],
        },
        name="kit",
    )

    serialized = json.dumps(bundle, ensure_ascii=False)
    for canary in (
        "SEKRIT-env-a1b2c3",
        "SEKRIT-header-d4e5f6",
        "SEKRIT-unpicked-mcp",
        "SEKRIT-unpicked-prompt",
        "SEKRIT-unpicked-skill",
        "SEKRIT-unpicked-memory",
    ):
        assert canary not in serialized, f"{canary} left this machine"


def test_a_secret_pasted_into_args_or_a_url_does_travel(settings, mcp_store, skills):
    """The boundary of the redaction rule, written down so it is a decision.

    ``env`` and ``headers`` are the fields whose *values* are credentials; a
    command's args and a server's url are what make the record runnable, and a
    bundle that stripped them would hand over something that cannot start. So a
    token someone typed into ``args`` or into a url query string is carried, and
    the picker has to say so. If that is ever to change, this test is where the
    change gets argued — not somewhere a value quietly starts or stops moving.
    """
    mcp_store.replace_servers(
        [
            {
                "name": "inline",
                "transport": "stdio",
                "command": "npx",
                "args": ["--api-key=SEKRIT-in-args"],
            },
            {
                "name": "query",
                "transport": "http",
                "url": "https://example.test/mcp?token=SEKRIT-in-url",
            },
        ]
    )

    serialized = json.dumps(settings_bundle.export_bundle({"mcp": ["inline", "query"]}))

    assert "SEKRIT-in-args" in serialized
    assert "SEKRIT-in-url" in serialized
    # ... and the picker is told, because a value that travels unasked is a
    # leak and one the user was warned about is a choice.
    rows = {row["id"]: row for row in settings_bundle.inventory()["mcp"]}
    assert rows["inline"]["mayLeakInArgsOrUrl"] is True
    assert rows["query"]["mayLeakInArgsOrUrl"] is True


def test_the_two_secret_flags_are_independent(settings, mcp_store, skills):
    """hasSecrets = env/headers have values and will be stripped;
    mayLeakInArgsOrUrl = args/url look like they carry a credential and will
    not be. One record can be either, both, or neither."""
    mcp_store.replace_servers(
        [
            {"name": "neither", "transport": "stdio", "command": "npx", "args": ["-y", "pkg"]},
            {"name": "env-only", "transport": "stdio", "command": "npx", "env": {"API_KEY": "x"}},
            {
                "name": "args-only",
                "transport": "stdio",
                "command": "npx",
                "args": ["--token=SEKRIT"],
            },
            {
                "name": "both",
                "transport": "http",
                "url": "https://example.test/mcp?api_key=SEKRIT",
                "headers": {"Authorization": "Bearer x"},
            },
        ]
    )

    rows = {row["id"]: row for row in settings_bundle.inventory()["mcp"]}

    flags = {
        name: (row["hasSecrets"], row["mayLeakInArgsOrUrl"]) for name, row in rows.items()
    }
    assert flags == {
        "neither": (False, False),
        "env-only": (True, False),
        "args-only": (False, True),
        "both": (True, True),
    }


@pytest.mark.parametrize(
    "text",
    [
        "--api-key=abc",
        "token: abc",
        "Bearer abc",
        "https://h.test/?secret=abc",
        "https://h.test/?password=abc",
        "0123456789abcdef0123456789abcdef",  # 32 hex — a typical API key
        "ghp_" + "A" * 40,  # a long opaque run
    ],
)
def test_token_like_text_in_args_or_url_is_flagged(text):
    assert settings_bundle.may_leak_in_carried_fields({"args": [text]}) is True
    assert settings_bundle.may_leak_in_carried_fields({"url": text}) is True


@pytest.mark.parametrize(
    "text",
    ["-y", "@upstash/context7-mcp", "https://example.test/mcp", "--port=8080", "run", "serve"],
)
def test_ordinary_arguments_are_not_flagged(text):
    assert settings_bundle.may_leak_in_carried_fields({"args": [text], "url": text}) is False


# ── partial failure ──────────────────────────────────────────────────────────
def test_a_refused_record_leaves_the_others_alone_and_says_so(settings, mcp_store, skills):
    """Three selected, the middle one invalid: no half-written document, and
    nothing that failed does so quietly."""
    mcp_store.replace_servers([])
    bundle = _bundle(
        {
            "mcp": {
                "first": {"name": "first", "transport": "stdio", "command": "npx"},
                # An empty command cannot be validated into the document.
                "broken": {"name": "broken", "transport": "stdio", "command": ""},
                "third": {"name": "third", "transport": "stdio", "command": "npx"},
            }
        }
    )

    outcome = settings_bundle.apply_import(bundle, {"mcp": ["first", "broken", "third"]})

    results = {row["id"]: row for row in outcome["results"]}
    assert results["first"]["ok"] is True
    assert results["third"]["ok"] is True
    assert results["broken"]["ok"] is False
    assert results["broken"]["reason"]  # never a silent drop
    on_disk = {server["name"] for server in mcp_store.list_servers()}
    assert on_disk == {"first", "third"}


# ── memory ───────────────────────────────────────────────────────────────────
def test_project_scope_instruction_files_are_never_collected(
    settings, mcp_store, skills, monkeypatch, tmp_path
):
    """Repository files belong to git; two systems writing one file is how both
    of them end up wrong."""
    (tmp_path / "home.md").write_text("home\n")
    (tmp_path / "repo.md").write_text("repo\n")

    class FakeFile:
        def __init__(self, scope, relative, path):
            self.scope, self.relative, self.path = scope, relative, path
            self.exists, self.error = True, ""
            self.readers = ("claude",)

    monkeypatch.setattr(
        native_memory,
        "scan",
        lambda *a, **k: [
            FakeFile(native_memory.USER_SCOPE, ".claude/CLAUDE.md", str(tmp_path / "home.md")),
            FakeFile(native_memory.PROJECT_SCOPE, "CLAUDE.md", str(tmp_path / "repo.md")),
        ],
    )
    monkeypatch.setattr(
        native_memory, "read", lambda path, *a, **k: {"text": f"text of {path}", "exists": True}
    )

    listed = {row["id"] for row in settings_bundle.inventory()["memory"]}
    assert listed == {".claude/CLAUDE.md"}

    # And it cannot be smuggled in by naming it in a selection either.
    with pytest.raises(settings_bundle.BundleError) as err:
        settings_bundle.export_bundle({"memory": ["CLAUDE.md"]})
    assert err.value.code == "ITEM_NOT_FOUND"


def test_a_user_instruction_file_round_trips(settings, mcp_store, skills, home):
    target = home / ".claude" / "CLAUDE.md"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text("original\n", encoding="utf-8")

    bundle = settings_bundle.export_bundle({"memory": [".claude/CLAUDE.md"]})
    assert bundle["scopes"]["memory"]["items"][".claude/CLAUDE.md"] == {"text": "original\n"}

    bundle["scopes"]["memory"]["items"][".claude/CLAUDE.md"]["text"] = "shared\n"
    outcome = settings_bundle.apply_import(bundle, {"memory": [".claude/CLAUDE.md"]})

    assert outcome["results"][0]["ok"] is True
    assert outcome["results"][0]["action"] == "overwrite"
    assert target.read_text(encoding="utf-8") == "shared\n"


def test_an_instruction_file_this_machine_does_not_keep_is_skipped(settings, mcp_store, skills):
    bundle = _bundle({"memory": {"somewhere/else.md": {"text": "hi"}}})

    row = settings_bundle.preview_import(bundle)[0]

    assert row["action"] == "skip"
    assert "no instruction file" in row["reason"]


# ── skills ───────────────────────────────────────────────────────────────────
def test_only_a_navide_managed_skill_can_be_packed(settings, mcp_store, skills):
    store, root = skills
    store.create_skill("ours", "made here", consent=True)
    theirs = root / "theirs"
    theirs.mkdir(parents=True)
    (theirs / "SKILL.md").write_text("---\nname: theirs\n---\nbody\n", encoding="utf-8")

    rows = {row["id"]: row for row in settings_bundle.inventory()["skills"]}
    assert rows["ours"]["eligible"] is True
    assert rows["theirs"]["eligible"] is False
    assert "not a skill Navide manages" in rows["theirs"]["reason"]

    with pytest.raises(settings_bundle.BundleError) as err:
        settings_bundle.export_bundle({"skills": ["theirs"]})
    assert err.value.code == "ITEM_NOT_ELIGIBLE"


def test_importing_never_displaces_a_skill_the_user_owns(settings, mcp_store, skills):
    store, root = skills
    theirs = root / "theirs"
    theirs.mkdir(parents=True)
    (theirs / "SKILL.md").write_text("---\nname: theirs\n---\nmine\n", encoding="utf-8")
    bundle = _bundle(
        {
            "skills": {
                "theirs": {"files": {"SKILL.md": {"t": "text", "v": "---\nname: theirs\n---\nyours\n"}}}
            }
        }
    )

    assert settings_bundle.preview_import(bundle)[0]["action"] == "skip"

    outcome = settings_bundle.apply_import(bundle, {"skills": ["theirs"]})

    assert outcome["results"][0]["action"] == "skip"
    assert (theirs / "SKILL.md").read_text(encoding="utf-8").endswith("mine\n")


def test_a_managed_skill_round_trips_with_its_files(settings, mcp_store, skills, tmp_path):
    store, root = skills
    store.create_skill("writer", "writes", consent=True)
    (root / "writer" / "scripts").mkdir(parents=True)
    (root / "writer" / "scripts" / "go.sh").write_bytes(b"echo hi\n")

    bundle = settings_bundle.export_bundle({"skills": ["writer"]}, name="kit")

    files = bundle["scopes"]["skills"]["items"]["writer"]["files"]
    assert files["scripts/go.sh"] == {"t": "text", "v": "echo hi\n"}
    assert ".navide" not in files  # recreated on the far side, never carried

    # Import it onto a second machine and the files land.
    from agent_team_backend import app

    second_root = tmp_path / "second" / "skills"
    second = SkillsStore(
        root=second_root,
        state_path=tmp_path / "second-skills.json",
        runtime_root=tmp_path / "second-runtime",
        native_roots=[tmp_path / "second-native"],
    )
    app.skills_store = second
    outcome = settings_bundle.apply_import(bundle, {"skills": ["writer"]})

    assert outcome["results"][0] == {
        "scope": "skills",
        "id": "writer",
        "action": "create",
        "ok": True,
        "reason": "",
    }
    assert (second_root / "writer" / "scripts" / "go.sh").read_bytes() == b"echo hi\n"


# ── prompts ──────────────────────────────────────────────────────────────────
def test_the_default_flag_does_not_travel(settings, mcp_store, skills):
    """Two defaults in one list is a state the renderer resolves arbitrarily."""
    settings.doc[sync_scopes.PROMPT_SKILLS_KEY] = [
        _prompt("mine", isDefault=True),
        _prompt("other", isDefault=False),
    ]

    bundle = settings_bundle.export_bundle({"prompts": ["mine"]})

    assert "isDefault" not in bundle["scopes"]["prompts"]["items"]["mine"]


def test_an_imported_prompt_cannot_steal_the_default(settings, mcp_store, skills):
    settings.doc[sync_scopes.PROMPT_SKILLS_KEY] = [_prompt("mine", isDefault=True)]
    # A hand-edited bundle, with the flag put back in.
    bundle = _bundle({"prompts": {"theirs": _prompt("theirs", isDefault=True)}})

    outcome = settings_bundle.apply_import(bundle, {"prompts": ["theirs"]})

    assert outcome["results"][0]["ok"] is True
    stored = {p["id"]: p for p in settings.doc[sync_scopes.PROMPT_SKILLS_KEY]}
    assert stored["mine"]["isDefault"] is True
    assert stored["theirs"]["isDefault"] is False
    # Other windows are told, the way they are told about a local edit.
    assert outcome["settings_deltas"]


# ── offline ──────────────────────────────────────────────────────────────────
def test_the_inventory_needs_no_account_and_no_server(settings, mcp_store, skills, monkeypatch):
    """Signed out and offline, this listing is the only place the user can see
    their own settings — the cloud half answers not-connected and lists
    nothing. So it must never grow a key check or a link check in front of it."""
    from agent_team_backend import server_link, sync_keyring

    def refuse(*_args, **_kwargs):
        raise AssertionError("the local inventory asked the cloud half a question")

    for name in ("account_key", "has_account_key", "ensure_account_key", "encrypt", "decrypt"):
        monkeypatch.setattr(sync_keyring, name, refuse)
    monkeypatch.setattr(server_link, "network_snapshot", refuse)

    store, _root = skills
    store.create_skill("writer", "writes", consent=True)
    settings.doc[sync_scopes.PROMPT_SKILLS_KEY] = [_prompt("mine", isDefault=True)]
    mcp_store.replace_servers([{"name": "keyed", "transport": "stdio", "command": "npx"}])

    listing = settings_bundle.inventory()

    assert [row["id"] for row in listing["prompts"]] == ["mine"]
    assert [row["id"] for row in listing["mcp"]] == ["keyed"]
    assert [row["id"] for row in listing["skills"]] == ["writer"]


# ── the preview writes nothing ───────────────────────────────────────────────
def test_the_preview_touches_no_store(settings, mcp_store, skills, home, monkeypatch):
    store, root = skills
    store.create_skill("writer", "writes", consent=True)
    settings.doc[sync_scopes.PROMPT_SKILLS_KEY] = [_prompt("mine", isDefault=True)]
    mcp_store.replace_servers([{"name": "keyed", "transport": "stdio", "command": "npx"}])
    instructions = home / ".claude" / "CLAUDE.md"
    instructions.parent.mkdir(parents=True, exist_ok=True)
    instructions.write_text("original\n", encoding="utf-8")

    def refuse(*_args, **_kwargs):
        raise AssertionError("the preview wrote something")

    monkeypatch.setattr(settings, "set", refuse)
    monkeypatch.setattr(store, "import_content", refuse)
    monkeypatch.setattr(mcp_store, "replace_servers", refuse)
    monkeypatch.setattr(native_memory, "save", refuse)

    before = _fingerprint(root, mcp_store, instructions)
    rows = settings_bundle.preview_import(
        _bundle(
            {
                "prompts": {"mine": _prompt("mine"), "new": _prompt("new")},
                "mcp": {"keyed": {"name": "keyed", "transport": "stdio", "command": "npx"}},
                "skills": {
                    "writer": {"files": {"SKILL.md": {"t": "text", "v": "---\nname: writer\n---\n"}}},
                    # Not installed here: the branch that would be tempted to
                    # find out by trying.
                    "newcomer": {
                        "files": {"SKILL.md": {"t": "text", "v": "---\nname: newcomer\n---\n"}}
                    },
                },
                "memory": {".claude/CLAUDE.md": {"text": "replaced\n"}},
            }
        )
    )

    assert _fingerprint(root, mcp_store, instructions) == before
    actions = {(row["scope"], row["id"]): row["action"] for row in rows}
    assert actions[("prompts", "mine")] == "overwrite"
    assert actions[("prompts", "new")] == "create"
    assert actions[("skills", "writer")] == "overwrite"
    assert actions[("skills", "newcomer")] == "create"
    assert actions[("memory", ".claude/CLAUDE.md")] == "overwrite"


def _fingerprint(root: Path, mcp_store: MCPSettingsStore, instructions: Path) -> tuple:
    files = sorted(
        (str(p.relative_to(root)), p.read_bytes()) for p in root.rglob("*") if p.is_file()
    )
    return (files, mcp_store.list_servers(), instructions.read_bytes())


# ── the size cap ─────────────────────────────────────────────────────────────
def test_a_bundle_over_the_cap_is_refused_and_names_the_scope(settings, mcp_store, skills):
    settings.doc[sync_scopes.PROMPT_SKILLS_KEY] = [
        _prompt("huge", prompt="x" * (settings_bundle.MAX_BUNDLE_BYTES + 1))
    ]

    with pytest.raises(settings_bundle.BundleError) as err:
        settings_bundle.export_bundle({"prompts": ["huge"]})

    assert err.value.code == "BUNDLE_TOO_LARGE"
    assert err.value.details["scope"] == "prompts"
    assert err.value.details["limit"] == settings_bundle.MAX_BUNDLE_BYTES


def test_an_oversized_bundle_is_refused_on_the_way_in_too(settings, mcp_store, skills):
    bundle = _bundle(
        {"prompts": {"huge": _prompt("huge", prompt="x" * (settings_bundle.MAX_BUNDLE_BYTES + 1))}}
    )

    with pytest.raises(settings_bundle.BundleError) as err:
        settings_bundle.preview_import(bundle)
    assert err.value.code == "BUNDLE_TOO_LARGE"

    with pytest.raises(settings_bundle.BundleError) as err:
        settings_bundle.apply_import(bundle, {"prompts": ["huge"]})
    assert err.value.code == "BUNDLE_TOO_LARGE"


def test_a_bundle_from_a_future_version_is_refused(settings, mcp_store, skills):
    with pytest.raises(settings_bundle.BundleError) as err:
        settings_bundle.preview_import({"bundleVersion": 2, "scopes": {}})
    assert err.value.code == "UNSUPPORTED_BUNDLE_VERSION"


# ── shape ────────────────────────────────────────────────────────────────────
def test_an_exported_bundle_has_the_v1_shape(settings, mcp_store, skills):
    settings.doc[sync_scopes.PROMPT_SKILLS_KEY] = [_prompt("mine", isDefault=True)]

    bundle = settings_bundle.export_bundle(
        {"prompts": ["mine"]}, name="my kit", description="what I use"
    )

    assert bundle["bundleVersion"] == 1
    assert bundle["name"] == "my kit"
    assert bundle["description"] == "what I use"
    assert bundle["createdAt"].endswith("+00:00")
    assert set(bundle["createdBy"]) == {"device", "app"}
    assert set(bundle["scopes"]) == set(settings_bundle.SCOPES)
    assert bundle["redactions"] == []
    # It is a document: whatever is in it has to survive a file round trip.
    assert json.loads(json.dumps(bundle)) == bundle


def _bundle(scopes: dict[str, dict]) -> dict:
    return {
        "bundleVersion": 1,
        "name": "test",
        "description": "",
        "createdAt": "2026-01-01T00:00:00+00:00",
        "createdBy": {"device": "test", "app": "Navide"},
        "scopes": {scope: {"items": scopes.get(scope, {})} for scope in settings_bundle.SCOPES},
        "redactions": [],
    }
