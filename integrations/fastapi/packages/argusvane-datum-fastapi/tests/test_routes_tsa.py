"""`routers.tsa`: `issueTimestamp`, `getTimestampCertificate` and `getTimestampCertificates`.

The router is public (the TSA has its own client-key rule), so there is no `dependencies` keyword to require. The
started guard runs first; admission follows the H5 order (cookie 403, media type 415, client key 401 or 429, flood 429,
size 413, all plain text); a request that gets through is answered `application/timestamp-reply` (DER) with
`Cache-Control: no-store` and no `ETag`: 200 for a token, 400 or 503 (with `Retry-After`) for a rejection. No cookie, no
session and no `app.state` is touched. Each route exists only with `datum.tsa.enabled`. These tests run on the floor
(fastapi 0.133.0) and the latest leg alike.
"""

import logging
from pathlib import Path
from typing import Any

import pytest
from asgi_driver import body_of, call, status_of
from fastapi import FastAPI
from fastapi.routing import APIRoute
from fastapi.testclient import TestClient
from tsa_fakes import (
    CLIENT_KEY,
    DIGEST,
    OTHER_POLICY,
    POLICY,
    QUERY_TYPE,
    REPLY_TYPE,
    SHA1_OID,
    Parts,
    build_app,
    config,
    contains_digest_and_nonce,
    der_oid,
    events_of,
    key_hash,
    make_datum,
    operations_of,
    parse_reply,
    query_der,
)

from datum_core.hooks import HookRefusedError
from datum_core.loggers import CHECKS
from datum_core.testing.tsa_pki import TsaPki, bytes_to_pem
from datum_fastapi import DatumRoute, routers

OPERATIONS = {"issueTimestamp", "getTimestampCertificate", "getTimestampCertificates"}
PEM_BEGIN = b"-----BEGIN CERTIFICATE-----"
BASIC = 'Bearer realm="timestamp server", Basic realm="timestamp server"'


@pytest.fixture
def parts(tsa_pki: TsaPki) -> Parts:
    return Parts(tsa_pki.ec)


@pytest.fixture
def client(tsa_pki: TsaPki, parts: Parts) -> Any:
    datum, _ = make_datum(tsa_pki.ec, parts=parts)
    with TestClient(build_app(datum)) as running:
        yield running


def stamp(client: Any, body: bytes | None = None, *, headers: dict[str, str] | None = None) -> Any:
    sent = {"Content-Type": QUERY_TYPE, **(headers or {})}
    return client.post("/tsa", content=query_der(nonce=0x1234567890) if body is None else body, headers=sent)


# -- the route table ---------------------------------------------------------------------------------------------------
def test_the_router_holds_the_three_catalog_operations_at_the_default_prefix(tsa_pki: TsaPki) -> None:
    datum, _ = make_datum(tsa_pki.ec)
    router = routers.tsa(datum)
    found = {op: (sorted(route.methods or ()), route.path) for op, route in operations_of(router).items() if route.path}
    assert found == {
        "issueTimestamp": (["POST"], "/tsa"),
        "getTimestampCertificate": (["GET"], "/tsa/certificate"),
        "getTimestampCertificates": (["GET"], "/tsa/certificates"),
    }


def test_the_prefix_moves_all_three_routes(tsa_pki: TsaPki) -> None:
    datum, _ = make_datum(tsa_pki.ec)
    paths = {route.path for route in routers.tsa(datum, prefix="/stamp").routes if isinstance(route, APIRoute)}
    assert {"/stamp", "/stamp/certificate", "/stamp/certificates"} <= paths
    assert not any(path.startswith("/tsa") for path in paths)


def test_the_routes_use_datums_route_class_and_the_catalog_tag(tsa_pki: TsaPki) -> None:
    datum, _ = make_datum(tsa_pki.ec)
    routes = [r for r in routers.tsa(datum).routes if isinstance(r, APIRoute) and r.operation_id in OPERATIONS]
    assert len(routes) == 3
    assert all(isinstance(route, DatumRoute) for route in routes)
    assert all(route.tags == ["datum-tsa"] for route in routes)


