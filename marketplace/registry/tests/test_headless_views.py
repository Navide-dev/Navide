"""Views that declare ``headless: true`` (0.2.40): the manifest accepts the key
on views that can be mounted hidden, and publishing a package that declares
it without requiring Navide >=0.2.40 gets a notice, never a refusal."""

from __future__ import annotations

import copy
import json
from pathlib import Path

import pytest

from registry.headless_views import HEADLESS_ENGINES_NOTICE, headless_view_notices
from registry.manifest import ManifestError, parse_manifest

FIXTURES = Path(__file__).resolve().parents[3] / "docs" / "plugin-contracts" / "fixtures"
VALID = json.loads((FIXTURES / "valid" / "headless-view.json").read_text("utf-8"))


def _with(**changes: object) -> dict:
    manifest = copy.deepcopy(VALID)
    manifest.update(changes)
    return manifest


def test_a_left_view_may_declare_headless() -> None:
    manifest = parse_manifest(VALID)
    assert manifest.contributes.views[0].headless is True


@pytest.mark.parametrize("location", ["window", "detail"])
def test_a_window_or_detail_view_may_not(location: str) -> None:
    manifest = copy.deepcopy(VALID)
    manifest["contributes"]["views"][0]["location"] = location
    with pytest.raises(ManifestError, match="headless"):
        parse_manifest(manifest)


def test_headless_must_be_a_boolean() -> None:
    manifest = copy.deepcopy(VALID)
    manifest["contributes"]["views"][0]["headless"] = "yes"
    with pytest.raises(ManifestError):
        parse_manifest(manifest)


def test_no_notice_when_engines_requires_0_2_40() -> None:
    assert headless_view_notices(parse_manifest(VALID)) == []


@pytest.mark.parametrize("engines", [None, {"navide": ">=0.2.39"}])
def test_a_notice_when_an_older_navide_is_allowed(engines: dict | None) -> None:
    manifest = _with(engines=engines) if engines else {k: v for k, v in VALID.items() if k != "engines"}
    assert headless_view_notices(parse_manifest(manifest)) == [HEADLESS_ENGINES_NOTICE]


def test_no_notice_without_a_headless_view() -> None:
    manifest = copy.deepcopy(VALID)
    manifest["contributes"]["views"][0]["headless"] = False
    del manifest["engines"]
    assert headless_view_notices(parse_manifest(manifest)) == []
