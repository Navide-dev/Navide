"""What a chat is told about a pane that is not online, in the Navide language."""

from __future__ import annotations

from typing import Any

STRINGS: dict[str, dict[str, str]] = {
    "zh-TW": {
        "offline": "⚠️ pane 目前不在線上：它所在的 Navide 視窗沒有開著，或 pane 已關閉",
    },
    "en-US": {
        "offline": "⚠️ The pane is not online: the Navide window it belongs to is not open, or the pane was closed",
    },
    "ja-JP": {
        "offline": "⚠️ pane は現在オフラインです：所属する Navide ウィンドウが開いていないか、pane が閉じられています",
    },
}
DEFAULT_LANGUAGE = "zh-TW"


def text(lang: str, key: str, **kw: Any) -> str:
    return STRINGS.get(lang, STRINGS[DEFAULT_LANGUAGE])[key].format(**kw)
