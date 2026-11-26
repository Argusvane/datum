"""The address limit on the wire: `datum.web.throttle.address_limit`, counted before the body is read.

The wire order is contract: `Content-Type` (415), the address limit (429), the length (400, 413), the counted read
(413), the strict parse (400), the per-form throttle (429), the pre-check, the run. Every request that passes the
`Content-Type` check is counted under its client address alone (an IPv6 client by its /64), whether or not its body
fits or parses, in one window shared by every throttled route (submit, validate, test, inspect and the PDF routes).
A refusal is the per-form throttle's own: 429 `flood` with `Retry-After`, in the configured error format, with the same
event and counter.
"""

import contextlib
import json
from collections.abc import Iterator
from typing import Any

import pytest
from asgi_driver import body_of as sent_body
from asgi_driver import call, status_of
from fastapi.testclient import TestClient
from otel_support import telemetry
from pdf_fakes import PDF_MEDIA
from pdf_fakes import build_app as pdf_app
from pdf_fakes import config as pdf_config
from pdf_fakes import envelope as pdf_envelope
from pdf_fakes import make_datum as pdf_datum
from submissions_fakes import Parts, body_of, build_app, config, make_datum

from datum_core import DatumConfig
from datum_core.config.models import ThrottleKind
from datum_core.submissions import SubmissionThrottledEvent
from datum_core.throttle import ThrottleKey
from datum_fastapi import DatumSettings

JSON = {"Content-Type": "application/json"}
BAD = b"{"
"""A body that never parses: without the address limit every answer is 400 `bad_document`."""
ROUTES = ("/api/submissions", "/api/submissions/validate", "/api/submissions/test", "/api/inspect")


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


def limited(**throttle: Any) -> DatumConfig:
    return config(web={"throttle": throttle})


@contextlib.contextmanager
def serving(cfg: DatumConfig, **seams: Any) -> Iterator[tuple[TestClient, Parts]]:
    """The submissions and authoring routes over Datum's own throttle (`throttle=None`), unless `seams` names one."""
    datum, parts = make_datum(cfg, **{"throttle": None, **seams})
    with TestClient(build_app(datum, authoring=[])) as client:
        yield client, parts


def code(reply: Any) -> str:
    return str(reply.json()["errors"][0]["code"])


def statuses(client: TestClient, times: int, path: str = "/api/submissions", body: bytes = BAD) -> list[int]:
    return [client.post(path, content=body, headers=JSON).status_code for _ in range(times)]


# -- counted before the parse ------------------------------------------------------------------------------------------
def test_a_body_that_does_not_parse_is_counted_and_the_request_over_the_limit_is_429_flood_with_retry_after() -> None:
    with serving(limited(address_limit=3, window=60)) as (client, _):
        answers = [client.post("/api/submissions", content=BAD, headers=JSON) for _ in range(4)]
    assert [(a.status_code, code(a)) for a in answers[:3]] == [(400, "bad_document")] * 3
    over = answers[3]
    assert (over.status_code, code(over)) == (429, "flood")
    assert over.headers["retry-after"].isdigit()
    assert 1 <= int(over.headers["retry-after"]) <= 60


def test_the_refusal_is_in_the_configured_error_format_as_the_per_form_refusal_is() -> None:
    cfg = config(web={"throttle": {"address_limit": 1}, "api": {"problem_details": True}})
    with serving(cfg) as (client, _):
        client.post("/api/submissions", content=BAD, headers=JSON)
        over = client.post("/api/submissions", content=BAD, headers=JSON)
    assert over.status_code == 429
    assert over.headers["content-type"].startswith("application/problem+json")
    assert (over.json()["code"], over.json()["status"]) == ("flood", 429)
    assert over.headers["retry-after"].isdigit()


@pytest.mark.anyio
async def test_the_request_over_the_limit_is_refused_before_a_byte_of_its_body_is_read() -> None:
    datum, _ = make_datum(limited(address_limit=1), throttle=None)
    app = build_app(datum)
    events = [{"type": "http.request", "body": BAD, "more_body": False}]
    first: list[dict[str, Any]] = []
    second: list[dict[str, Any]] = []
    async with datum:
        counted = await call(app, path="/api/submissions", headers=JSON, events=events, pulled=first)
        refused = await call(app, path="/api/submissions", headers=JSON, events=events, pulled=second)
    assert status_of(counted) == 400
    assert first == events  # the first body was read and parsed
    assert status_of(refused) == 429
    assert json.loads(sent_body(refused))["errors"][0]["code"] == "flood"
    assert second == []  # the refused one was never read, so never parsed


