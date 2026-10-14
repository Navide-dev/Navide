"""Promoting a plain HTML document keeps its <!DOCTYPE> first.

_write_plan_meta used to prepend the plan-meta island to a document that had
none, pushing the doctype behind a <script>. Browsers ignore a doctype that is
not first, so the promoted file rendered in quirks mode when opened from disk.
The reference implementation (usePlanHtml.injectPlanMeta) inserts before
</head>, then after <html>, and only prepends as a last resort.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

ENTRY = Path(__file__).resolve().parents[2] / "plugins" / "navide-plans" / "backend" / "plans_backend.py"
_spec = importlib.util.spec_from_file_location("plans_backend_promote_doctype", ENTRY)
assert _spec and _spec.loader
plans_backend = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(plans_backend)

META = {"schemaVersion": 1, "name": "Audit"}


def test_island_goes_before_head_close_and_doctype_stays_first() -> None:
    html = "<!DOCTYPE html>\n<html>\n<head>\n<title>Audit</title>\n</head>\n<body>x</body>\n</html>\n"
    out = plans_backend._write_plan_meta(html, META)
    assert out.startswith("<!DOCTYPE html>")
    assert out.index('id="plan-meta"') < out.index("</head>")
    assert plans_backend.PLAN_META_RE.search(out) is not None


def test_island_goes_after_html_open_when_there_is_no_head() -> None:
    html = "<!doctype html>\n<html lang=\"en\"><body>x</body></html>"
    out = plans_backend._write_plan_meta(html, META)
    assert out.startswith("<!doctype html>")
    assert out.index('<html lang="en">') < out.index('id="plan-meta"') < out.index("<body>")


def test_a_fragment_without_html_or_head_is_still_prepended() -> None:
    out = plans_backend._write_plan_meta("<p>x</p>", META)
    assert out.startswith('<script type="application/json" id="plan-meta">')


def test_an_existing_island_is_replaced_in_place() -> None:
    html = '<!DOCTYPE html><head><script type="application/json" id="plan-meta">\n{}\n</script></head>'
    out = plans_backend._write_plan_meta(html, META)
    assert out.startswith("<!DOCTYPE html><head>")
    assert out.count('id="plan-meta"') == 1
    assert '"name": "Audit"' in out
