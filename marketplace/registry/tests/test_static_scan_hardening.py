"""Adversarial inputs from the review of #355 (H1, M1, L1, L2).

Every hostile input must finish well within the per-artifact budget and
produce a report that exists and says the scan is incomplete (DS2: at least
high, "掃描不完整"); none may crash the scan or leave the version without a
report. All inputs are built in memory.
"""

from __future__ import annotations

import hashlib
import io
import json
import struct
import time
import zipfile

import pytest
from sqlmodel import Session, select

from registry import static_scan
from registry.models import ExtensionVersion
from registry.plugin_contract import disclosure_contract, disclosure_scan_contract
from registry.static_scan import js_tokens, report as report_module, run_scan, scan_package
from registry.static_scan.js_scan import parse_command, scan_script
from registry.static_scan.limits import Deadline, ScanTimeout, TooComplex
from registry.static_scan.native import summarize_executable
from tests.phase2_helpers import (
    ADMIN_HEADERS,
    claim,
    cloud_settings,
    make_client,
    new_token,
    publish,
    queued_artifacts,
    sign_in,
)
from tests.fixtures import build_v2_package, contract_manifest

MANIFEST = {"schemaVersion": 2, "id": "acme.scoped", "version": "1.0.0", "publisher": "acme"}
BUDGET_S = disclosure_scan_contract.SCAN_LIMITS["timeBudgetMs"] / 1000


def _zip(files: dict[str, str | bytes], manifest: dict = MANIFEST) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("manifest.json", json.dumps(manifest))
        for name, data in files.items():
            archive.writestr(name, data)
    return buffer.getvalue()


def _incomplete(report: dict) -> list[str]:
    sentence = next((s for s in disclosure_scan_contract.scan_sentences(report) if s["key"] == "coverage.incomplete"), None)
    assert sentence is not None, "the scan must be shown as incomplete"
    return sentence["params"]["reasons"]


def _timed(fn):
    started = time.monotonic()
    result = fn()
    assert time.monotonic() - started < BUDGET_S
    return result


# -- H1: native executables ----------------------------------------------------


def _elf_header(*, shoff: int, shentsize: int, shnum: int) -> bytes:
    ident = b"\x7fELF" + bytes([2, 1, 1, 0]) + b"\0" * 8
    return ident + struct.pack("<HHIQQQIHHHHHH", 3, 62, 1, 0, 0, shoff, 0, 64, 56, 0, shentsize, shnum, 0)


def test_elf_with_section_header_size_zero_is_too_complex_not_a_hang() -> None:
    data = _elf_header(shoff=64, shentsize=0, shnum=65535) + b"\0" * 4096
    facts = _timed(lambda: summarize_executable("backend/x", data))
    assert facts.too_complex


def test_elf_with_a_huge_dynamic_section_is_bounded() -> None:
    entries = 70_000  # above MAX_DYNAMIC_ENTRIES
    dynamic = struct.pack("<qQ", 5, 0) * entries + struct.pack("<qQ", 0, 0)
    shoff = 64 + len(dynamic)
    sections = (
        struct.pack("<IIQQQQIIQQ", 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)
        + struct.pack("<IIQQQQIIQQ", 0, 6, 0, 0, 64, 1 << 40, 0, 0, 8, 16)  # declares 1 TiB
    )
    data = _elf_header(shoff=shoff, shentsize=64, shnum=2) + dynamic + sections
    facts = _timed(lambda: summarize_executable("backend/x", data))
    assert facts.too_complex


