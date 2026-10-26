"""D-s2: the native backend executable summary of the static scan (contract 3.8).

The executables are built byte by byte here (no committed binaries), with
just the structures the scanner reads.
"""

from __future__ import annotations

import hashlib
import json
import struct

import pytest

from registry.native_backend import MIN_NAVIDE_FOR_THIRD_PARTY_BACKEND
from registry.plugin_contract import disclosure_contract, disclosure_scan_contract
from registry.static_scan import scan_package
from registry.static_scan.native import summarize_executable
from tests.conftest import SignedEnv
from tests.fixtures import build_v2_package, contract_manifest

STRINGS = b"\0git push origin main\0https://api.example.com/v1?token=x\0fs.writeFile\0"


def macho(*, upx: bool = False, extra: bytes = b"") -> bytes:
    dylib = b"/usr/lib/libSystem.B.dylib\0"
    dylib_cmd = struct.pack("<IIIIII", 0xC, 24 + len(dylib) + 5, 24, 0, 0, 0) + dylib + b"\0" * 5
    segment = struct.pack("<II16s", 0x19, 72, b"UPX0" if upx else b"__TEXT") + b"\0" * 48
    strtab = b"\0_execve\0_getaddrinfo\0_local\0"
    header_size = 32
    symtab_cmd_size = 24
    commands_size = len(dylib_cmd) + len(segment) + symtab_cmd_size
    symoff = header_size + commands_size
    symbols = (
        struct.pack("<IBBHQ", 1, 0x01, 0, 0, 0)       # _execve, undefined external
        + struct.pack("<IBBHQ", 9, 0x01, 0, 0, 0)     # _getaddrinfo
        + struct.pack("<IBBHQ", 22, 0x0F, 1, 0, 0)    # _local, defined: not an import
    )
    stroff = symoff + len(symbols)
    symtab_cmd = struct.pack("<IIIIII", 0x2, symtab_cmd_size, symoff, 3, stroff, len(strtab))
    header = struct.pack("<IiiIIII", 0xFEEDFACF, 0x0100000C, 0, 2, 3, commands_size, 0) + b"\0" * 4
    return header + dylib_cmd + segment + symtab_cmd + symbols + strtab + STRINGS + extra


def elf() -> bytes:
    dynstr = b"\0libc.so.6\0execve\0socket\0"
    dynsym = b"\0" * 24 + struct.pack("<IBBHQQ", 11, 0x12, 0, 0, 0, 0) + struct.pack("<IBBHQQ", 18, 0x12, 0, 0, 0, 0)
    dynamic = struct.pack("<qQ", 1, 1) + struct.pack("<qQ", 0, 0)
    data_offset = 64
    dynstr_off = data_offset
    dynsym_off = dynstr_off + len(dynstr)
    dynamic_off = dynsym_off + len(dynsym)
    strings_off = dynamic_off + len(dynamic)
    shoff = strings_off + len(STRINGS)
    sections = [
        struct.pack("<IIQQQQIIQQ", 0, 0, 0, 0, 0, 0, 0, 0, 0, 0),
        struct.pack("<IIQQQQIIQQ", 0, 3, 0, 0, dynstr_off, len(dynstr), 0, 0, 1, 0),
        struct.pack("<IIQQQQIIQQ", 0, 11, 0, 0, dynsym_off, len(dynsym), 1, 1, 8, 24),
        struct.pack("<IIQQQQIIQQ", 0, 6, 0, 0, dynamic_off, len(dynamic), 1, 0, 8, 16),
    ]
    ident = b"\x7fELF" + bytes([2, 1, 1, 0]) + b"\0" * 8
    header = ident + struct.pack("<HHIQQQIHHHHHH", 3, 183, 1, 0, 0, shoff, 0, 64, 56, 0, 64, len(sections), 0)
    return header + dynstr + dynsym + dynamic + STRINGS + b"".join(sections)


def pe() -> bytes:
    pe_offset = 0x80
    dos = b"MZ" + b"\0" * 0x3A + struct.pack("<I", pe_offset) + b"\0" * (pe_offset - 0x40)
    optional_size = 240
    file_header = b"PE\0\0" + struct.pack("<HHIIIHH", 0x8664, 1, 0, 0, 0, optional_size, 0x22)
    optional = bytearray(optional_size)
    struct.pack_into("<H", optional, 0, 0x20B)
    struct.pack_into("<II", optional, 112 + 8, 0x1000, 40)  # import directory
    section = struct.pack("<8sIIIIIIHHI", b".idata", 0x400, 0x1000, 0x400, 0x400, 0, 0, 0, 0, 0)
    headers = dos + file_header + bytes(optional) + section
    raw = bytearray(0x400)
    struct.pack_into("<IIIII", raw, 0, 0x1100, 0, 0, 0x1200, 0x1100)
    struct.pack_into("<QQ", raw, 0x100, 0x1300, 0)
    raw[0x200:0x200 + 13] = b"KERNEL32.dll\0"
    raw[0x300:0x300 + 17] = struct.pack("<H", 0) + b"CreateProcessW\0"
    raw[0x380:0x380 + len(STRINGS)] = STRINGS
    return headers.ljust(0x400, b"\0") + bytes(raw)


