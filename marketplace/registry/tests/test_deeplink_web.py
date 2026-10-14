"""The detail page's "Install in Navide" deep link and its fallback (Phase 3)."""

from __future__ import annotations

import copy
import re

import pytest

from fastapi.testclient import TestClient

from tests.fixtures import build_package, build_v2_package, contract_manifest, valid_manifest
from tests.test_root_path import PREFIX, _publish as _publish_prefixed
from tests.test_root_path import prefixed  # noqa: F401  (fixture)


def _publish(client: TestClient, ident: str = "acme.hello") -> None:
    ns, _ = ident.split(".", 1)
    manifest = valid_manifest(id=ident, publisher=ns)
    resp = client.post(
        "/api/publish",
        files={"package": ("pkg.vsix", build_package(manifest=manifest), "application/zip")},
    )
    assert resp.status_code == 201, resp.text


def test_detail_has_install_in_navide_button_and_copyable_link(client: TestClient) -> None:
    _publish(client)
    html = client.get("/extensions/acme/hello").text
    assert '<a class="install-button" href="navide://extension/acme.hello">' in html
    assert "Install in Navide" in html
    # The same link, shown in plain text for copying.
    assert '<code class="deeplink" title="Select to copy">navide://extension/acme.hello</code>' in html
    # The page promises the app only opens, never installs straight away.
    assert "nothing" in html and "installed until you confirm there" in html


def test_deep_link_is_exactly_the_one_form_the_app_accepts(client: TestClient) -> None:
    _publish(client, "acme-tools.multi-part")
    html = client.get("/extensions/acme-tools/multi-part").text
    links = re.findall(r"navide://[^\"<\s]*", html)
    assert links and set(links) == {"navide://extension/acme-tools.multi-part"}


def test_detail_has_fallback_with_download_and_manual_steps(client: TestClient) -> None:
    _publish(client)
    html = client.get("/extensions/acme/hello").text
    fallback = html[html.index('<details class="install-fallback">') : html.index("</details>")]
    assert "Navide may not be installed" in fallback
    assert '<a href="https://navide.dev">Download Navide</a>' in fallback
    assert "Settings → Marketplace" in fallback
    assert "<code>acme.hello</code>" in fallback


def test_no_script_is_added_to_the_page(client: TestClient) -> None:
    _publish(client)
    html = client.get("/extensions/acme/hello").text
    assert "<script" not in html
    assert not re.search(r"\son[a-z]+=", html)


def test_deep_link_and_fallback_under_root_path(prefixed: TestClient) -> None:  # noqa: F811
    _publish_prefixed(prefixed)
    detail = prefixed.get(f"{PREFIX}/extensions/acme/hello")
    assert detail.status_code == 200
    html = detail.text
    # The app link is not a path, so the prefix must not be glued onto it.
    assert 'href="navide://extension/acme.hello"' in html
    assert f"{PREFIX}/navide:" not in html and "navide://extension/registry" not in html
    assert '<a href="https://navide.dev">Download Navide</a>' in html
    # Every root-relative link still stays under the prefix.
    for url in re.findall(r'(?:href|src|action)="(/[^"]*)"', html):
        assert url.startswith(f"{PREFIX}/"), url
    css = prefixed.get(f"{PREFIX}/static/style.css").text
    assert ".install-button" in css and ".install-fallback" in css


def _publish_manifest(client: TestClient, path: str, **manifest_kw) -> None:
    resp = client.post(
        path,
        files={
            "package": (
                "pkg.vsix",
                build_package(manifest=valid_manifest(**manifest_kw)),
                "application/zip",
            )
        },
    )
    assert resp.status_code == 201, resp.text


def _publish_v2(client: TestClient, version: str, **fields) -> None:
    # v1 manifests cannot carry a pre-release version; v2 ones can.
    manifest = copy.deepcopy(contract_manifest())
    manifest.update(id="acme.files", publisher="acme", version=version, **fields)
    resp = client.post(
        f"{PREFIX}/api/publish",
        files={"package": ("pkg.vsix", build_v2_package(manifest), "application/zip")},
    )
    assert resp.status_code == 201, resp.text


def _versions_table(html: str) -> str:
    return html[html.index('<table class="version-table">') : html.index("</table>")]


def test_versions_table_has_channel_column_under_root_path(prefixed: TestClient) -> None:  # noqa: F811
    _publish_v2(prefixed, "2.1.0")
    _publish_v2(prefixed, "2.2.0-beta.1")
    table = _versions_table(prefixed.get(f"{PREFIX}/extensions/acme/files").text)
    assert "<th>Channel</th>" in table
    rows = table.split("<tr")[2:]  # skip the header row
    beta = next(r for r in rows if "<td>2.2.0-beta.1" in r)
    stable = next(r for r in rows if "<td>2.1.0" in r)
    assert '<span class="badge badge-prerelease">pre-release</span>' in beta
    assert "badge-prerelease" not in stable
    assert '<span class="channel-stable">stable</span>' in stable