def _pe_with_many_imports(descriptors: int, thunks_per_descriptor: int) -> bytes:
    pe_offset = 0x80
    dos = b"MZ" + b"\0" * 0x3A + struct.pack("<I", pe_offset) + b"\0" * (pe_offset - 0x40)
    optional = bytearray(240)
    struct.pack_into("<H", optional, 0, 0x20B)
    table_rva = 0x1000
    thunk_rva = table_rva + 20 * (descriptors + 1)
    name_rva = thunk_rva + 8 * (thunks_per_descriptor + 1)
    struct.pack_into("<II", optional, 112 + 8, table_rva, 20 * descriptors)
    raw = bytearray(name_rva - table_rva + 64)  # hint/name at name_rva, library name 32 bytes later
    for index in range(descriptors):  # every descriptor shares one thunk table
        struct.pack_into("<IIIII", raw, 20 * index, thunk_rva, 0, 0, name_rva + 32, thunk_rva)
    for index in range(thunks_per_descriptor):
        struct.pack_into("<Q", raw, thunk_rva - table_rva + 8 * index, name_rva)
    raw[name_rva - table_rva:name_rva - table_rva + 16] = b"\0\0CreateProcessW"  # hint + name
    raw[name_rva - table_rva + 32:name_rva - table_rva + 45] = b"KERNEL32.dll\0"
    section = struct.pack("<8sIIIIIIHHI", b".idata", len(raw), table_rva, len(raw), 0x400, 0, 0, 0, 0, 0)
    headers = dos + b"PE\0\0" + struct.pack("<HHIIIHH", 0x8664, 1, 0, 0, 0, 240, 0x22) + bytes(optional) + section
    return headers.ljust(0x400, b"\0") + bytes(raw)


@pytest.mark.parametrize(("descriptors", "thunks"), [(4096, 64), (64, 65536)])
def test_pe_with_thousands_of_descriptors_or_thunks_is_bounded(descriptors: int, thunks: int) -> None:
    facts = _timed(lambda: summarize_executable("backend/x.exe", _pe_with_many_imports(descriptors, thunks)))
    assert facts.too_complex
    assert facts.libraries == {"KERNEL32.dll"}


def test_a_too_complex_backend_makes_the_report_incomplete_and_at_least_high() -> None:
    manifest = contract_manifest("backend-declared-methods.json")
    manifest.update(id="acme.indexer", publisher="acme")
    elf_bomb = _elf_header(shoff=64, shentsize=0, shnum=65535) + b"\0" * 64
    data = build_v2_package(manifest, backend_data=elf_bomb)
    report = _timed(lambda: scan_package(data, artifact_digest="a" * 64, target="linux-x64", manifest=manifest))
    assert {"reason": "tooComplex", "count": 1} in report["coverage"]["skipped"]
    assert "tooComplex" in _incomplete(report)
    disclosure = disclosure_contract.compute_disclosure(manifest)
    assert disclosure_scan_contract.card_risk_level(disclosure, report) in ("high", "highest")


# -- H1: JavaScript ---------------------------------------------------------------


def test_deeply_nested_templates_are_too_complex_without_recursion() -> None:
    source = "`" + "${`" * 40 + "x" + "`}" * 40 + "`"
    with pytest.raises(TooComplex):
        _timed(lambda: js_tokens.tokenize(source))
    deep = "`" + "${`" * 5000 + "`}" * 5000 + "`"  # far past Python's recursion limit
    with pytest.raises(TooComplex):
        _timed(lambda: js_tokens.tokenize(deep))


def test_a_nested_template_bomb_makes_the_report_incomplete() -> None:
    bomb = "`" + "${`" * 40 + "`}" * 40 + "`"
    report = _timed(lambda: _scan({"frontend/bomb.js": bomb, "frontend/ok.js": "invoke('shell.run', {command: 'git push'})"}))
    assert {"reason": "tooComplex", "count": 1} in report["coverage"]["skipped"]
    assert "tooComplex" in _incomplete(report)
    assert report["shell"]["calls"][0]["subcommand"] == "push"  # the other file was still scanned


@pytest.mark.parametrize("source", ["'" * 200_000, "/" * 200_000, "`" + "x" * 100_000])
def test_pathological_lines_stay_within_the_budget(source: str) -> None:
    _timed(lambda: _scan({"frontend/a.js": source}))


def test_the_deadline_preempts_work_inside_one_file() -> None:
    ticks = iter(range(10_000_000))
    clock = lambda: float(next(ticks))  # noqa: E731 - every clock read is one second later
    big = "a.b(c);" * 200_000
    report = scan_package(_zip({"frontend/a.js": big, "frontend/b.js": "1"}), artifact_digest="a" * 64,
                          target="universal", manifest=MANIFEST, clock=clock)
    assert report["coverage"]["timedOut"] is True
    assert "timedOut" in _incomplete(report)


def test_deadline_object() -> None:
    ticks = iter([0.0, 2.0])
    deadline = Deadline(1.0, lambda: next(ticks))
    deadline.check()
    with pytest.raises(ScanTimeout):
        deadline.check()


