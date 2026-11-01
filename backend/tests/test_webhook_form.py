"""The form trigger: the page, its token, and what a submission may carry."""

from __future__ import annotations

import asyncio
import json
import re
from types import SimpleNamespace
from typing import Any
from urllib.parse import urlencode

import pytest

from agent_team_backend import webhook_form as wf
from agent_team_backend import webhook_listener, webhook_triggers

from .test_webhook_github import Host
from .test_webhook_service import PIPE, WS
from .test_webhook_ws import call, env  # noqa: F401
from .webhook_client import OneWriteConnection

FIELDS = wf.normalize_fields([
    {"type": "text", "label": "Name", "required": True},
    {"type": "email", "label": "Mail"},
    {"type": "select", "label": "Team", "options": ["A", "B"]},
    {"type": "number", "label": "Age"},
    {"type": "date", "label": "Day"},
    {"type": "checkbox", "label": "OK"},
])
TOKEN = "nv" + "wh_" + "t" * 40


class TestDefinition:
    def test_named_by_position_whatever_the_label(self) -> None:
        assert [f["name"] for f in FIELDS] == ["f0", "f1", "f2", "f3", "f4", "f5"]

    @pytest.mark.parametrize(
        "bad",
        [[], "x", [{"type": "file", "label": "x"}], [{"type": "password", "label": "x"}], [{"type": "html", "label": "x"}],
         [{"type": "text", "label": ""}], [{"type": "select", "label": "x", "options": []}], [{"type": "text", "label": "x"}] * 21],
    )
    def test_what_a_form_cannot_be(self, bad) -> None:
        with pytest.raises(wf.FormInvalid):
            wf.normalize_fields(bad)


class TestPage:
    def test_every_value_is_escaped(self) -> None:
        evil = '<script>alert(1)</script>"\''
        fields = wf.normalize_fields([{"type": "select", "label": evil, "options": [evil]}])
        page = wf.render_page(evil, fields, "c").decode()
        assert "<script" not in page and "&lt;script&gt;" in page

    def test_no_script_and_nothing_loaded(self) -> None:
        page = wf.render_page("t", FIELDS, "c").decode()
        assert "<script" not in page and "src=" not in page and "http" not in page


class TestCsrf:
    SECRET = b"s" * 32

    def test_round_trip(self) -> None:
        assert wf.csrf_valid(self.SECRET, "t", wf.mint_csrf(self.SECRET, "t", 1000), 1000 + wf.CSRF_TTL_S)

    @pytest.mark.parametrize("token", ["", "x", "1000", "1000.00", "abc.def"])
    def test_rubbish(self, token) -> None:
        assert not wf.csrf_valid(self.SECRET, "t", token, 1000)

    def test_expired(self) -> None:
        assert not wf.csrf_valid(self.SECRET, "t", wf.mint_csrf(self.SECRET, "t", 1000), 1001 + wf.CSRF_TTL_S)

    def test_from_the_future(self) -> None:
        assert not wf.csrf_valid(self.SECRET, "t", wf.mint_csrf(self.SECRET, "t", 2000), 1000)

    def test_another_form(self) -> None:
        assert not wf.csrf_valid(self.SECRET, "other", wf.mint_csrf(self.SECRET, "t", 1000), 1000)


class TestSubmission:
    def test_labels_and_values_and_nothing_extra(self) -> None:
        out = json.loads(wf.submission_text(FIELDS, {"f0": "Ann", "f5": "on", "planted": "x"}))
        assert out == {"Name": "Ann", "Mail": "", "Team": "", "Age": "", "Day": "", "OK": True}

    @pytest.mark.parametrize(
        "values",
        [{}, {"f0": ""}, {"f0": "a", "f1": "nope"}, {"f0": "a", "f2": "C"}, {"f0": "a", "f3": "x"}, {"f0": "a", "f4": "soon"}],
    )
    def test_what_does_not_fit(self, values) -> None:
        with pytest.raises(wf.SubmissionInvalid):
            wf.submission_text(FIELDS, values)

    def test_too_many_fields(self) -> None:
        with pytest.raises(wf.SubmissionInvalid):
            wf.parse_body("&".join(f"x{i}=1" for i in range(100)))


@pytest.fixture
async def server():
    host = Host()
    guard = {"on": True}
    listener = webhook_listener.WebhookListener(
        port=0, public_host="form.example.com", accept=host.accept, on_audit=host.audit.extend,
        loop=asyncio.get_running_loop(), guard_enabled=lambda: guard["on"],
    )
    trigger = {
        "id": "c" * 32, "kind": "form", "name": "<b>Ask</b>", "form_fields": FIELDS, "form_public": False,
        "token_hash": webhook_triggers.hash_token(TOKEN), "per_minute": 60, "per_day": 500, "workspace": WS, "pipeline_id": PIPE,
    }
    listener.update({trigger["id"]: trigger})
    await asyncio.to_thread(listener.start)

    def request(method: str, *, token: str = TOKEN, host_header: str = "", body: bytes = b"", headers: dict | None = None) -> tuple[int, str, dict]:
        conn = OneWriteConnection("127.0.0.1", listener.port, timeout=10)
        sent = {"Host": host_header or f"127.0.0.1:{listener.port}", **(headers or {})}
        conn.request(method, f"/form/{token}", body=body, headers=sent)
        res = conn.getresponse()
        data = res.read().decode()
        conn.close()
        return res.status, data, {k.lower(): v for k, v in res.getheaders()}

    async def post(values: dict, *, csrf: str | None = None, origin: str | None = None, content_type: str = "application/x-www-form-urlencoded") -> tuple[int, str, dict]:
        if csrf is None:
            page = (await asyncio.to_thread(request, "GET"))[1]
            csrf = re.search(r'name="_csrf" value="([^"]+)"', page).group(1)
        here = f"127.0.0.1:{listener.port}"
        headers = {"Content-Type": content_type}
        if origin != "":
            headers["Origin"] = origin or f"http://{here}"
        return await asyncio.to_thread(request, "POST", body=urlencode({"_csrf": csrf, **values}).encode(), headers=headers)

    yield SimpleNamespace(host=host, trigger=trigger, guard=guard, listener=listener, post=post, get=lambda **k: asyncio.to_thread(request, "GET", **k))
    await asyncio.to_thread(listener.stop)