def test_a_tsa_router_with_the_switch_off_adds_no_route_and_names_it_in_a_w001(
    tsa_pki: TsaPki, caplog: pytest.LogCaptureFixture
) -> None:
    datum, _ = make_datum(tsa_pki.ec, config(tsa={"enabled": False}))
    router = routers.tsa(datum)
    assert [r for r in router.routes if isinstance(r, APIRoute)] == []
    with caplog.at_level(logging.WARNING, logger=CHECKS), TestClient(build_app(datum)):
        pass
    notices = [r.getMessage() for r in caplog.records if getattr(r, "datum_check_id", None) == "datum.W001"]
    assert any("tsa" in text for text in notices)
    assert any("datum.tsa.enabled" in r.getMessage() for r in caplog.records)


def test_host_json_names_the_tsa_base_in_paths_with_the_root_path(tsa_pki: TsaPki) -> None:
    datum, _ = make_datum(tsa_pki.ec, config(web={"assets": {"enabled": True}}))
    app = build_app(datum, prefix="/stamp")
    app.include_router(routers.assets(datum))
    with TestClient(app) as plain:
        assert plain.get("/datum/assets/host.json").json()["paths"] == {"tsa": "/stamp"}
    with TestClient(app, root_path="/proxy") as mounted:
        assert mounted.get("/proxy/datum/assets/host.json").json()["paths"] == {"tsa": "/proxy/stamp"}


def test_a_tsa_router_with_the_switch_off_names_no_path_in_host_json(tsa_pki: TsaPki) -> None:
    datum, _ = make_datum(tsa_pki.ec, config(tsa={"enabled": False}, web={"assets": {"enabled": True}}))
    app = build_app(datum)
    app.include_router(routers.assets(datum))
    with TestClient(app) as client:
        assert "paths" not in client.get("/datum/assets/host.json").json()


def test_two_routers_that_name_one_endpoint_base_at_two_prefixes_are_refused(tsa_pki: TsaPki) -> None:
    datum, _ = make_datum(tsa_pki.ec)
    routers.tsa(datum)
    with pytest.raises(ValueError, match="one name has one base"):
        routers.tsa(datum, prefix="/stamp")


def test_datum_enabled_false_adds_no_tsa_route_even_with_the_tsa_on(tsa_pki: TsaPki) -> None:
    datum, _ = make_datum(tsa_pki.ec, config(enabled=False))
    assert [r for r in routers.tsa(datum).routes if isinstance(r, APIRoute)] == []


def test_with_the_switch_off_the_routes_answer_the_applications_404(tsa_pki: TsaPki) -> None:
    datum, _ = make_datum(tsa_pki.ec, config(tsa={"enabled": False}))
    with TestClient(build_app(datum)) as running:
        assert running.post("/tsa", content=b"x", headers={"Content-Type": QUERY_TYPE}).status_code == 404
        assert running.get("/tsa/certificate").status_code == 404


def test_the_router_takes_no_dependencies_keyword_because_the_tsa_has_its_own_client_key_rule(
    tsa_pki: TsaPki,
) -> None:
    datum, _ = make_datum(tsa_pki.ec)
    routers.tsa(datum)  # callable without `dependencies`: it is not a privileged factory


# -- the started guard is first ----------------------------------------------------------------------------------------
def test_before_the_lifespan_every_route_is_the_started_guards_503_and_nothing_is_read(
    tsa_pki: TsaPki, parts: Parts
) -> None:
    datum, _ = make_datum(tsa_pki.ec, parts=parts)
    running = TestClient(build_app(datum))  # no `with`: the lifespan never ran
    posted = stamp(running, headers={"Cookie": "JSESSIONID=b"})  # a cookie would be 403 if admission ran first
    assert posted.status_code == 503
    assert posted.json()["errors"][0]["code"] == "server.unavailable"
    assert "retry-after" not in posted.headers
    assert running.get("/tsa/certificate").status_code == 503
    assert parts.key.signs == 0
    assert parts.serials.allocations == 0


# -- a granted token ---------------------------------------------------------------------------------------------------
def test_a_query_is_answered_with_a_timestamp_reply_uncached_and_without_an_etag(client: Any) -> None:
    reply = stamp(client)
    assert reply.status_code == 200
    assert reply.headers["content-type"].partition(";")[0] == REPLY_TYPE
    assert "no-store" in reply.headers["cache-control"]
    assert "etag" not in reply.headers
    read = parse_reply(reply.content)
    assert read.status == 0
    assert read.token is not None
    assert contains_digest_and_nonce(reply.content, DIGEST, 0x1234567890)