def test_requires_navide_shown_on_detail_and_cards_under_root_path(prefixed: TestClient) -> None:  # noqa: F811
    publish = f"{PREFIX}/api/publish"
    _publish_manifest(prefixed, publish, engines={"navide": ">=0.2.9"})
    requires = '<span class="requires" title="engines.navide: &gt;=0.2.9">Requires Navide ≥ 0.2.9</span>'
    detail = prefixed.get(f"{PREFIX}/extensions/acme/hello").text
    assert requires in detail
    home = prefixed.get(f"{PREFIX}/").text
    assert requires in home
    search = prefixed.get(f"{PREFIX}/", params={"q": "greeter"}).text
    assert requires in search


def test_requires_navide_hidden_without_a_readable_minimum(prefixed: TestClient) -> None:  # noqa: F811
    publish = f"{PREFIX}/api/publish"
    _publish_manifest(prefixed, publish, id="acme.any", engines={"navide": "*"})
    _publish_manifest(prefixed, publish, id="acme.odd", engines={"navide": "<1.0.0"})
    for name in ("any", "odd"):
        assert "Requires Navide" not in prefixed.get(f"{PREFIX}/extensions/acme/{name}").text
    assert "Requires Navide" not in prefixed.get(f"{PREFIX}/").text


def test_requires_navide_hidden_at_or_below_0_1_0(prefixed: TestClient) -> None:  # noqa: F811
    # Every installable Navide meets these, so the line said nothing on every card.
    publish = f"{PREFIX}/api/publish"
    _publish_manifest(prefixed, publish, id="acme.floor", engines={"navide": ">=0.1.0"})
    _publish_manifest(prefixed, publish, id="acme.older", engines={"navide": ">=0.0.5"})
    _publish_manifest(prefixed, publish, id="acme.newer", engines={"navide": ">=0.1.1"})
    for name in ("floor", "older"):
        assert "Requires Navide" not in prefixed.get(f"{PREFIX}/extensions/acme/{name}").text
    assert "Requires Navide ≥ 0.1.1" in prefixed.get(f"{PREFIX}/extensions/acme/newer").text
    home = prefixed.get(f"{PREFIX}/").text
    assert home.count("Requires Navide") == 1
    assert "Requires Navide ≥ 0.1.1" in home


def test_requires_navide_follows_the_stable_latest_version(prefixed: TestClient) -> None:  # noqa: F811
    _publish_v2(prefixed, "1.0.0", engines={"navide": "^0.2.0"})
    _publish_v2(prefixed, "1.1.0-beta.1", engines={"navide": "^0.3.0"})
    detail = prefixed.get(f"{PREFIX}/extensions/acme/files").text
    assert "Requires Navide ≥ 0.2.0" in detail
    assert "Requires Navide ≥ 0.3.0" not in detail


def test_detail_shows_platform_chips_like_the_cards_under_root_path(prefixed: TestClient) -> None:  # noqa: F811
    from tests.test_multi_target import MACHO_ARM64, _backend_package

    _publish_prefixed(prefixed)
    universal = prefixed.get(f"{PREFIX}/extensions/acme/hello").text
    targets = universal[universal.index('<div class="detail-targets"') :]
    assert targets.index('<span class="chip chip-target">All platforms</span>') < targets.index("</div>")

    resp = prefixed.post(
        f"{PREFIX}/api/publish",
        files={"package": ("pkg.vsix", _backend_package(MACHO_ARM64), "application/zip")},
        params={"target": "darwin-arm64"},
    )
    assert resp.status_code == 201, resp.text
    native = prefixed.get(f"{PREFIX}/extensions/navide/skills").text
    assert '<div class="detail-targets" title="Platforms v1.0.0 is published for">' in native
    assert '<span class="chip chip-target">darwin-arm64</span>' in native
    assert "All platforms" not in native


def _icon_boxes(html: str) -> list[str]:
    return re.findall(r'<div class="ext-icon[^"]*" aria-hidden="true">.*?</div>', html, re.S)


def test_icon_box_with_initial_on_detail_and_cards_under_root_path(prefixed: TestClient) -> None:  # noqa: F811
    _publish_prefixed(prefixed)
    src = f'src="{PREFIX}/extensions/acme/hello/1.0.0/assets/icon.png"'
    for html in (
        prefixed.get(f"{PREFIX}/extensions/acme/hello").text,
        prefixed.get(f"{PREFIX}/").text,
    ):
        boxes = _icon_boxes(html)
        assert boxes
        for box in boxes:
            assert '<span class="ext-icon-initial">H</span>' in box
            # An empty alt: a broken icon has no text to spill out of the box.
            assert 'alt=""' in box and 'data-initial="H"' in box and src in box
    css = prefixed.get(f"{PREFIX}/static/style.css").text
    rule = css[css.index(".ext-icon {") :]
    rule = rule[: rule.index("}")]
    assert "overflow: hidden" in rule and "width: 36px" in rule and "height: 36px" in rule
    assert ".ext-icon-img::after" in css and "content: attr(data-initial)" in css
    assert ".detail-icon" not in css