# -- the order ---------------------------------------------------------------------------------------------------------
def test_the_content_type_check_comes_first_and_a_415_is_not_counted() -> None:
    with serving(limited(address_limit=1)) as (client, _):
        wrong = [
            client.post("/api/submissions", content=BAD, headers={"Content-Type": "text/plain"}).status_code
            for _ in range(5)
        ]
        assert wrong == [415] * 5
        assert statuses(client, 2) == [400, 429]
        assert client.post("/api/submissions", content=BAD, headers={"Content-Type": "text/plain"}).status_code == 415


@pytest.mark.anyio
async def test_the_address_limit_comes_before_the_length_checks_so_a_413_by_its_header_is_counted() -> None:
    cfg = config(web={"throttle": {"address_limit": 1}, "api": {"max_body_size": "1KiB"}})
    datum, _ = make_datum(cfg, throttle=None)
    app = build_app(datum)
    declared = {**JSON, "content-length": "99999"}
    events = [{"type": "http.request", "body": b"{}", "more_body": False}]
    async with datum:
        too_large = await call(app, path="/api/submissions", headers=declared, events=events)
        refused = await call(app, path="/api/submissions", headers=declared, events=events)
        malformed = await call(app, path="/api/submissions", headers={**JSON, "content-length": "x"}, events=events)
    assert status_of(too_large) == 413
    assert status_of(refused) == 429
    assert status_of(malformed) == 429


# -- the setting -------------------------------------------------------------------------------------------------------
def test_the_default_limit_is_600_requests_per_window_from_one_address() -> None:
    with serving(config()) as (client, _):
        answers = statuses(client, 601)
    assert answers[:600] == [400] * 600
    assert answers[600] == 429


@pytest.mark.parametrize("cfg", [limited(address_limit=None), limited(address_limit="off")], ids=["None", "off"])
def test_none_or_off_turns_the_address_limit_off(cfg: DatumConfig) -> None:
    with serving(cfg) as (client, _):
        assert statuses(client, 650) == [400] * 650


def test_the_whole_throttle_switched_off_turns_the_address_limit_off() -> None:
    with serving(limited(enabled=False, address_limit=1)) as (client, _):
        assert statuses(client, 5) == [400] * 5


@pytest.mark.parametrize(("given", "read"), [("200", 200), ("off", None), ("", 600)])
def test_the_environment_sets_it_and_off_turns_it_off(
    monkeypatch: pytest.MonkeyPatch, given: str, read: int | None
) -> None:
    monkeypatch.setenv("DATUM_WEB__THROTTLE__ADDRESS_LIMIT", given)
    assert DatumSettings().to_config().web.throttle.address_limit == read


def test_an_application_throttle_keeps_no_address_limit() -> None:
    with serving(limited(address_limit=1), throttle=Parts().throttle) as (client, _):
        assert statuses(client, 5) == [400] * 5


# -- the counted address -----------------------------------------------------------------------------------------------
@pytest.mark.anyio
async def test_an_ipv6_client_is_counted_by_its_64() -> None:
    datum, _ = make_datum(limited(address_limit=2), throttle=None)
    app = build_app(datum)
    events = [{"type": "http.request", "body": BAD, "more_body": False}]

    async def from_(host: str) -> int | None:
        return status_of(await call(app, path="/api/submissions", headers=JSON, events=events, client=(host, 443)))

    async with datum:
        answers = [
            await from_("2001:db8:1:2::1"),
            await from_("2001:db8:1:2:ffff::9"),
            await from_("2001:db8:1:2:abcd::1"),
            await from_("2001:db8:1:3::1"),
        ]
    assert answers == [400, 400, 429, 400]


@pytest.mark.anyio
async def test_a_request_with_no_client_address_is_not_counted() -> None:
    datum, _ = make_datum(limited(address_limit=1), throttle=None)
    app = build_app(datum)
    events = [{"type": "http.request", "body": BAD, "more_body": False}]
    async with datum:
        answers = [
            status_of(await call(app, path="/api/submissions", headers=JSON, events=events, client=None))
            for _ in range(3)
        ]
    assert answers == [400, 400, 400]


