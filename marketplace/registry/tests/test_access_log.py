"""The access log line: duration and sizes, nothing that names a person."""

from __future__ import annotations

import logging
import re

import pytest
from fastapi.testclient import TestClient

from registry.access_log import access_logger
from tests.fixtures import build_v2_package

LINE = re.compile(
    r"^method=(?P<method>[A-Z]+) route=(?P<route>\S+) status=(?P<status>\S+) "
    r"duration_ms=(?P<ms>\d+\.\d) request_bytes=(?P<req>\S+) response_bytes=(?P<resp>\d+)$"
)


class _Lines(logging.Handler):
    def __init__(self) -> None:
        super().__init__()
        self.lines: list[str] = []

    def emit(self, record: logging.LogRecord) -> None:
        self.lines.append(record.getMessage())


@pytest.fixture()
def lines():
    handler = _Lines()
    logger = access_logger()
    logger.addHandler(handler)
    try:
        yield handler.lines
    finally:
        logger.removeHandler(handler)


def _parsed(lines: list[str]) -> list[dict]:
    parsed = [LINE.match(line) for line in lines]
    assert all(parsed), lines
    return [m.groupdict() for m in parsed]  # type: ignore[union-attr]


def test_publish_logs_route_status_duration_and_sizes(client: TestClient, lines: list[str]) -> None:
    package = build_v2_package()
    response = client.post("/api/publish", files={"package": ("p.vsix", package, "application/zip")})
    assert response.status_code == 201, response.text

    [entry] = _parsed(lines)
    assert entry["method"] == "POST" and entry["route"] == "/api/publish" and entry["status"] == "201"
    assert int(entry["req"]) > len(package)
    assert int(entry["resp"]) == len(response.content)


def test_the_line_names_no_query_token_address_or_email(client: TestClient, lines: list[str]) -> None:
    secret = "tok" + "en-" + "f" * 24
    email = "someone" + "@" + "example.com"
    client.get(
        f"/api/extensions/{email}/x",
        params={"q": secret, "email": email},
        headers={"Authorization": f"Bearer {secret}", "X-Forwarded-For": "203.0.113.9"},
    )
    client.post(f"/publisher/ns/tokens/{secret}/revoke")

    entries = _parsed(lines)
    assert [e["route"] for e in entries] == [
        "/api/extensions/{namespace}/{name}",
        "/publisher/{namespace}/tokens/{token_id}/revoke",
    ]
    text = "\n".join(lines)
    for leaked in (secret, email, "example.com", "203.0.113.9", "testclient", "q="):
        assert leaked not in text


def test_an_unmatched_path_is_not_logged(client: TestClient, lines: list[str]) -> None:
    secret = "tok" + "en-" + "a" * 24
    assert client.get(f"/no-such-page/{secret}").status_code == 404
    [entry] = _parsed(lines)
    assert entry["route"] == "-" and entry["status"] == "404" and entry["req"] == "-"
    assert secret not in "\n".join(lines)
