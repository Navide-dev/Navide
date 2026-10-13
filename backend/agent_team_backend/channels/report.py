"""Report cards: the title and one-line summary a file goes out with.

A pane names them on its attach line, after the path, each part separated by `` | ``:
``---ATTACH--- /abs/report.html | title=Weekly report | summary=Three done, one late``.
A line without `` | `` is a bare path, as before; so is a whole line naming a file
that exists. Missing values come from the file: a plan document's plan-meta
``name`` / ``overview``, an HTML ``<title>`` / ``<meta name="description">``, and
otherwise the file name, with no summary.
"""

from __future__ import annotations

import dataclasses
import json
import os
import unicodedata
from dataclasses import dataclass
from html.parser import HTMLParser
from pathlib import Path

from . import media, redact

TITLE_MAX = 80
SUMMARY_MAX = 160
# How much of an HTML file is read for its defaults: plan-meta sits at the top.
HEAD_BYTES = 256 * 1024
SEPARATOR = " | "
# Why an HTML file went out as itself, not as a PDF.
FAILURES = ("no_host", "timeout", "not_pdf", "too_large", "budget", "source_too_large", "error")


@dataclass(frozen=True)
class AttachSpec:
    path: str
    title: str = ""
    summary: str = ""


def parse_attach(raw: str) -> AttachSpec:
    """One ``---ATTACH---`` line's text (after the marker) as a path plus card values."""
    raw = raw.strip()
    if SEPARATOR not in raw or os.path.exists(raw):
        return AttachSpec(raw)
    path, *parts = raw.split(SEPARATOR)
    values = {"title": "", "summary": ""}
    for part in parts:
        key, eq, value = part.partition("=")
        key = key.strip().lower()
        if eq and key in values:
            values[key] = value.strip()
    return AttachSpec(path.strip(), values["title"], values["summary"])


def clean(value: str, limit: int) -> str:
    """``value`` on one line, without control characters, redacted, cut to ``limit``."""
    text = "".join(" " if unicodedata.category(ch) == "Cc" else ch for ch in value or "")
    text = redact.redact_text(" ".join(text.split()))
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


@dataclass(frozen=True)
class Defaults:
    title: str
    summary: str
    stage: str = ""  # set for a plan document only
    todos_done: int = 0
    todos_total: int = 0


class _HeadParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.title = ""
        self.description = ""
        self.plan_meta = ""
        self._in: str = ""

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attr = {k.lower(): v or "" for k, v in attrs}
        if tag == "title" and not self.title:
            self._in = "title"
        elif tag == "script" and attr.get("id") == "plan-meta" and not self.plan_meta:
            self._in = "plan-meta"
        elif tag == "meta" and attr.get("name", "").lower() == "description" and not self.description:
            self.description = attr.get("content", "")

    def handle_endtag(self, tag: str) -> None:
        if tag in ("title", "script"):
            self._in = ""

    def handle_data(self, data: str) -> None:
        if self._in == "title":
            self.title += data
        elif self._in == "plan-meta":
            self.plan_meta += data


def defaults(name: str, head: str) -> Defaults:
    """The card values a file called ``name`` gets when the pane gave none; ``head`` is
    the start of an HTML file ("" for any other file)."""
    stem = Path(name).stem or name
    if not head:
        return Defaults(clean(stem, TITLE_MAX), "")
    parser = _HeadParser()
    try:
        parser.feed(head)
    except Exception:  # noqa: BLE001 — a malformed page still gets a card
        pass
    try:
        meta = json.loads(parser.plan_meta) if parser.plan_meta.strip() else None
    except ValueError:
        meta = None
    if isinstance(meta, dict) and str(meta.get("name") or "").strip():
        todos = [t for t in meta.get("todos") or [] if isinstance(t, dict)]
        return Defaults(clean(str(meta["name"]), TITLE_MAX), clean(str(meta.get("overview") or ""), SUMMARY_MAX),
                        str(meta.get("stage") or ""), sum(t.get("status") == "done" for t in todos), len(todos))
    return Defaults(clean(parser.title, TITLE_MAX) or clean(stem, TITLE_MAX), clean(parser.description, SUMMARY_MAX))


@dataclass(frozen=True)
class Card:
    title: str
    summary: str
    stage: str = ""
    todos_done: int = 0
    todos_total: int = 0
    kind: str = ""  # what went out: "pdf", "html", "png" ...
    size: int = 0
    pages: int = 0
    failure: str = ""  # one of FAILURES when an HTML file went out unconverted

    def sent_as(self, kind: str, size: int, pages: int = 0, failure: str = "") -> "Card":
        return dataclasses.replace(self, kind=kind, size=size, pages=pages, failure=failure)


def card_for(spec: AttachSpec, name: str, head: str) -> Card:
    """The card for one attachment: the pane's values first, then the file's defaults."""
    d = defaults(name, head)
    return Card(clean(spec.title, TITLE_MAX) or d.title, clean(spec.summary, SUMMARY_MAX) or d.summary,
                d.stage, d.todos_done, d.todos_total)


def info_line(card: Card, lang: str) -> str:
    """The card's last line: what it is and how big, or why the PDF is missing."""
    if card.failure:
        return media.text(lang, "card.pdf_failed", reason=media.text(lang, f"card.failure.{card.failure}"))
    parts: list[str] = []
    if card.stage:
        parts += ["Plan", card.stage]
        if card.todos_total:
            parts.append(media.text(lang, "card.todos", done=card.todos_done, total=card.todos_total))
    kind = card.kind.upper() or "FILE"
    parts.append(f"{kind} {media.text(lang, 'card.pages', n=card.pages)}" if card.pages else kind)
    parts.append(media.human_size(card.size))
    return " · ".join(parts)


@dataclass(frozen=True)
class Caption:
    """A card in the chat's language, for an adapter to lay out its own way."""

    title: str
    summary: str
    info: str

    def plain(self) -> str:
        return "\n".join(line for line in (f"📄 {self.title}", self.summary, self.info) if line)


def caption(card: Card, lang: str) -> Caption:
    return Caption(card.title, card.summary, info_line(card, lang))


def plain_text(card: Card, lang: str) -> str:
    """The card as plain lines: title, summary (when there is one), info."""
    return caption(card, lang).plain()