# -- M1 ---------------------------------------------------------------------------


def _scan(files: dict[str, str | bytes]):
    data = _zip(files)
    return scan_package(data, artifact_digest=hashlib.sha256(data).hexdigest(), target="universal", manifest=MANIFEST)


def test_a_scanner_crash_on_one_file_is_recorded_and_the_others_are_scanned(monkeypatch) -> None:
    real = report_module.scan_script

    def flaky(text: str, **kwargs):
        if "crash-me" in text:
            raise RecursionError("boom")
        return real(text, **kwargs)

    monkeypatch.setattr(report_module, "scan_script", flaky)
    report = _scan({"frontend/a.js": "'crash-me'", "frontend/b.js": "const u = 'https://ok.example.com'"})
    assert {"reason": "scannerError", "count": 1} in report["coverage"]["skipped"]
    assert report["network"]["hosts"] == [{"host": "ok.example.com", "source": "frontend", "count": 1}]
    assert "scannerError" in _incomplete(report)


def test_a_scan_that_fails_as_a_whole_still_yields_an_incomplete_report(monkeypatch) -> None:
    def broken(*args, **kwargs):
        raise MemoryError("whole scan")

    monkeypatch.setattr(static_scan, "scan_package", broken)
    report = run_scan(b"not a zip", artifact_digest="a" * 64, target="universal", manifest=MANIFEST)
    assert report is not None
    assert "scannerError" in _incomplete(report)
    disclosure_contract.canonical_contract_json(report)
    disclosure = disclosure_contract.compute_disclosure({**MANIFEST, "permissions": {"system": ["ui"]}})
    assert disclosure_scan_contract.card_risk_level(disclosure, report) in ("high", "highest")
    assert run_scan(b"x", artifact_digest="a" * 64, target="universal", manifest={"id": "acme.v1"}) is None


# -- L1 ---------------------------------------------------------------------------


def test_approval_refuses_a_stored_package_that_no_longer_matches_its_digest(tmp_path) -> None:
    client = make_client(cloud_settings(tmp_path))
    sign_in(client)
    assert claim(client, "acme-tools").status_code == 303
    token = new_token(client, "acme-tools")
    manifest = contract_manifest()
    manifest.update(id="acme-tools.viewer", publisher="acme-tools")
    assert publish(client, token, build_v2_package(manifest)).status_code == 201
    with Session(client.app.state.registry.engine) as session:
        row = session.exec(select(ExtensionVersion)).one()
        key = row.package_key
    storage = client.app.state.registry.storage
    storage.put(key, _zip({"frontend/evil.js": "invoke('shell.run', {command: 'git push'})"}, manifest))

    artifacts = queued_artifacts(client, "acme-tools", "viewer")
    refused = client.post("/api/admin/review/acme-tools/viewer/1.0.0/approve",
                          json={"artifacts": artifacts}, headers=ADMIN_HEADERS)
    assert refused.status_code == 409
    assert "does not match its digest" in refused.json()["detail"]
    with Session(client.app.state.registry.engine) as session:
        assert session.exec(select(ExtensionVersion)).one().review_status == "pending"


def test_rescan_binds_the_digest_of_the_stored_bytes() -> None:
    class Storage:
        def get(self, key: str) -> bytes:
            return stored

    stored = _zip({"frontend/a.js": "1"})
    row = ExtensionVersion(extension_id=1, version="1.0.0", manifest=MANIFEST, package_digest="f" * 64,
                           package_key="k", target="universal")
    report = static_scan.scan_stored_version(Storage(), row)  # type: ignore[arg-type]
    assert report["artifactDigest"] == hashlib.sha256(stored).hexdigest()


# -- L2 ---------------------------------------------------------------------------


@pytest.mark.parametrize("command", ["python3.12 -c x", "G++ a.c", "Git push", "node.exe a", "_x y"])
def test_executables_outside_the_contract_charset_are_not_reported(command: str) -> None:
    assert parse_command(command) is None


def test_long_literals_are_not_parsed_as_commands() -> None:
    assert parse_command("git " + "x" * 5000) is None
    assert scan_script("const a = 'git " + "y " * 3000 + "'", max_path_length=200).calls == set()
