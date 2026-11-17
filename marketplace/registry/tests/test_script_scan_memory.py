"""Scanning a large script bundle must not hold it several times over (0.2.44).

A Plans package's 10.9 MB `index.js` contains a few emoji. Read whole and
decoded, it became a 4-byte-per-character string, and decoding reached about
six times the file size on the heap before the scan started (on top of the
raw bytes): the production Registry's resident memory doubled during one
publish. The scan now decodes in chunks and narrows characters above U+FFFF,
so these tests bound the peak and check that the report is unchanged.
"""

from __future__ import annotations

import random
import tracemalloc
import zipfile
from pathlib import Path

from registry.static_scan.js_scan import scan_script
from registry.static_scan.js_tokens import AstralChars, narrow_script
from registry.static_scan.report import _redacted, scan_package
from tests.fixtures import contract_manifest

BUNDLE = "frontend/assets/index.js"
BUNDLE_SIZE = 8 * 1024 * 1024


def _frozen() -> float:
    """A clock that never advances, so tracing overhead cannot time the scan out."""
    return 0.0


def _bundle(size: int) -> bytes:
    """Minified-looking JavaScript with CJK text and sparse emoji, like a real bundle."""
    rng = random.Random(7)
    parts: list[bytes] = []
    total = 0
    index = 0
    while total < size:
        index += 1
        name = "".join(rng.choice("abcdefghijklmnopqrstuvwxyz") for _ in range(rng.randint(1, 6)))
        if index % 50 == 0:
            line = f'const {name}{index}="計畫 \U0001f9e9 {name}";'
        elif index % 3 == 0:
            line = f'const {name}{index}="label → {name}";'
        else:
            line = f"function {name}(e,t){{return e.{name}?t[{index}]:null}}"
        data = line.encode()
        parts.append(data)
        total += len(data)
    return b"".join(parts)[:size]


def _package(path: Path) -> dict:
    manifest = contract_manifest("frontend-web.json")
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("manifest.json", "{}")
        zf.writestr(BUNDLE, _bundle(BUNDLE_SIZE))
    return manifest


def test_scanning_a_large_bundle_keeps_the_heap_near_its_size(tmp_path: Path) -> None:
    package = tmp_path / "bundle.vsix"
    manifest = _package(package)

    tracemalloc.start()
    try:
        tracemalloc.reset_peak()
        with package.open("rb") as fp:
            report = scan_package(fp, artifact_digest="a" * 64, target="universal", manifest=manifest, clock=_frozen)
        peak = tracemalloc.get_traced_memory()[1]
    finally:
        tracemalloc.stop()
    print(f"scan of a {BUNDLE_SIZE / 2**20:.0f} MiB bundle: peak traced heap {peak / 2**20:.1f} MiB")

    assert report is not None
    assert report["coverage"]["filesScanned"] == 1
    assert report["coverage"]["bytesScanned"] == BUNDLE_SIZE
    assert not report["coverage"]["timedOut"] and not report["coverage"]["truncated"]
    # Before: the raw bytes plus a UCS-4 decode, 7x the bundle size (56 MiB).
    # Now the chunks and the joined 2-byte text, about 4x (CJK keeps it 2-byte).
    assert peak < 5 * BUNDLE_SIZE


SOURCE = (
    'const a = "\U0001f9e9 https://api.example.com/x";\n'
    "// comment \U0001f600 shell.run\n"
    "let b = `\U0001f680 ${x} https://cdn.example.org/y`; const r = /\U0001f9e9+/gu;\n"
    'run("shell.run", { command: "git status" }); /* \U0001f9e9 */ \U0001f9e9 fetch("https://after.example.net/z");\n'
    'const c = "\\u{1F9E9}\\x41 \U0001f9e9"; const d = `\U0001f9e9`;\n'
    # Bundles carry raw control characters; one is the placeholder itself.
    'const t = "\x01\x02\U0001f9e9\x01"; \x01 \U0001f9e9 g("https://ctl.example.com/\x01");\n'
    + "\U0001f9e9" * 200
    + ' const e = "https://far.example.com/\U0001f9e9";\n'
)


def _facts(text: str, astral: AstralChars | None):
    return scan_script(text, max_path_length=4096, redacted=_redacted, astral=astral)


def test_narrowed_scan_matches_the_wide_scan() -> None:
    narrowed = narrow_script([SOURCE.encode()[i : i + 7] for i in range(0, len(SOURCE.encode()), 7)])
    assert narrowed is not None
    text, astral = narrowed
    assert len(text) == len(SOURCE) and max(text) <= "\uffff"
    assert astral.restore(text, 0, len(text)) == SOURCE

    wide = _facts(SOURCE, None)
    narrow = _facts(text, astral)
    assert narrow == wide
    assert wide.hosts and wide.sites


def test_narrowing_falls_back_when_it_cannot_represent_the_script() -> None:
    # An astral digit, which the tokenizer reads as a number.
    assert narrow_script(["x = \U0001d7ce;".encode()]) is None
    # A script dense with emoji: recording them would cost more than a wide text.
    dense = ("\U0001f9e9" + "x" * 6).encode() * 20_000
    assert narrow_script([dense[i : i + 65536] for i in range(0, len(dense), 65536)]) is None
    sparse = ("\U0001f9e9" + "x" * 8).encode() * 20_000
    assert narrow_script([sparse[i : i + 65536] for i in range(0, len(sparse), 65536)]) is not None
    # A character cut by the byte limit becomes U+FFFD, as with bytes.decode.
    cut = "ab\U0001f9e9".encode()[:-1]
    narrowed = narrow_script([cut[:3], cut[3:]])
    assert narrowed is not None and narrowed[0] == cut.decode("utf-8", "replace")
