"""Session-log archive: selection never changes a file, every switch starts off,
compression is proven before an original can go, uploads are encrypted."""

from __future__ import annotations

import os
from pathlib import Path

import pytest
import zstandard

from agent_team_backend import session_archive
from agent_team_backend.db import Database
from agent_team_backend.session_archive import (
    ArchiveSettingsStore,
    archive_candidates,
    compress_log,
    s3_key,
    upload_archive,
)

NOW = 2_000_000_000.0
DAY = 86_400


def _log(path: Path, age_days: float, body: str = "{}\n") -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(body, encoding="utf-8")
    os.utime(path, (NOW - age_days * DAY, NOW - age_days * DAY))
    return path


def _snapshot(root: Path) -> dict[str, tuple[int, float, str]]:
    return {
        str(p): (p.stat().st_size, p.stat().st_mtime, p.read_text(encoding="utf-8"))
        for p in sorted(root.rglob("*")) if p.is_file()
    }


def test_only_logs_idle_long_enough_qualify_oldest_first(tmp_path: Path) -> None:
    old = _log(tmp_path / "-Users-me-a" / "old.jsonl", 30)
    week = _log(tmp_path / "-Users-me-a" / "week.jsonl", 7)
    _log(tmp_path / "-Users-me-a" / "fresh.jsonl", 6.9)
    _log(tmp_path / "-Users-me-a" / "notes.txt", 30)
    sub = _log(tmp_path / "-Users-me-b" / "s" / "subagents" / "agent-1.jsonl", 10)
    found = [c.path for c in archive_candidates([tmp_path], now=NOW)]
    assert found == [old, sub, week]


def test_open_and_already_archived_sessions_are_skipped(tmp_path: Path) -> None:
    _log(tmp_path / "p" / "bound.jsonl", 30)
    done = _log(tmp_path / "p" / "done.jsonl", 30)
    done.with_name("done.jsonl.zst").write_bytes(b"x")
    os.utime(done.with_name("done.jsonl.zst"), (NOW, NOW))
    keep = _log(tmp_path / "p" / "keep.jsonl", 30)
    found = archive_candidates([tmp_path], now=NOW, open_sessions=frozenset({"bound"}))
    assert [c.path for c in found] == [keep]
    assert found[0].size == 3


def test_selecting_changes_nothing_and_a_missing_root_is_empty(tmp_path: Path) -> None:
    _log(tmp_path / "p" / "a.jsonl", 30)
    before = _snapshot(tmp_path)
    archive_candidates([tmp_path, tmp_path / "missing"], now=NOW)
    assert _snapshot(tmp_path) == before
    assert archive_candidates([tmp_path / "missing"], now=NOW) == []


def test_every_switch_starts_off_and_bad_values_are_ignored(tmp_path: Path) -> None:
    store = ArchiveSettingsStore(Database(tmp_path / "navide.db"))
    assert store.get() == ArchiveSettingsStore.DEFAULTS
    assert not any(store.get()[k] for k in ("compress_enabled", "remove_originals", "upload_enabled"))
    saved = store.set({"compress_enabled": True, "idle_days": 0, "upload_after_days": 3,
                       "s3_bucket": 42, "aws_secret_access_key": "x"})
    assert saved["compress_enabled"] is True
    assert saved["idle_days"] == 1 and saved["upload_after_days"] == 3
    assert saved["s3_bucket"] == "" and "aws_secret_access_key" not in saved
    assert ArchiveSettingsStore(Database(tmp_path / "navide.db")).get() == saved


def test_compression_is_proven_and_keeps_the_original_by_default(tmp_path: Path) -> None:
    body = "".join(f'{{"n": {i}, "text": "建模"}}\n' for i in range(2000))
    log = _log(tmp_path / "p" / "s.jsonl", 30, body)
    done = compress_log(log)
    assert log.exists() and done.archive == log.with_name("s.jsonl.zst")
    assert not done.removed_original
    assert zstandard.ZstdDecompressor().decompressobj().decompress(done.archive.read_bytes()) == log.read_bytes()
    assert done.archive.stat().st_size < log.stat().st_size
    assert sorted(p.name for p in log.parent.iterdir()) == ["s.jsonl", "s.jsonl.zst"]
    assert not log.with_name("s.jsonl.zst.tmp").exists()
    assert archive_candidates([tmp_path], now=NOW) == []


def test_the_original_goes_only_when_asked_and_after_the_proof(tmp_path: Path) -> None:
    log = _log(tmp_path / "p" / "s.jsonl", 30, "{}\n" * 100)
    done = compress_log(log, remove_original=True)
    assert done.removed_original and not log.exists() and done.archive.exists()