def test_both_names_of_the_query_type_are_taken(client: Any) -> None:
    for name in ("application/timestamp-query", "application/timestamp-request"):
        assert stamp(client, headers={"Content-Type": name}).status_code == 200


def test_the_token_publishes_the_issued_event_and_logs_a_row_before_the_reply_leaves(client: Any, parts: Parts) -> None:
    stamp(client)
    assert events_of(parts) == ["TimestampIssuedEvent"]
    assert len(parts.log.entries) == 1
    assert parts.key.signs == 1


def test_no_cookie_is_set_and_the_application_state_is_not_touched(tsa_pki: TsaPki) -> None:
    datum, _ = make_datum(tsa_pki.ec)
    app = build_app(datum)
    before = dict(app.state._state)  # pyright: ignore[reportPrivateUsage]
    with TestClient(app) as running:
        replies = [stamp(running), running.get("/tsa/certificate"), stamp(running, b"garbage")]
    assert all("set-cookie" not in reply.headers for reply in replies)
    assert dict(app.state._state) == before  # pyright: ignore[reportPrivateUsage]


# -- rejections: DER, 400 or 503 ---------------------------------------------------------------------------------------
@pytest.mark.parametrize(
    ("body", "bit"),
    [
        (b"not a TimeStampReq", 5),
        (query_der(b"\x01" * 20, oid=SHA1_OID), 0),
        (query_der(policy=der_oid("1.2.3.4")), 15),
    ],
    ids=["garbage", "sha1", "unaccepted-policy"],
)
def test_a_bad_request_is_a_400_rejection_with_its_failure_bit(
    client: Any, parts: Parts, body: bytes, bit: int
) -> None:
    reply = stamp(client, body)
    assert reply.status_code == 400
    assert reply.headers["content-type"].partition(";")[0] == REPLY_TYPE
    assert "no-store" in reply.headers["cache-control"]
    assert "etag" not in reply.headers
    assert "retry-after" not in reply.headers
    read = parse_reply(reply.content)
    assert read.status == 2
    assert read.fail_bits == {bit}
    assert read.token is None
    assert events_of(parts) == ["TimestampRefusedEvent"]
    assert parts.key.signs == 0
    assert parts.serials.allocations == 0


def test_an_unavailable_time_source_is_a_503_rejection_with_retry_after_and_costs_nothing(
    tsa_pki: TsaPki, parts: Parts
) -> None:
    parts.clock.reason = "The clock is not synchronised."
    datum, _ = make_datum(tsa_pki.ec, config(web={"api": {"busy_retry_after": 7}}), parts=parts)
    with TestClient(build_app(datum)) as running:
        reply = stamp(running)
    assert reply.status_code == 503
    assert reply.headers["retry-after"] == "7"  # the configured busy_retry_after, not a constant
    read = parse_reply(reply.content)
    assert read.fail_bits == {14}
    assert any("The clock is not synchronised." in text for text in read.texts)
    assert parts.key.signs == 0
    assert parts.serials.allocations == 0


def test_a_serial_store_that_raises_is_a_503_system_failure_with_retry_after_and_none_of_its_words(
    tsa_pki: TsaPki, parts: Parts
) -> None:
    class Down:
        def allocate(self) -> int:
            raise ConnectionError("cannot reach db.internal.example:5432")

    datum, _ = make_datum(
        tsa_pki.ec, config(web={"api": {"busy_retry_after": 7}}), parts=parts, tsa_serial_allocator=Down()
    )
    with TestClient(build_app(datum)) as running:
        reply = stamp(running)
    assert reply.status_code == 503
    assert reply.headers["retry-after"] == "7"
    assert parse_reply(reply.content).fail_bits == {25}
    assert b"db.internal.example" not in reply.content
    assert parts.key.signs == 0


def test_a_customizers_refusal_is_a_400_bad_request_with_its_message(tsa_pki: TsaPki, parts: Parts) -> None:
    def refuse(draft: Any) -> None:
        raise HookRefusedError.forbidden("tsa.no", "Not this client.")

    datum, _ = make_datum(tsa_pki.ec, parts=parts, timestamp_request_customizers=[refuse])
    with TestClient(build_app(datum)) as running:
        reply = stamp(running)
    assert reply.status_code == 400
    read = parse_reply(reply.content)
    assert read.fail_bits == {2}
    assert any("Not this client." in text for text in read.texts)
    assert parts.key.signs == 0