# -- one window apart from the per-form one ----------------------------------------------------------------------------
def test_the_address_window_is_counted_apart_from_the_per_form_window() -> None:
    with serving(limited(limit=1, address_limit=3)) as (client, _):
        assert client.post("/api/submissions", content=body_of(), headers=JSON).status_code == 200
        per_form = client.post("/api/submissions", content=body_of(), headers=JSON)
        assert (per_form.status_code, code(per_form)) == (429, "flood")  # the per-form window is spent
        assert statuses(client, 2) == [400, 429]  # the address window had room for one more


def test_every_throttled_submission_route_counts_in_one_address_window() -> None:
    with serving(limited(address_limit=len(ROUTES))) as (client, _):
        assert [statuses(client, 1, path)[0] for path in ROUTES] == [400] * len(ROUTES)
        refused = [client.post(path, content=BAD, headers=JSON) for path in ROUTES]
    assert [(reply.status_code, code(reply)) for reply in refused] == [(429, "flood")] * len(ROUTES)
    assert all(reply.headers["retry-after"].isdigit() for reply in refused)


def test_every_pdf_route_counts_in_the_same_address_window() -> None:
    datum, parts = pdf_datum(pdf_config(web={"throttle": {"address_limit": 4}}))
    printing = ("/api/pdf", "/api/pdf/fill", "/api/pdf/sign")
    with TestClient(pdf_app(datum)) as client:
        assert [client.post(path, content=BAD, headers=JSON).status_code for path in printing] == [400] * 3
        verify = client.post("/api/pdf/verify", content=b"not a pdf", headers={"Content-Type": PDF_MEDIA})
        assert verify.status_code == 400
        whole = json.dumps({"document": pdf_envelope()}).encode()
        refused = [client.post(path, content=whole, headers=JSON) for path in printing]
        refused.append(client.post("/api/pdf/verify", content=b"%PDF-1.7\n", headers={"Content-Type": PDF_MEDIA}))
    assert [(reply.status_code, reply.json()["errors"][0]["code"]) for reply in refused] == [(429, "flood")] * 4
    assert all(reply.headers["retry-after"].isdigit() for reply in refused)
    assert parts.program.ops() == []
    assert parts.sandbox.validations == 0


# -- the event and the counter -----------------------------------------------------------------------------------------
@pytest.mark.parametrize(
    ("path", "kind"),
    [("/api/submissions", ThrottleKind.SUBMIT), ("/api/submissions/validate", ThrottleKind.VALIDATE)],
)
def test_a_refusal_on_submit_or_validate_publishes_the_throttled_event_naming_the_address_and_the_kind(
    path: str, kind: ThrottleKind
) -> None:
    with serving(limited(address_limit=1)) as (client, parts):
        client.post(path, content=BAD, headers=JSON)
        reply = client.post(path, content=BAD, headers=JSON)
    retry_after = int(reply.headers["retry-after"])
    assert parts.events == [
        SubmissionThrottledEvent(ThrottleKey(ip="testclient", kind=kind, channel="http"), kind, retry_after, "http")
    ]


@pytest.mark.parametrize("path", ["/api/submissions/test", "/api/inspect"])
def test_a_refusal_on_a_dry_run_or_an_inspect_publishes_nothing_as_the_per_form_refusal_does(path: str) -> None:
    with serving(limited(address_limit=1)) as (client, parts):
        client.post(path, content=BAD, headers=JSON)
        assert client.post(path, content=BAD, headers=JSON).status_code == 429
    assert parts.events == []


def test_a_refusal_counts_in_the_throttled_counter_and_the_submission_span_as_the_per_form_refusal_does() -> None:
    otel = telemetry()
    before = otel.total("datum.request.throttled", **{"datum.channel": "http"})
    received = otel.total("datum.submission.received", **{"datum.status": "throttled"})
    with serving(limited(address_limit=1)) as (client, _):
        client.post("/api/submissions", content=BAD, headers=JSON)
        otel.exporter.clear()
        assert client.post("/api/submissions", content=BAD, headers=JSON).status_code == 429
    assert otel.total("datum.request.throttled", **{"datum.channel": "http"}) == before + 1
    assert otel.total("datum.submission.received", **{"datum.status": "throttled"}) == received + 1
    (span,) = [span for span in otel.spans() if span.name == "datum.submission"]
    assert span.attributes is not None
    assert (span.attributes["datum.mode"], span.attributes["datum.outcome"]) == ("submit", "throttled")
