"""Keep token-bearing query parameters out of every log line.

uvicorn logs each WebSocket handshake through ``uvicorn.error`` at INFO with
the full path and query — ``"WebSocket /ws?t=<token>" [accepted]`` — so with
access_log off the ws credential still reached stdout on every launch. The
backend's credentials travel as ``t=`` (/ws, /fs/raw, /plan-mcp); ``token=``
is covered too so a renamed param does not reopen this.

The filter goes on the loggers and on their handlers: a logger's filters only
see records logged on that logger, while a handler's see everything that
propagates to it, which is what covers ``uvicorn.error`` (no handler of its
own) and any library logging under the root.
"""

from __future__ import annotations

import logging
import re
from collections.abc import Mapping

from agent_team_backend import ws_auth

_PARAM = r"([?&](?:t|token)=)"
_VALUE = r"[^&#\s\"']+"
_TOKEN_PARAM = re.compile(_PARAM + _VALUE)
# For a format string with args: leave ``t=%s`` alone so the arg still has a
# placeholder to fill; the rendered message is checked afterwards.
_TOKEN_PARAM_NOT_PLACEHOLDER = re.compile(_PARAM + r"(?!%[-#0 +]*[\d.]*[sdrifxXeEgGc(])" + _VALUE)


# Credentials minted in-process that can turn up bare, outside any ``t=``:
# the per-pane /plan-mcp tokens ride in a spawn env (NAVIDE_MCP_TOKEN) and in
# Authorization headers, so a logged env or header carries no "t=" to catch.
_SECRETS: set[str] = set()


def add_secret(token: str) -> None:
    """Redact ``token`` wherever it appears in a log record from now on."""
    if token:
        _SECRETS.add(token)


def remove_secret(token: str) -> None:
    """Stop scanning for ``token`` (a revoked credential): keeps the set the
    size of what is live rather than of everything ever minted."""
    _SECRETS.discard(token)


def _redact_bare(text: str) -> str:
    for secret in tuple(_SECRETS):
        if secret in text:
            text = text.replace(secret, "***")
    return text


def redact(text: str) -> str:
    return _TOKEN_PARAM.sub(r"\1***", text)


def _redact_arg(value: object) -> object:
    if not isinstance(value, str):
        if isinstance(value, (Mapping, list, tuple, set)) and _SECRETS:
            # A container is rendered with repr: check that, and fall back to
            # the redacted text only when a secret is actually in it.
            rendered = repr(value)
            if _redact_bare(rendered) != rendered:
                return _redact_bare(redact(rendered))
        return value
    # The bare token, too: when the format and args do not match, logging's
    # error report prints the raw args, so there is no rendered "t=" to catch.
    token = ws_auth.current_token()
    if token and token in value:
        value = value.replace(token, "***")
    return redact(_redact_bare(value))


class TokenRedactionFilter(logging.Filter):
    """Rewrites token values to ``***`` in ``record.msg`` and ``record.args``.

    Never drops a record and never touches its level. The args stay a tuple
    where possible: uvicorn's access formatter unpacks them.
    """

    def filter(self, record: logging.LogRecord) -> bool:
        args = record.args
        if isinstance(record.msg, str):
            pattern = _TOKEN_PARAM_NOT_PLACEHOLDER if args else _TOKEN_PARAM
            record.msg = _redact_bare(pattern.sub(r"\1***", record.msg))
        if args:
            self._redact_args(record, args)
        self._redact_traceback(record)
        return True

    @staticmethod
    def _redact_args(record: logging.LogRecord, args: object) -> None:
        if isinstance(args, Mapping):
            record.args = {k: _redact_arg(v) for k, v in args.items()}
        elif isinstance(args, tuple):
            record.args = tuple(_redact_arg(a) for a in args)
        # ``"?t=%s", token``: the param name and its value only meet once
        # formatted, so redact the formatted message instead. The same goes
        # for a registered secret inside an arg that is neither a string nor a
        # container (an exception, an object whose repr holds an env).
        try:
            rendered = record.getMessage()
        except Exception:
            return
        cleaned = _redact_bare(redact(rendered))
        if cleaned != rendered:
            record.msg, record.args = cleaned, None

    @staticmethod
    def _redact_traceback(record: logging.LogRecord) -> None:
        """A traceback (log.exception / exc_info) and stack_info are appended
        by the formatter after the message, so they are redacted separately.
        A traceback that held a secret is rendered here and kept as exc_text,
        which every formatter prints in place of formatting exc_info again."""
        if record.exc_info and not record.exc_text:
            try:
                text = logging.Formatter().formatException(record.exc_info)
            except Exception:
                text = ""
            cleaned = _redact_bare(redact(text))
            if cleaned != text:
                record.exc_text, record.exc_info = cleaned, None
        elif record.exc_text:
            record.exc_text = _redact_bare(redact(record.exc_text))
        if record.stack_info:
            record.stack_info = _redact_bare(redact(record.stack_info))


_FILTER = TokenRedactionFilter()
_LOGGERS = ("", "uvicorn", "uvicorn.error", "uvicorn.access", "uvicorn.asgi", "agent_team_backend")


def _redacting_factory(previous):
    def factory(*args, **kwargs) -> logging.LogRecord:
        record = previous(*args, **kwargs)
        _FILTER.filter(record)
        return record

    factory.redacts_tokens = True  # type: ignore[attr-defined]
    return factory


def install() -> None:
    """Redact every record this process creates, and keep the filter on the
    loggers and handlers that exist now.

    The record factory is what reaches handlers added later, on any logger:
    a filter on a logger never sees records propagated from its children, and
    a handler only has the filters it was given. It is logging's own hook,
    called once per record after the level check, and per interpreter, so it
    covers this process and nothing else. It wraps whatever factory was set.

    Call after ``uvicorn.Config`` is built: its dictConfig replaces the
    uvicorn handlers, dropping any filter put on them earlier.
    """
    current = logging.getLogRecordFactory()
    if not getattr(current, "redacts_tokens", False):
        logging.setLogRecordFactory(_redacting_factory(current))
    for name in _LOGGERS:
        logger = logging.getLogger(name)
        for target in (logger, *logger.handlers):
            if _FILTER not in target.filters:
                target.addFilter(_FILTER)