def test_a_customizer_raising_something_else_is_a_503_without_its_words(tsa_pki: TsaPki, parts: Parts) -> None:
    def explode(draft: Any) -> None:
        raise RuntimeError("bug at db.internal.example")

    datum, _ = make_datum(tsa_pki.ec, parts=parts, timestamp_request_customizers=[explode])
    with TestClient(build_app(datum)) as running:
        reply = stamp(running)
    assert reply.status_code == 503
    assert parse_reply(reply.content).fail_bits == {25}
    assert b"db.internal.example" not in reply.content


# -- admission: plain text, in the admission order ---------------------------------------------------------------------
def plain(reply: Any) -> bool:
    return reply.headers["content-type"].partition(";")[0] == "text/plain" and bool(reply.text) and reply.text.isascii()


def test_a_cookie_is_403_in_plain_text_before_anything_else(client: Any, parts: Parts) -> None:
    reply = stamp(client, headers={"Cookie": "JSESSIONID=ZZ-VALUE-ZZ", "Content-Type": "application/octet-stream"})
    assert reply.status_code == 403
    assert plain(reply)
    assert "ZZ-VALUE-ZZ" not in reply.text
    assert events_of(parts) == []
    assert parts.serials.allocations == 0


def test_another_media_type_is_415_in_plain_text_not_the_json_bad_document(client: Any) -> None:
    reply = stamp(client, headers={"Content-Type": "application/octet-stream"})
    assert reply.status_code == 415
    assert plain(reply)
    assert "bad_document" not in reply.text


def test_a_missing_media_type_is_415(client: Any) -> None:
    assert client.post("/tsa", content=query_der()).status_code == 415


def test_any_cookie_is_refused_by_default(client: Any) -> None:
    assert stamp(client, headers={"Cookie": "theme=dark"}).status_code == 403
    assert stamp(client, headers={"Cookie": "a=b"}).status_code == 403


def test_a_session_cookie_list_narrows_the_cookie_rule(tsa_pki: TsaPki) -> None:
    datum, _ = make_datum(tsa_pki.ec, config(tsa={"session_cookies": ["JSESSIONID"]}))
    with TestClient(build_app(datum)) as running:
        assert stamp(running, headers={"Cookie": "JSESSIONID=x"}).status_code == 403
        assert stamp(running, headers={"Cookie": "theme=dark"}).status_code == 200


def test_the_declared_length_over_max_request_size_is_413_in_plain_text(tsa_pki: TsaPki) -> None:
    datum, _ = make_datum(tsa_pki.ec, config(tsa={"max_request_size": 64}))
    with TestClient(build_app(datum)) as running:
        reply = stamp(running, b"\x30" * 65)
        assert reply.status_code == 413
        assert plain(reply)
        assert stamp(running, query_der(cert_req=False)[:64].ljust(64, b"\x00")).status_code != 413


@pytest.mark.anyio
async def test_a_chunked_body_over_the_cap_is_413_in_plain_text_from_the_counted_read(tsa_pki: TsaPki) -> None:
    datum, _ = make_datum(tsa_pki.ec, config(tsa={"max_request_size": 64}))
    app = build_app(datum)
    chunks = [{"type": "http.request", "body": b"\x30" * 40, "more_body": True}] * 2 + [
        {"type": "http.request", "body": b"", "more_body": False}
    ]
    async with datum:
        sent = await call(app, path="/tsa", headers={"content-type": QUERY_TYPE}, events=chunks)
    assert status_of(sent) == 413
    assert body_of(sent).isascii()
    assert b"bad_document" not in body_of(sent)


