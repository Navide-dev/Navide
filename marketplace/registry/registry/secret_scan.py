"""Secret scan of package contents (Phase 2 review check).

A finding records the archive path, the 1-based line and the rule name —
never the matched text. The report is shown to the publisher and the
reviewer, so echoing the value would leak it a second time.
"""

from __future__ import annotations

import re
import zipfile
from dataclasses import dataclass

from .package import READ_CHUNK, PackageSource, entry_buffer, open_source

MAX_SCANNED_BYTES_PER_FILE = 5 * 1024 * 1024
MAX_SCANNED_BYTES_PER_BACKEND = 512 * 1024 * 1024
"""A native backend executable is scanned whole, binary or not: bundled
interpreters embed source and config as plain bytes. The bound only stops a
decompression bomb; the archive itself is capped at 200 MiB."""
MAX_FINDINGS = 50

RULES: tuple[tuple[str, re.Pattern[bytes]], ...] = (
    ("AWS access key id", re.compile(rb"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b")),
    (
        "AWS secret access key",
        re.compile(rb"(?i)aws_?secret_?access_?key[\"'\s:=]+[A-Za-z0-9/+]{40}\b"),
    ),
    ("GitHub token", re.compile(rb"\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b")),
    ("Slack token", re.compile(rb"\bxox[abprs]-[A-Za-z0-9-]{10,}\b")),
    ("Google API key", re.compile(rb"\bAIza[0-9A-Za-z_-]{35}\b")),
    ("Stripe live key", re.compile(rb"\b[rs]k_live_[0-9A-Za-z]{24,}\b")),
    ("Anthropic API key", re.compile(rb"\bsk-ant-[A-Za-z0-9_-]{20,}")),
    ("OpenAI API key", re.compile(rb"\bsk-(?:proj-)?[A-Za-z0-9]{20}T3BlbkFJ[A-Za-z0-9]{20}\b|\bsk-proj-[A-Za-z0-9_-]{40,}")),
    ("npm token", re.compile(rb"\bnpm_[A-Za-z0-9]{36}\b")),
    (
        "private key block",
        re.compile(rb"-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----"),
    ),
)


@dataclass(frozen=True)
class SecretFinding:
    path: str
    line: int
    rule: str

    def as_dict(self) -> dict[str, object]:
        return {"path": self.path, "line": self.line, "rule": self.rule}


@dataclass(frozen=True)
class ScanReport:
    files_scanned: int
    findings: tuple[SecretFinding, ...]
    truncated: bool

    def as_dict(self) -> dict[str, object]:
        return {
            "files_scanned": self.files_scanned,
            "findings": [f.as_dict() for f in self.findings],
            "truncated": self.truncated,
        }


def _is_binary(data: bytes) -> bool:
    return b"\x00" in data[:8192]


def _count_newlines(data, end: int) -> int:
    """`data.count(b"\\n", 0, end)` for a buffer without `count` (mmap),
    counted a chunk at a time."""
    if isinstance(data, bytes):
        return data.count(b"\n", 0, end)
    return sum(data[start : min(start + READ_CHUNK, end)].count(b"\n") for start in range(0, end, READ_CHUNK))


def scan_bytes(path: str, data) -> list[SecretFinding]:
    """`data` is bytes or a read-only mapped entry (package.entry_buffer)."""
    findings: list[SecretFinding] = []
    for rule, pattern in RULES:
        for match in pattern.finditer(data):
            line = _count_newlines(data, match.start()) + 1
            findings.append(SecretFinding(path=path, line=line, rule=rule))
    return findings


def scan_package(data: PackageSource, *, backend_prefix: str | None = None) -> ScanReport:
    """Scan every non-binary member of a validated package archive, plus every
    member under `backend_prefix` in full whether binary or not."""
    findings: list[SecretFinding] = []
    scanned = 0
    truncated = False
    with zipfile.ZipFile(open_source(data)) as archive:
        for info in archive.infolist():
            if info.is_dir():
                continue
            backend = backend_prefix is not None and info.filename.startswith(backend_prefix)
            if backend:
                # Scanned whole, so mapped from a spool file, not read onto the heap.
                with entry_buffer(archive, info, MAX_SCANNED_BYTES_PER_BACKEND) as (content, cut):
                    truncated = truncated or cut
                    scanned += 1
                    findings.extend(scan_bytes(info.filename, content))
                continue
            with archive.open(info) as stream:
                content = stream.read(MAX_SCANNED_BYTES_PER_FILE + 1)
            if len(content) > MAX_SCANNED_BYTES_PER_FILE:
                truncated = True
                content = content[:MAX_SCANNED_BYTES_PER_FILE]
            if _is_binary(content):
                continue
            scanned += 1
            findings.extend(scan_bytes(info.filename, content))
    findings.sort(key=lambda f: (f.path, f.line, f.rule))
    if len(findings) > MAX_FINDINGS:
        findings = findings[:MAX_FINDINGS]
        truncated = True
    return ScanReport(files_scanned=scanned, findings=tuple(findings), truncated=truncated)