def test_a_log_that_changes_while_compressed_is_left_alone(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    log = _log(tmp_path / "p" / "s.jsonl", 30, "{}\n" * 100)
    real = session_archive._file_chunks

    def grow(path: Path, size: int = 1 << 20):
        with path.open("a", encoding="utf-8") as fh:
            fh.write("{}\n")
        yield from real(path, size)

    monkeypatch.setattr(session_archive, "_file_chunks", grow)
    with pytest.raises(RuntimeError, match="changed"):
        compress_log(log, remove_original=True)
    assert log.exists()
    assert sorted(p.name for p in log.parent.iterdir()) == ["s.jsonl"]


class _S3:
    def __init__(self, stored_size: int | None = None) -> None:
        self.calls: list[tuple] = []
        self.stored_size = stored_size

    def upload_file(self, filename: str, bucket: str, key: str, ExtraArgs: dict) -> None:  # noqa: N803
        self.calls.append((filename, bucket, key, ExtraArgs))
        if self.stored_size is None:
            self.stored_size = Path(filename).stat().st_size

    def head_object(self, Bucket: str, Key: str) -> dict:  # noqa: N803
        return {"ContentLength": self.stored_size}


def test_upload_is_encrypted_keyed_under_the_prefix_and_confirmed(tmp_path: Path) -> None:
    archive = tmp_path / "-Users-me-a" / "s.jsonl.zst"
    archive.parent.mkdir()
    archive.write_bytes(b"zst")
    s3 = _S3()
    settings = {"s3_bucket": "nt-archive", "s3_prefix": "navide-sessions/"}
    key = upload_archive(archive, tmp_path, settings, client=s3)
    assert key == "navide-sessions/-Users-me-a/s.jsonl.zst"
    assert s3.calls == [(str(archive), "nt-archive", key, {"ServerSideEncryption": "AES256"})]
    assert s3_key("", archive, tmp_path) == "-Users-me-a/s.jsonl.zst"

    with pytest.raises(RuntimeError, match="does not match"):
        upload_archive(archive, tmp_path, settings, client=_S3(stored_size=1))
    with pytest.raises(ValueError, match="s3_bucket"):
        upload_archive(archive, tmp_path, {"s3_bucket": ""}, client=_S3())


def test_a_resumed_log_is_archived_again(tmp_path: Path) -> None:
    log = _log(tmp_path / "p" / "s.jsonl", 30, "{}\n" * 10)
    archive = compress_log(log).archive
    assert archive.stat().st_mtime == log.stat().st_mtime
    assert archive_candidates([tmp_path], now=NOW) == []
    _log(log, 20, "{}\n" * 20)  # resumed and written to, then idle again
    assert [c.path for c in archive_candidates([tmp_path], now=NOW)] == [log]


def test_a_pass_with_every_switch_off_touches_nothing(tmp_path: Path) -> None:
    _log(tmp_path / "p" / "s.jsonl", 60)
    before = _snapshot(tmp_path)
    s3 = _S3()
    counts = session_archive.run_once(
        ArchiveSettingsStore.DEFAULTS, [tmp_path], Database(tmp_path.parent / "off.db"),
        now=NOW, client=s3,
    )
    assert counts == {"compressed": 0, "uploaded": 0, "failed": 0}
    assert _snapshot(tmp_path) == before and s3.calls == []


def test_a_pass_compresses_then_uploads_each_old_archive_once(tmp_path: Path) -> None:
    root = tmp_path / "projects"
    old = _log(root / "p" / "old.jsonl", 40, "{}\n" * 50)
    _log(root / "p" / "week.jsonl", 10, "{}\n" * 50)
    _log(root / "p" / "open.jsonl", 40)
    db = Database(tmp_path / "navide.db")
    settings = {**ArchiveSettingsStore.DEFAULTS, "compress_enabled": True,
                "upload_enabled": True, "s3_bucket": "nt-archive"}
    s3 = _S3()
    counts = session_archive.run_once(settings, [root], db, now=NOW, client=s3,
                                      open_sessions=frozenset({"open"}))
    # Both idle logs are compressed; only the one past upload_after_days (30) goes up.
    assert counts == {"compressed": 2, "uploaded": 1, "failed": 0}
    assert [c[2] for c in s3.calls] == ["navide-sessions/p/old.jsonl.zst"]
    assert old.exists() and not (root / "p" / "open.jsonl.zst").exists()
    again = session_archive.run_once(settings, [root], db, now=NOW, client=s3,
                                     open_sessions=frozenset({"open"}))
    assert again == {"compressed": 0, "uploaded": 0, "failed": 0}
    assert len(s3.calls) == 1


def test_one_failing_upload_does_not_stop_the_pass(tmp_path: Path) -> None:
    root = tmp_path / "projects"
    for name in ("a", "b"):
        compress_log(_log(root / "p" / f"{name}.jsonl", 40, "{}\n" * 5))
    settings = {**ArchiveSettingsStore.DEFAULTS, "upload_enabled": True, "s3_bucket": "nt"}
    counts = session_archive.run_once(settings, [root], Database(tmp_path / "navide.db"),
                                      now=NOW, client=_S3(stored_size=1))
    assert counts == {"compressed": 0, "uploaded": 0, "failed": 2}