class TestListener:
    async def test_the_page_has_its_headers(self, server) -> None:
        status, page, headers = await server.get()
        assert status == 200 and "&lt;b&gt;Ask" in page
        assert "default-src 'none'" in headers["content-security-policy"]
        assert "form-action 'self'" in headers["content-security-policy"]
        assert "frame-ancestors 'none'" in headers["content-security-policy"]
        assert headers["cache-control"] == "no-store" and headers["referrer-policy"] == "same-origin"

    async def test_a_wrong_token_is_nothing(self, server) -> None:
        assert (await server.get(token="x" * 30))[0] == 404

    async def test_private_by_default_public_when_ticked(self, server) -> None:
        assert (await server.get(host_header="form.example.com"))[0] == 404
        server.trigger["form_public"] = True
        assert (await server.get(host_header="form.example.com"))[0] == 200

    async def test_a_foreign_host_never(self, server) -> None:
        server.trigger["form_public"] = True
        assert (await server.get(host_header="evil.example"))[0] == 404

    async def test_a_submission_runs_and_answers_a_fixed_page(self, server) -> None:
        status, page, _ = await server.post({"f0": "Ann"})
        assert status == 200 and "Thanks" in page
        assert json.loads(server.host.calls[0][0])["Name"] == "Ann"

    async def test_html_in_a_value_is_just_data(self, server) -> None:
        await server.post({"f0": "<script>x</script>"})
        assert "<script>x</script>" in server.host.calls[0][0]

    async def test_no_csrf_token(self, server) -> None:
        assert (await server.post({"f0": "Ann"}, csrf="1.2"))[0] == 403
        assert server.host.calls == []

    async def test_another_origin(self, server) -> None:
        assert (await server.post({"f0": "Ann"}, origin="https://evil.example"))[0] == 403

    async def test_an_opaque_origin(self, server) -> None:
        assert (await server.post({"f0": "Ann"}, origin="null"))[0] == 403

    async def test_no_origin(self, server) -> None:
        assert (await server.post({"f0": "Ann"}, origin=""))[0] == 403

    async def test_urlencoded_only(self, server) -> None:
        assert (await server.post({"f0": "Ann"}, content_type="application/json"))[0] == 415

    async def test_a_bad_value_shows_the_form_again_and_runs_nothing(self, server) -> None:
        status, page, _ = await server.post({"f0": ""})
        assert status == 400 and "Name is required" in page and server.host.calls == []

    async def test_guard_off(self, server) -> None:
        server.guard["on"] = False
        assert (await server.post({"f0": "Ann"}, csrf="1.2"))[0] == 503

    async def test_a_refused_run_says_only_that(self, server) -> None:
        server.host.answer = (409, 0, "run-active")
        status, page, _ = await server.post({"f0": "Ann"})
        assert status == 409 and "cannot take a response" in page

    async def test_the_form_token_is_no_bearer_key_for_the_webhook_path(self, server) -> None:
        conn = OneWriteConnection("127.0.0.1", server.listener.port, timeout=10)
        conn.request("POST", f"/webhook/{server.trigger['id']}", body=b"{}", headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"})
        status = conn.getresponse().status
        conn.close()
        assert status == 404 and server.host.calls == []


class TestCreate:
    async def test_a_form_keeps_its_fields_and_is_private(self, env) -> None:  # noqa: F811
        created = await call("webhook.trigger.create", name="Ask", workspace_path=WS, pipeline_id=PIPE, kind="form",
                             fields=[{"type": "text", "label": "Name"}])
        trigger = created["payload"]["trigger"]
        assert trigger["form_fields"][0]["name"] == "f0" and trigger["form_public"] is False

    async def test_going_public_is_audited(self, env) -> None:  # noqa: F811
        created = await call("webhook.trigger.create", name="Ask", workspace_path=WS, pipeline_id=PIPE, kind="form",
                             fields=[{"type": "text", "label": "Name"}], form_public=True)
        assert "form-public" in [e["outcome"] for e in env.store.events(created["payload"]["trigger"]["id"])]

    async def test_a_bad_definition_leaves_nothing(self, env) -> None:  # noqa: F811
        answer: dict[str, Any] = await call("webhook.trigger.create", name="Ask", workspace_path=WS, pipeline_id=PIPE, kind="form", fields=[])
        assert answer["error"]["code"] == "BAD_REQUEST" and env.store.list() == []
