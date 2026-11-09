"""``/plugins status`` and ``/plugins stop <id>`` in a bound chat (plan P2).

The chat can see which third-party Navide plugins are installed and stop one
at once, when the user is away from the computer. It can never start one:
enabling stays in the Navide window, which shows what the plugin was doing
when it was stopped. The Host does the stop (``plugins/plugin_stop.py``).
"""

from __future__ import annotations

from typing import Any

from . import quick_menu

#: The most plugins one status reply lists.
MAX_LISTED = 30


def parse_command(body: str, identity: str = "") -> tuple[str, str] | None:
    """``("status", "")`` or ``("stop", <argument>)``, optionally ``@bot``-addressed;
    None for anything else (a bare ``/plugins`` stays the pane's), or for a
    command addressed to another bot."""
    rest = quick_menu._MENTION_RE.sub("", (body or "").strip()).strip()
    if not rest.startswith("/"):
        return None
    head, _, tail = rest.partition(" ")
    head, _, bot = head.partition("@")
    if head.lower() != "/plugins" or (bot and identity and bot.lower() != identity.lstrip("@").lower()):
        return None
    word, _, arg = tail.strip().partition(" ")
    word, arg = word.lower(), arg.strip()
    if word == "status" and not arg:
        return ("status", "")
    if word == "stop":
        return ("stop", arg)
    return None


def render_status(lang: str, plugins: list[dict[str, Any]]) -> str:
    """One line per plugin: its id, version and whether it runs."""
    if not plugins:
        return quick_menu.text(lang, "plugins_empty")
    lines = [quick_menu.text(lang, "plugins_head", count=len(plugins))]
    for row in plugins[:MAX_LISTED]:
        state = quick_menu.text(lang, "plugins_state_stopped" if row.get("disabled") else "plugins_state_running")
        lines.append(quick_menu.text(lang, "plugins_line", id=str(row.get("id", "")), version=str(row.get("version", "")), state=state))
    lines.append(quick_menu.text(lang, "plugins_hint"))
    return "\n".join(lines)