@pytest.mark.parametrize(("build", "fmt", "arch", "libraries", "notable"), [
    (macho, "mach-o", "arm64", ["/usr/lib/libSystem.B.dylib"], ["execve", "getaddrinfo"]),
    (elf, "elf", "arm64", ["libc.so.6"], ["execve", "socket"]),
    (pe, "pe", "x64", ["KERNEL32.dll"], ["CreateProcessW"]),
])
def test_each_format_reports_libraries_imports_and_classified_strings(build, fmt, arch, libraries, notable) -> None:
    facts = summarize_executable("backend/x", build())
    summary = facts.summary(100)
    assert (summary["format"], summary["arch"]) == (fmt, arch)
    assert summary["libraries"] == libraries
    assert summary["notableImports"] == notable
    assert summary["importCount"] == len(notable)
    assert (summary["packer"], summary["embeddedRuntime"]) == (None, None)
    assert facts.commands == {("git", "push", "remoteWrite")}
    assert facts.hosts == {"api.example.com": 1}
    assert facts.capabilities == {"fs.writeFile"}


def test_packers_and_embedded_runtimes_are_disclosed_as_unscannable() -> None:
    assert summarize_executable("b", macho(upx=True)).packer == "upx"
    assert summarize_executable("b", macho(extra=b"..._MEIPASS...")).embedded_runtime == "pyinstaller"
    assert summarize_executable("b", macho(extra=b"NODE_SEA_BLOB")).embedded_runtime == "node-sea"
    assert summarize_executable("b", macho(extra=b"---- Bun! ----")).embedded_runtime == "bun"


@pytest.mark.parametrize("data", [b"", b"\xcf\xfa\xed\xfe", macho()[:40], elf()[:70], pe()[:0x90], b"MZ" + b"\xff" * 100])
def test_truncated_or_hostile_executables_never_raise(data: bytes) -> None:
    summarize_executable("backend/x", data).summary(100)


def _backend_manifest() -> dict:
    manifest = contract_manifest("backend-declared-methods.json")
    manifest.update(id="acme.indexer", publisher="acme")
    manifest["engines"] = {"navide": f">={MIN_NAVIDE_FOR_THIRD_PARTY_BACKEND}"}
    return manifest


def test_report_lists_the_backend_with_source_backend() -> None:
    manifest = _backend_manifest()
    data = build_v2_package(manifest, backend_data=macho())
    report = scan_package(data, artifact_digest=hashlib.sha256(data).hexdigest(), target="darwin-arm64",
                          manifest=manifest)
    assert report is not None
    assert [n["path"] for n in report["native"]] == [manifest["backend"]["entry"]]
    assert {"executable": "git", "subcommand": "push", "category": "remoteWrite", "source": "backend",
            "evidence": "commandLikeString", "files": 1} in report["shell"]["calls"]
    assert {"host": "api.example.com", "source": "backend", "count": 1} in report["network"]["hosts"]
    assert {"address": "fs.writeFile", "source": "backend"} in report["capabilities"]
    assert "token=x" not in json.dumps(report)
    keys = [s["key"] for s in disclosure_scan_contract.scan_sentences(report)]
    assert "native.summary" in keys and "native.unscannable" not in keys
    disclosure_contract.canonical_contract_json(report)


def test_a_packed_backend_makes_the_scan_incomplete_and_at_least_high() -> None:
    manifest = _backend_manifest()
    data = build_v2_package(manifest, backend_data=macho(upx=True))
    report = scan_package(data, artifact_digest="a" * 64, target="darwin-arm64", manifest=manifest)
    keys = [s["key"] for s in disclosure_scan_contract.scan_sentences(report)]
    assert "native.unscannable" in keys and "coverage.incomplete" in keys
    disclosure = disclosure_contract.compute_disclosure(manifest)
    assert disclosure_scan_contract.card_risk_level(disclosure, report) in ("high", "highest")


def _publish_signed(env: SignedEnv, package: bytes, target: str):
    return env.client.post(
        "/api/publish",
        params={"signature": env.sign(hashlib.sha256(package).hexdigest()), "target": target},
        files={"package": ("plugin.vsix", package, "application/zip")},
        headers={"Authorization": f"Bearer {env.token}"},
    )


def test_publishing_a_backend_package_signs_its_scan(signed_env: SignedEnv) -> None:
    package = build_v2_package(_backend_manifest(), backend_data=macho())
    assert _publish_signed(signed_env, package, "darwin-arm64").status_code == 201
    version = signed_env.client.get("/api/extensions/acme/indexer").json()["versions"][0]
    assert version["scan"]["native"][0]["format"] == "mach-o"
    digest = hashlib.sha256(disclosure_contract.canonical_contract_json(version["scan"]).encode("ascii")).hexdigest()
    assert version["disclosure_envelope"]["scanDigest"] == digest