@pytest.mark.anyio
async def test_a_chunked_413_takes_a_flood_slot_at_admission_so_the_next_request_is_429(tsa_pki: TsaPki) -> None:
    datum, _ = make_datum(tsa_pki.ec, config(tsa={"max_request_size": 64, "flood": {"limit": 1}}))
    app = build_app(datum)
    chunks = [{"type": "http.request", "body": b"\x30" * 40, "more_body": True}] * 2 + [
        {"type": "http.request", "body": b"", "more_body": False}
    ]
    async with datum:
        first = await call(app, path="/tsa", headers={"content-type": QUERY_TYPE}, events=chunks)
        second = await call(
            app,
            path="/tsa",
            headers={"content-type": QUERY_TYPE},
            events=[{"type": "http.request", "body": query_der()[:20], "more_body": False}],
        )
    assert status_of(first) == 413
    assert status_of(second) == 429


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


@pytest.mark.anyio
async def test_a_client_that_leaves_mid_body_costs_nothing(tsa_pki: TsaPki, parts: Parts) -> None:
    datum, _ = make_datum(tsa_pki.ec, parts=parts)
    app = build_app(datum)
    half = query_der()[:20]
    async with datum:
        sent = await call(
            app,
            path="/tsa",
            headers={"content-type": QUERY_TYPE},
            events=[{"type": "http.request", "body": half, "more_body": True}],
        )
    assert status_of(sent) is None
    assert parts.events == []
    assert parts.serials.allocations == 0
    assert parts.key.signs == 0


def test_with_clients_access_a_missing_or_unknown_key_is_401_with_the_challenge(tsa_pki: TsaPki) -> None:
    datum, parts = make_datum(tsa_pki.ec, config(tsa={"access": "clients", "clients": [key_hash(CLIENT_KEY)]}))
    with TestClient(build_app(datum)) as running:
        for headers in ({}, {"Authorization": "Bearer dtsa_wrong"}):
            reply = stamp(running, headers=headers)
            assert reply.status_code == 401
            assert reply.headers["www-authenticate"] == BASIC
            assert plain(reply)
    assert parts.events == []


def test_with_clients_access_the_key_admits_and_the_event_names_the_client_not_the_key(tsa_pki: TsaPki) -> None:
    datum, parts = make_datum(tsa_pki.ec, config(tsa={"access": "clients", "clients": [key_hash(CLIENT_KEY)]}))
    with TestClient(build_app(datum)) as running:
        assert stamp(running, headers={"Authorization": f"Bearer {CLIENT_KEY}"}).status_code == 200
    (event,) = parts.events
    assert getattr(event, "client", None)
    assert CLIENT_KEY not in repr(event)
    assert key_hash(CLIENT_KEY) not in repr(event)


def test_ten_wrong_keys_then_429_for_an_hour_and_the_right_key_still_passes(tsa_pki: TsaPki) -> None:
    datum, _ = make_datum(tsa_pki.ec, config(tsa={"access": "clients", "clients": [key_hash(CLIENT_KEY)]}))
    with TestClient(build_app(datum)) as running:
        statuses = [stamp(running, headers={"Authorization": f"Bearer dtsa_w{n}"}).status_code for n in range(11)]
        locked = stamp(running, headers={"Authorization": "Bearer dtsa_w99"})
        assert statuses == [401] * 10 + [429]
        assert locked.headers["retry-after"] == "3600"
        assert plain(locked)
        assert stamp(running, headers={"Authorization": f"Bearer {CLIENT_KEY}"}).status_code == 200


def test_the_flood_limit_is_429_with_retry_after_and_only_admitted_requests_count(tsa_pki: TsaPki) -> None:
    datum, _ = make_datum(tsa_pki.ec, config(tsa={"flood": {"limit": 2}}))
    with TestClient(build_app(datum)) as running:
        for _ in range(3):
            assert stamp(running, headers={"Content-Type": "text/plain"}).status_code == 415
        assert stamp(running).status_code == 200
        assert stamp(running).status_code == 200
        limited = stamp(running)
    assert limited.status_code == 429
    assert 1 <= int(limited.headers["retry-after"]) <= 3600
    assert plain(limited)


def test_every_step_in_order_with_every_fault_at_once(tsa_pki: TsaPki) -> None:
    cfg = config(tsa={"access": "clients", "clients": [key_hash(CLIENT_KEY)], "max_request_size": 8})
    datum, _ = make_datum(tsa_pki.ec, cfg)
    big = query_der()
    with TestClient(build_app(datum)) as running:
        everything = {"Cookie": "JSESSIONID=b", "Content-Type": "text/plain"}
        assert running.post("/tsa", content=big, headers=everything).status_code == 403
        assert running.post("/tsa", content=big, headers={"Content-Type": "text/plain"}).status_code == 415
        assert running.post("/tsa", content=big, headers={"Content-Type": QUERY_TYPE}).status_code == 401
        keyed = {"Content-Type": QUERY_TYPE, "Authorization": f"Bearer {CLIENT_KEY}"}
        assert running.post("/tsa", content=big, headers=keyed).status_code == 413


