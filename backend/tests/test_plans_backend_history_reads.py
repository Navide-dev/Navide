"""Reading a version in the Plans backend: bounded, cached, one descriptor.

A version is decompressed with a ceiling, so a planted gzip bomb fails
instead of exhausting memory, without limiting how large a plan may be; the
last version read is kept so paging through it decompresses it once; and its
bytes and mtime come from the same open file.
"""

from __future__ import annotations

import gzip
import importlib.util
import os
from pathlib import Path

import pytest

ENTRY = Path(__file__).resolve().parents[2] / "plugins" / "navide-plans" / "backend" / "plans_backend.py"
_spec = importlib.util.spec_from_file_location("plans_backend_history_reads", ENTRY)
assert _spec is not None and _spec.loader is not None
plans_backend = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(plans_backend)

NAME = "20261030T120000_draft.html.gz"


def _history(tmp_path: Path, data: bytes) -> tuple[Path, Path]:
    plan = tmp_path / "p_aaaaaa.html"
    plan.write_bytes(b"<p>current</p>")
    history = tmp_path / ".history" / "p_aaaaaa"
    history.mkdir(parents=True)
    (history / NAME).write_bytes(gzip.compress(data, mtime=0))
    return plan, history


def test_a_version_larger_than_the_ceiling_fails_instead_of_being_cut(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    plan, history = _history(tmp_path, b"\0" * 10_000)
    monkeypatch.setattr(plans_backend, "VERSION_READ_MIN_LIMIT", 1_000)
    with pytest.raises(plans_backend.BridgeFailure) as raised:
        plans_backend._read_version(history, NAME, plan)
    assert raised.value.code == "RESOURCE_LIMIT"


def test_the_ceiling_grows_with_the_plan_so_no_plan_size_is_refused(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    plan, history = _history(tmp_path, b"x" * 10_000)
    monkeypatch.setattr(plans_backend, "VERSION_READ_MIN_LIMIT", 1_000)
    plan.write_bytes(b"y" * 5_000)  # a version may be several times the current plan
    data, _mtime = plans_backend._read_version(history, NAME, plan)
    assert data == b"x" * 10_000


def test_paging_decompresses_a_version_once_and_again_after_it_changes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    plan, history = _history(tmp_path, b"first")
    calls: list[str] = []
    real = plans_backend.plan_versions.decode_version

    def counting(*args, **kwargs):
        calls.append(args[1])
        return real(*args, **kwargs)

    monkeypatch.setattr(plans_backend.plan_versions, "decode_version", counting)
    assert plans_backend._read_version(history, NAME, plan)[0] == b"first"
    assert plans_backend._read_version(history, NAME, plan)[0] == b"first"
    assert len(calls) == 1
    (history / NAME).write_bytes(gzip.compress(b"second", mtime=0))
    os.utime(history / NAME, ns=(1, 2_000_000_000_000_000_000))
    assert plans_backend._read_version(history, NAME, plan)[0] == b"second"
    assert len(calls) == 2


def test_bytes_and_mtime_come_from_the_file_opened_and_a_link_is_refused(tmp_path: Path) -> None:
    plan, history = _history(tmp_path, b"text")
    os.utime(history / NAME, ns=(1, 1_700_000_000_000_000_000))
    data, mtime = plans_backend._read_version(history, NAME, plan)
    assert data == b"text" and mtime == 1_700_000_000.0
    other = tmp_path / "elsewhere.gz"
    other.write_bytes(gzip.compress(b"outside", mtime=0))
    link = history / "20261030T120001_draft.html.gz"
    link.symlink_to(other)
    with pytest.raises(plans_backend.BridgeFailure):
        plans_backend._read_version(history, link.name, plan)