@pytest.mark.parametrize(
    ("icon", "extra_files"),
    [
        (None, {}),  # no icon declared
        ("icon.svg", {"icon.svg": b"<svg xmlns='http://www.w3.org/2000/svg'/>"}),  # not servable
    ],
)
def test_missing_or_unservable_icon_falls_back_to_the_initial_only(
    prefixed: TestClient,  # noqa: F811
    icon: str | None,
    extra_files: dict[str, bytes],
) -> None:
    # No image tag at all when there is nothing the asset route would serve,
    # so nothing can render broken.
    manifest = valid_manifest()
    if icon is None:
        manifest.pop("icon")
    else:
        manifest["icon"] = icon
    resp = prefixed.post(
        f"{PREFIX}/api/publish",
        files={
            "package": (
                "pkg.vsix",
                build_package(manifest=manifest, include_icon=False, extra_files=extra_files),
                "application/zip",
            )
        },
    )
    assert resp.status_code == 201, resp.text
    for html in (
        prefixed.get(f"{PREFIX}/extensions/acme/hello").text,
        prefixed.get(f"{PREFIX}/").text,
    ):
        boxes = _icon_boxes(html)
        assert boxes and all("<img" not in b for b in boxes)
        assert all('<span class="ext-icon-initial">H</span>' in b for b in boxes)
        assert "/assets/icon." not in html


def test_icon_markup_stays_script_free(prefixed: TestClient) -> None:  # noqa: F811
    _publish_prefixed(prefixed)
    for html in (
        prefixed.get(f"{PREFIX}/extensions/acme/hello").text,
        prefixed.get(f"{PREFIX}/").text,
    ):
        assert "<script" not in html and "onerror" not in html


def test_direct_downloads_are_real_links_under_root_path(prefixed: TestClient) -> None:  # noqa: F811
    from tests.test_multi_target import MACHO_ARM64, _backend_package

    _publish_prefixed(prefixed)
    universal_url = f"{PREFIX}/api/extensions/acme/hello/1.0.0/download"
    html = prefixed.get(f"{PREFIX}/extensions/acme/hello").text
    assert f'<a class="download-link" href="{universal_url}">⬇ All platforms</a>' in html
    assert f"GET {universal_url}" in html  # the API call stays as secondary text
    assert "<pre" not in html[html.index('<section class="install">') : html.index("</section>")]
    assert prefixed.get(universal_url).status_code == 200

    resp = prefixed.post(
        f"{PREFIX}/api/publish",
        files={"package": ("pkg.vsix", _backend_package(MACHO_ARM64), "application/zip")},
        params={"target": "darwin-arm64"},
    )
    assert resp.status_code == 201, resp.text
    native_url = f"{PREFIX}/api/extensions/navide/skills/1.0.0/download?target=darwin-arm64"
    native = prefixed.get(f"{PREFIX}/extensions/navide/skills").text
    assert f'<a class="download-link" href="{native_url}">⬇ darwin-arm64</a>' in native
    assert prefixed.get(native_url).status_code == 200
    # Every root-relative link, downloads included, stays under the prefix.
    for url in re.findall(r'(?:href|src|action)="(/[^"]*)"', native):
        assert url.startswith(f"{PREFIX}/"), url
    assert "<script" not in native


def test_category_chips_show_display_names_under_root_path(prefixed: TestClient) -> None:  # noqa: F811
    from registry.discovery import CATEGORIES

    publish = f"{PREFIX}/api/publish"
    _publish_manifest(
        prefixed,
        publish,
        categories=["productivity", "version-control", "Extension-Packs", "custom-thing"],
    )
    labels = dict(CATEGORIES)
    detail = prefixed.get(f"{PREFIX}/extensions/acme/hello").text
    cats = detail[detail.index('<div class="detail-cats">') :]
    cats = cats[: cats.index("</div>")]
    home = prefixed.get(f"{PREFIX}/").text
    search = prefixed.get(f"{PREFIX}/", params={"q": "greeter"}).text
    for html in (cats, home, search):
        assert f'<span class="chip">{labels["productivity"]}</span>' in html
        assert '<span class="chip">Version control</span>' in html
        # Matched case-insensitively, like the category filter.
        assert f'<span class="chip">{labels["extension-packs"]}</span>' in html
        # A slug outside the closed list is shown as-is.
        assert '<span class="chip">custom-thing</span>' in html
        assert '<span class="chip">version-control</span>' not in html
    # The category filter links carry the slug and show the label.
    assert re.search(r'href="[^"]*category=version-control[^"]*">Version control</a>', home)