# -- the certificates --------------------------------------------------------------------------------------------------
def pem_certificates(body: bytes) -> list[bytes]:
    import base64  # noqa: PLC0415
    import re  # noqa: PLC0415

    found = re.findall(rb"-----BEGIN CERTIFICATE-----\s+(.*?)\s+-----END CERTIFICATE-----", body, re.DOTALL)
    return [base64.b64decode(block) for block in found]


def test_the_certificate_route_answers_the_chain_in_pem_leaf_first(client: Any, tsa_pki: TsaPki) -> None:
    reply = client.get("/tsa/certificate")
    assert reply.status_code == 200
    assert reply.content.startswith(PEM_BEGIN)
    assert pem_certificates(reply.content) == list(tsa_pki.ec.chain_der)


def test_format_der_answers_the_leaf_alone_as_pkix_cert(client: Any, tsa_pki: TsaPki) -> None:
    reply = client.get("/tsa/certificate", params={"format": "der"})
    assert reply.status_code == 200
    assert reply.headers["content-type"].partition(";")[0] == "application/pkix-cert"
    assert reply.content == tsa_pki.ec.leaf_der
    assert reply.content[0] == 0x30


def test_the_certificates_route_lists_the_current_chain_then_the_retired_ones(tmp_path: Path, tsa_pki: TsaPki) -> None:
    retired = tmp_path / "old.pem"
    retired.write_bytes(bytes_to_pem(tsa_pki.rsa.leaf_der))
    datum, _ = make_datum(tsa_pki.ec, config(tsa={"retired_certificates": [str(retired)]}))
    with TestClient(build_app(datum)) as running:
        everything = running.get("/tsa/certificates")
        current = running.get("/tsa/certificate")
    assert pem_certificates(everything.content) == [*tsa_pki.ec.chain_der, tsa_pki.rsa.leaf_der]
    assert pem_certificates(current.content) == list(tsa_pki.ec.chain_der)


def test_the_certificate_routes_need_no_key_and_refuse_nothing_but_the_started_guard(tsa_pki: TsaPki) -> None:
    datum, _ = make_datum(tsa_pki.ec, config(tsa={"access": "clients"}))
    with TestClient(build_app(datum)) as running:
        assert running.get("/tsa/certificate").status_code == 200
        assert running.get("/tsa/certificates").status_code == 200


def test_the_certificate_routes_never_carry_the_private_key(client: Any, tsa_pki: TsaPki) -> None:
    for path in ("/tsa/certificate", "/tsa/certificates", "/tsa/certificate?format=der"):
        body = client.get(path).content
        assert b"PRIVATE" not in body
        assert tsa_pki.ec.key_pem()[28:60] not in body


# -- the two policies, end to end --------------------------------------------------------------------------------------
def test_a_requested_accepted_policy_is_issued_and_a_foreign_one_is_400(client: Any) -> None:
    ok = stamp(client, query_der(policy=der_oid(OTHER_POLICY)))
    assert ok.status_code == 200
    assert parse_reply(ok.content).status == 0
    foreign = stamp(client, query_der(policy=der_oid("1.2.3.4")))
    assert foreign.status_code == 400
    assert parse_reply(foreign.content).fail_bits == {15}
    assert POLICY.encode() in foreign.content
    assert OTHER_POLICY.encode() in foreign.content
    assert b"1.2.3.4" not in foreign.content


def test_the_whole_app_still_serves_other_routes_alongside_the_tsa(tsa_pki: TsaPki) -> None:
    datum, _ = make_datum(tsa_pki.ec)
    app = FastAPI()
    app.include_router(routers.tsa(datum))

    @app.get("/ping")
    def ping() -> dict[str, bool]:
        return {"ok": True}

    with TestClient(app) as running:
        assert running.get("/ping").json() == {"ok": True}
        assert stamp(running).status_code == 200
