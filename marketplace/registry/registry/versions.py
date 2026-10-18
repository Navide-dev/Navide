"""SemVer 2.0.0 parsing and ordering helpers."""

from __future__ import annotations

import re
from dataclasses import dataclass
from functools import total_ordering


_V2_VERSION_RE = re.compile(
    r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)"
    r"(?:-((?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)"
    r"(?:\.(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*))?"
    r"(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$"
)
_LEGACY_NUMERIC_VERSION_RE = re.compile(r"[0-9]+\.[0-9]+\.[0-9]+")
_NUMERIC_IDENTIFIER_RE = re.compile(r"[0-9]+")


@dataclass(frozen=True)
class _ParsedSemVer:
    core: tuple[str, str, str]
    prerelease: tuple[str, ...]


def _parse_semver(version: str) -> _ParsedSemVer:
    match = _V2_VERSION_RE.fullmatch(version)
    if match is not None:
        return _ParsedSemVer(
            core=(match.group(1), match.group(2), match.group(3)),
            prerelease=tuple(match.group(4).split(".")) if match.group(4) else (),
        )

    # Legacy v1 accepted leading zeroes in numeric MAJOR.MINOR.PATCH values.
    # Keep existing registry rows orderable without relaxing the v2 parser.
    legacy_match = _LEGACY_NUMERIC_VERSION_RE.fullmatch(version)
    if legacy_match is not None:
        parts = [
            part.lstrip("0") or "0" for part in legacy_match.group().split(".")
        ]
        return _ParsedSemVer(core=(parts[0], parts[1], parts[2]), prerelease=())

    raise ValueError(f"invalid SemVer 2.0.0: {version!r}")


def _compare_numeric_identifiers(left: str, right: str) -> int:
    if len(left) != len(right):
        return -1 if len(left) < len(right) else 1
    if left == right:
        return 0
    return -1 if left < right else 1


def _compare_identifiers(left: str, right: str) -> int:
    if left == right:
        return 0
    left_numeric = _NUMERIC_IDENTIFIER_RE.fullmatch(left) is not None
    right_numeric = _NUMERIC_IDENTIFIER_RE.fullmatch(right) is not None
    if left_numeric and right_numeric:
        return _compare_numeric_identifiers(left, right)
    if left_numeric != right_numeric:
        return -1 if left_numeric else 1
    return -1 if left < right else 1


def _compare_parsed(left: _ParsedSemVer, right: _ParsedSemVer) -> int:
    for left_identifier, right_identifier in zip(left.core, right.core):
        result = _compare_numeric_identifiers(left_identifier, right_identifier)
        if result != 0:
            return result

    if not left.prerelease or not right.prerelease:
        if len(left.prerelease) == len(right.prerelease):
            return 0
        return -1 if left.prerelease else 1

    for left_identifier, right_identifier in zip(left.prerelease, right.prerelease):
        result = _compare_identifiers(left_identifier, right_identifier)
        if result != 0:
            return result
    if len(left.prerelease) == len(right.prerelease):
        return 0
    return -1 if len(left.prerelease) < len(right.prerelease) else 1


def compare_semver(left: str, right: str) -> int:
    """Compare registry versions by SemVer precedence, ignoring build metadata."""
    return _compare_parsed(_parse_semver(left), _parse_semver(right))


@total_ordering
@dataclass(frozen=True)
class _SemVerKey:
    parsed: _ParsedSemVer

    def __lt__(self, other: object) -> bool:
        if not isinstance(other, _SemVerKey):
            return NotImplemented
        return _compare_parsed(self.parsed, other.parsed) < 0


def version_key(version: str) -> _SemVerKey:
    """Return a SemVer precedence key for a validated manifest version."""
    return _SemVerKey(_parse_semver(version))


def latest_version(versions: list[str]) -> str | None:
    """Return the highest SemVer, or None for an empty list."""
    if not versions:
        return None
    return max(versions, key=version_key)


STABLE_CHANNEL = "stable"
PRERELEASE_CHANNEL = "pre-release"
TESTPLACE_CHANNEL = "testplace"
"""Invite-only test builds (0.2.27). Never derived from the version: a row is
testplace only when stored so, and every public read excludes it."""
VERSION_CHANNELS = (STABLE_CHANNEL, PRERELEASE_CHANNEL, TESTPLACE_CHANNEL)
TESTPLACE_VALIDITY_DAYS = 90
"""How long a testplace version stays installable (D4, like TestFlight)."""


def version_channel(version: str) -> str:
    """A version with a SemVer prerelease suffix (`2.5.0-beta.1`) is a
    pre-release; build metadata alone does not make one."""
    return PRERELEASE_CHANNEL if _parse_semver(version).prerelease else STABLE_CHANNEL


def latest_stable_version(versions: list[str]) -> str | None:
    """The newest stable version; the newest pre-release only when there is no
    stable version at all, so a pre-release-only extension stays listable."""
    stable = [v for v in versions if version_channel(v) == STABLE_CHANNEL]
    return latest_version(stable) or latest_version(versions)


def latest_prerelease_version(versions: list[str]) -> str | None:
    """The newest pre-release when it is newer than every stable version."""
    newest = latest_version(versions)
    if newest is None or version_channel(newest) != PRERELEASE_CHANNEL:
        return None
    return newest
