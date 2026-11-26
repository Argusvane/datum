"""`TimestampClient` over the default transport against a stub HTTP server on a thread (no mocking library).

The client is the weaker party's guard: it POSTs `application/timestamp-query`, asks for
`application/timestamp-reply`, sends a fresh random nonce, never follows a redirect (a 3xx is a refusal and the second
host sees nothing, credentials included), bounds the reply at 1 MiB and the wait at its timeout, requires a 200 whose
body is a TimeStampResp with PKIStatus 0 or 1, and checks the token's imprint, nonce and policy and `check()` before it
returns a grant. Every failure is a `TimestampClientError` with a stable `reason`; no message carries a credential, a
URL or a header. The outbound request carries no `traceparent`, `tracestate` or `baggage` even with a W3C propagator
installed and an active span, and the CLIENT span `datum.tsa.request` is a child of the caller's span.
"""

import contextlib
import datetime as dt
import logging
import re
import socket
import ssl
import threading
import time
import traceback
from collections.abc import Callable, Iterator, Mapping
from dataclasses import replace
from pathlib import Path
from typing import Any, cast

import anyio
import anyio.to_thread
import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID
from observe_support import telemetry
from opentelemetry import baggage, context, propagate, trace
from opentelemetry.baggage.propagation import W3CBaggagePropagator
from opentelemetry.propagators.composite import CompositePropagator
from opentelemetry.trace import SpanKind, StatusCode
from opentelemetry.trace.propagation.tracecontext import TraceContextTextMapPropagator
from tsa_der import DIGEST_LENGTHS, der_int, int_of, oid_of, parse, query_der, seq, token_parts
from tsa_stub import Behavior, Reply, Seen, StubServer, free_port, serving
from tsa_support import OTHER_POLICY, POLICY, make_authority, openssl_verify, sha256

from datum_core.config.models import TsaClientOptions
from datum_core.testing import requires_openssl
from datum_core.testing.tsa_pki import TsaPki
from datum_core.timestamp import (
    TimestampAuthority,
    TimestampClient,
    TimestampGrant,
    TimestampQuery,
    TimestampRefusal,
    TimestampRefusedError,
    TimestampToken,
    TransportReply,
    TsaTransport,
)
from datum_core.timestamp.client import TimestampClientError
from datum_core.timestamp.transport import HttpTsaTransport

REPLY = "application/timestamp-reply"
DIGEST = sha256(b"hello")
BEARER = "tok-ZZ-SECRET-BEARER-ZZ"
BASIC_USER = "svc-user"
BASIC_PASSWORD = "pw-ZZ-SECRET-BASIC-ZZ"
FORBIDDEN_HEADERS = {"traceparent", "tracestate", "baggage"}
MIB = 1024 * 1024


def options(server: StubServer, path: str = "/tsa", **fields: object) -> TsaClientOptions:
    fields.setdefault("timeout", 5)
    return TsaClientOptions.model_validate({"url": f"{server.url}{path}", **fields})


def honest(
    authority: TimestampAuthority,
    *,
    query_edit: Callable[[TimestampQuery], TimestampQuery] | None = None,
    reply_edit: Callable[[TimestampGrant], bytes] | None = None,
    content_type: str | None = REPLY,
) -> Behavior:
    """Answer every request with a real token; the edits change one thing about an otherwise good reply."""

    def behave(seen: Seen) -> Reply:
        query = TimestampQuery.parse(seen.body)
        if query_edit is not None:
            query = query_edit(query)
        grant = authority.issue(query)
        body = grant.response if reply_edit is None else reply_edit(grant)
        return Reply(200, {} if content_type is None else {"Content-Type": content_type}, body)

    return behave


def edited(query: TimestampQuery, **changes: Any) -> TimestampQuery:
    """Return `query` with the fields in `changes` replaced (`imprint`, `policy`, `nonce`, `cert_req`)."""
    return replace(query, **changes)


def failure_of(client: TimestampClient, **request: Any) -> TimestampClientError:
    with pytest.raises(TimestampClientError) as raised:
        client.request(DIGEST, "sha256", **request)
    return raised.value


@pytest.fixture
def authority(tsa_pki: TsaPki) -> TimestampAuthority:
    return make_authority(tsa_pki.ec)


# -- the request -------------------------------------------------------------------------------------------------------
def test_the_request_is_a_post_of_a_timestamp_query_asking_for_a_timestamp_reply(authority: TimestampAuthority) -> None:
    with serving(honest(authority)) as server:
        grant = TimestampClient(options(server)).request(DIGEST, "sha256")
    (seen,) = server.requests
    assert seen.method == "POST"
    assert seen.target == "/tsa"
    assert seen.header("Content-Type") == "application/timestamp-query"
    assert seen.header("Accept") == REPLY
    assert grant.response
    assert token_parts(grant.token).tst.imprint == DIGEST


def test_the_body_is_a_version_1_time_stamp_req_over_the_imprint_with_a_fresh_nonce(
    authority: TimestampAuthority,
) -> None:
    with serving(honest(authority)) as server:
        client = TimestampClient(options(server))
        client.request(DIGEST, "sha256")
        client.request(DIGEST, "sha256")
    first, second = (parse(seen.body) for seen in server.requests)
    for node in (first, second):
        assert int_of(node.children[0]) == 1
        imprint = node.children[1]
        assert oid_of(imprint.children[0].children[0]) == "2.16.840.1.101.3.4.2.1"
        assert imprint.children[1].content == DIGEST
    nonces = [next(c for c in node.children if c.tag == 0x02 and c is not node.children[0]) for node in (first, second)]
    assert nonces[0].content != nonces[1].content
    assert all(0 < len(n.content) <= 64 and n.content[0] < 0x80 for n in nonces)


@pytest.mark.parametrize("algorithm", ["sha256", "sha384", "sha512"])
def test_each_algorithm_is_sent_with_its_digest(authority: TimestampAuthority, algorithm: str) -> None:
    digest = bytes(range(DIGEST_LENGTHS[algorithm]))
    with serving(honest(authority)) as server:
        grant = TimestampClient(options(server)).request(digest, algorithm)
    assert TimestampQuery.parse(server.requests[0].body).imprint == digest
    assert token_parts(grant.token).tst.imprint == digest


def test_cert_req_true_is_asked_by_default_and_the_chain_comes_back(authority: TimestampAuthority) -> None:
    with serving(honest(authority)) as server:
        grant = TimestampClient(options(server)).request(DIGEST, "sha256")
    assert TimestampQuery.parse(server.requests[0].body).cert_req is True
    assert token_parts(grant.token).certificates


def test_cert_req_false_is_sent_as_the_caller_asks(authority: TimestampAuthority) -> None:
    with serving(lambda seen: Reply(500)) as server:
        failure_of(TimestampClient(options(server)), cert_req=False)
    assert TimestampQuery.parse(server.requests[0].body).cert_req is False


def test_a_policy_asked_is_named_in_the_request_and_a_token_under_it_is_taken(authority: TimestampAuthority) -> None:
    with serving(honest(authority)) as server:
        grant = TimestampClient(options(server)).request(DIGEST, "sha256", policy=OTHER_POLICY)
    assert TimestampQuery.parse(server.requests[0].body).policy == OTHER_POLICY
    assert token_parts(grant.token).tst.policy == OTHER_POLICY


def test_the_policy_option_is_asked_when_the_caller_names_none(authority: TimestampAuthority) -> None:
    with serving(honest(authority)) as server:
        TimestampClient(options(server, policy=OTHER_POLICY)).request(DIGEST, "sha256")
    assert TimestampQuery.parse(server.requests[0].body).policy == OTHER_POLICY


def test_with_no_policy_asked_the_servers_own_is_taken(authority: TimestampAuthority) -> None:
    with serving(honest(authority)) as server:
        grant = TimestampClient(options(server)).request(DIGEST, "sha256")
    assert TimestampQuery.parse(server.requests[0].body).policy is None
    assert token_parts(grant.token).tst.policy == POLICY


def test_the_grant_holds_the_whole_reply_and_the_token_the_kernel_completes_with(authority: TimestampAuthority) -> None:
    with serving(honest(authority)) as server:
        grant = TimestampClient(options(server)).request(DIGEST, "sha256")
    from tsa_der import parse_reply  # noqa: PLC0415

    assert parse_reply(grant.response).token == grant.token
    assert grant.serial == token_parts(grant.token).tst.serial


# -- hostile replies ---------------------------------------------------------------------------------------------------
def reason_for(authority: TimestampAuthority, behavior: Behavior, **request: object) -> TimestampClientError:
    with serving(behavior) as server:
        return failure_of(TimestampClient(options(server)), **request)


@pytest.mark.parametrize("status", [400, 401, 403, 404, 429, 500, 503])
def test_a_status_other_than_200_is_a_refusal_naming_the_status_alone(
    authority: TimestampAuthority, status: int
) -> None:
    error = reason_for(
        authority, lambda seen: Reply(status, {"Content-Type": "text/html"}, b"<html>ZZ-SERVER-WORDS</html>")
    )
    assert error.reason == "http-status"
    assert error.http_status == status
    assert "ZZ-SERVER-WORDS" not in str(error)


def test_a_200_that_is_text_html_is_refused_unread(authority: TimestampAuthority) -> None:
    ok = honest(authority, content_type="text/html")
    assert reason_for(authority, ok).reason == "content-type"


def test_a_200_with_no_content_type_is_refused(authority: TimestampAuthority) -> None:
    assert reason_for(authority, honest(authority, content_type=None)).reason == "content-type"


@pytest.mark.parametrize("body", [b"", b"not a TimeStampResp", b"\x30\x03\x02\x01", b"\x30\x80\x00\x00"])
def test_a_200_with_garbage_is_unreadable(authority: TimestampAuthority, body: bytes) -> None:
    error = reason_for(authority, lambda seen: Reply(200, {"Content-Type": REPLY}, body))
    assert error.reason == "unreadable"


def test_a_rejection_is_a_refusal_naming_the_status_the_failure_bits_and_the_servers_words(
    authority: TimestampAuthority,
) -> None:
    def reject(seen: Seen) -> Reply:
        return Reply(
            200,
            {"Content-Type": REPLY},
            authority.answer(query_der(b"\x01" * 20, algorithm_oid="1.3.14.3.2.26")).response,
        )

    error = reason_for(authority, reject)
    assert error.reason == "rejected"
    assert error.pki_status == 2
    assert error.fail_info == ("badAlg",)
    assert error.server_text


@pytest.mark.parametrize("pki_status", [3, 4, 5])
def test_waiting_and_revocation_statuses_are_refusals_without_a_token(
    authority: TimestampAuthority, pki_status: int
) -> None:
    body = seq(seq(der_int(pki_status)))
    error = reason_for(authority, lambda seen: Reply(200, {"Content-Type": REPLY}, body))
    assert error.reason == "pki-status"
    assert error.pki_status == pki_status


def test_a_rejection_that_carries_a_token_is_still_a_rejection(authority: TimestampAuthority) -> None:
    def hostile(grant: TimestampGrant) -> bytes:
        return seq(seq(der_int(2)), grant.token)

    error = reason_for(authority, honest(authority, reply_edit=hostile))
    assert error.reason == "rejected"


def test_granted_with_modifications_is_taken(authority: TimestampAuthority) -> None:
    def modified(grant: TimestampGrant) -> bytes:
        return seq(seq(der_int(1)), grant.token)

    with serving(honest(authority, reply_edit=modified)) as server:
        assert TimestampClient(options(server)).request(DIGEST, "sha256").token


def test_a_granted_status_with_no_token_is_unreadable(authority: TimestampAuthority) -> None:
    error = reason_for(authority, lambda seen: Reply(200, {"Content-Type": REPLY}, seq(seq(der_int(0)))))
    assert error.reason == "unreadable"


def test_a_token_over_another_imprint_is_no_token(authority: TimestampAuthority) -> None:
    other = honest(authority, query_edit=lambda q: edited(q, imprint=sha256(b"another value")))
    assert reason_for(authority, other).reason == "imprint"


def test_a_token_with_another_nonce_is_no_token(authority: TimestampAuthority) -> None:
    assert (
        reason_for(authority, honest(authority, query_edit=lambda q: edited(q, nonce=(q.nonce or 0) + 1))).reason
        == "nonce"
    )


def test_a_token_that_echoes_no_nonce_is_no_token(authority: TimestampAuthority) -> None:
    assert reason_for(authority, honest(authority, query_edit=lambda q: edited(q, nonce=None))).reason == "nonce"


def test_a_replayed_reply_to_an_earlier_request_is_no_token(authority: TimestampAuthority) -> None:
    kept: list[bytes] = []

    def replay(seen: Seen) -> Reply:
        if not kept:
            kept.append(authority.issue(TimestampQuery.parse(seen.body)).response)
        return Reply(200, {"Content-Type": REPLY}, kept[0])

    with serving(replay) as server:
        client = TimestampClient(options(server))
        client.request(DIGEST, "sha256")
        assert failure_of(client).reason == "nonce"


def test_a_token_under_a_policy_other_than_the_one_asked_is_no_token(authority: TimestampAuthority) -> None:
    other = honest(authority, query_edit=lambda q: edited(q, policy=OTHER_POLICY))
    with serving(other) as server:
        error = failure_of(TimestampClient(options(server)), policy=POLICY)
    assert error.reason == "policy"


def test_a_token_whose_signature_is_broken_is_no_token(tsa_pki: TsaPki) -> None:
    authority = make_authority(tsa_pki.rsa)

    def broken(grant: TimestampGrant) -> bytes:
        signature = token_parts(grant.token).signature
        flipped = signature[:-1] + bytes([signature[-1] ^ 1])
        assert grant.response.count(signature) == 1
        return grant.response.replace(signature, flipped)

    assert reason_for(authority, honest(authority, reply_edit=broken)).reason == "token"


def test_a_server_that_hangs_up_is_unreachable(authority: TimestampAuthority) -> None:
    assert reason_for(authority, lambda seen: Reply(hang_up=True)).reason == "unreachable"


def test_nothing_listening_is_unreachable() -> None:
    client = TimestampClient(
        TsaClientOptions.model_validate({"url": f"http://127.0.0.1:{free_port()}/tsa", "timeout": 2})
    )
    assert failure_of(client).reason == "unreachable"


# -- bounds ------------------------------------------------------------------------------------------------------------
def test_a_reply_past_1_mib_is_refused_and_one_at_the_cap_is_read_as_what_it_is(authority: TimestampAuthority) -> None:
    over = reason_for(authority, lambda seen: Reply(200, {"Content-Type": REPLY}, b"\x30" * (MIB + 1)))
    assert over.reason == "too-large"
    at_cap = reason_for(authority, lambda seen: Reply(200, {"Content-Type": REPLY}, b"\x30" * MIB))
    assert at_cap.reason == "unreadable"


def test_an_announced_length_past_the_cap_is_refused_before_the_body_arrives(authority: TimestampAuthority) -> None:
    started = time.monotonic()
    hostile = Reply(200, {"Content-Type": REPLY}, b"\x30" * 100, content_length=2 * MIB, trickle=0.05)
    error = reason_for(authority, lambda seen: hostile)
    assert error.reason == "too-large"
    assert time.monotonic() - started < 3


def test_a_reply_with_no_length_that_never_stops_is_cut_off_at_the_cap_not_read_to_the_end(
    authority: TimestampAuthority,
) -> None:
    started = time.monotonic()
    with serving(lambda seen: Reply(200, {"Content-Type": REPLY}, stream=8 * MIB)) as server:
        error = failure_of(TimestampClient(options(server)))
    assert error.reason == "too-large"
    assert time.monotonic() - started < 3
    assert server.written < 3 * MIB, server.written


def test_a_server_that_never_answers_is_cut_off_at_the_timeout(authority: TimestampAuthority) -> None:
    started = time.monotonic()
    with serving(lambda seen: Reply(200, {"Content-Type": REPLY}, b"x", delay=3)) as server:
        error = failure_of(TimestampClient(options(server, timeout=0.4)))
    assert error.reason == "unreachable"
    assert time.monotonic() - started < 2.5


def test_a_slow_loris_reply_is_bounded_by_the_whole_timeout_not_each_read(authority: TimestampAuthority) -> None:
    started = time.monotonic()
    slow = Reply(200, {"Content-Type": REPLY}, b"\x30" * 200, trickle=0.1)
    with serving(lambda seen: slow) as server:
        error = failure_of(TimestampClient(options(server, timeout=0.6)))
    assert error.reason == "unreachable"
    assert time.monotonic() - started < 3


# -- no redirect, and credentials only to the URL named ----------------------------------------------------------------
@pytest.mark.parametrize("status", [301, 302, 303, 307, 308])
def test_a_redirect_is_a_refusal_and_the_second_host_receives_nothing(
    authority: TimestampAuthority, status: int
) -> None:
    with serving(honest(authority)) as second:
        first_behavior: Behavior = lambda seen: Reply(status, {"Location": f"{second.url}/elsewhere"})  # noqa: E731
        with serving(first_behavior) as first:
            client = TimestampClient(options(first, bearer_token=BEARER))
            error = failure_of(client)
        assert second.requests == []
    assert error.reason == "redirect"
    assert error.http_status == status
    assert len(first.requests) == 1


def test_a_redirect_from_a_server_with_basic_credentials_sends_them_to_nobody_else(
    authority: TimestampAuthority,
) -> None:
    with serving(honest(authority)) as second:
        with serving(lambda seen: Reply(307, {"Location": f"{second.url}/tsa"})) as first:
            failure_of(TimestampClient(options(first, basic_user=BASIC_USER, basic_password=BASIC_PASSWORD)))
        assert second.requests == []


def test_a_transport_configured_to_follow_redirects_is_refused_at_construction() -> None:
    from datum_sandbox.checks import DatumConfigurationError  # noqa: PLC0415

    with pytest.raises(DatumConfigurationError):
        HttpTsaTransport(follow_redirects=True)


def test_a_bearer_token_goes_to_the_url_named_as_an_authorization_header(authority: TimestampAuthority) -> None:
    with serving(honest(authority)) as server:
        TimestampClient(options(server, bearer_token=BEARER)).request(DIGEST, "sha256")
    assert server.requests[0].header("Authorization") == f"Bearer {BEARER}"


def test_basic_credentials_go_as_basic_authorization(authority: TimestampAuthority) -> None:
    import base64  # noqa: PLC0415

    with serving(honest(authority)) as server:
        TimestampClient(options(server, basic_user=BASIC_USER, basic_password=BASIC_PASSWORD)).request(DIGEST, "sha256")
    expected = base64.b64encode(f"{BASIC_USER}:{BASIC_PASSWORD}".encode()).decode()
    assert server.requests[0].header("Authorization") == f"Basic {expected}"


def test_no_credentials_means_no_authorization_header_and_no_cookie(authority: TimestampAuthority) -> None:
    with serving(honest(authority)) as server:
        TimestampClient(options(server)).request(DIGEST, "sha256")
    assert {"authorization", "cookie", "proxy-authorization"}.isdisjoint(server.requests[0].names)


def test_the_credentials_appear_in_no_repr_no_error_no_log_and_no_url_text(
    authority: TimestampAuthority, caplog: pytest.LogCaptureFixture
) -> None:
    secrets = [BEARER, BASIC_PASSWORD, "urlpw-ZZ-SECRET-URL-ZZ"]
    with caplog.at_level(logging.DEBUG), serving(lambda seen: Reply(500, {}, b"no")) as server:
        client = TimestampClient(
            TsaClientOptions.model_validate(
                {
                    "url": f"http://urluser:urlpw-ZZ-SECRET-URL-ZZ@127.0.0.1:{server.port}/tsa",
                    "bearer_token": BEARER,
                    "basic_user": BASIC_USER,
                    "basic_password": BASIC_PASSWORD,
                    "timeout": 5,
                }
            )
        )
        error = failure_of(client)
        texts = [repr(client), str(client), str(error), repr(error), *map(str, error.args), caplog.text]
    for text in texts:
        for secret in secrets:
            assert secret not in text
    assert f"127.0.0.1:{server.port}" not in str(error), "the error names no URL"


# -- trace context is never sent to a third party ----------------------------------------------------------------------
@pytest.fixture
def w3c_propagation() -> Iterator[None]:
    previous = propagate.get_global_textmap()
    propagate.set_global_textmap(CompositePropagator([TraceContextTextMapPropagator(), W3CBaggagePropagator()]))
    try:
        yield
    finally:
        propagate.set_global_textmap(previous)


CREDENTIAL_SETS = [
    pytest.param({}, id="no-credentials"),
    pytest.param({"bearer_token": BEARER}, id="bearer"),
    pytest.param({"basic_user": BASIC_USER, "basic_password": BASIC_PASSWORD}, id="basic"),
]


@pytest.mark.parametrize("credentials", CREDENTIAL_SETS)
def test_no_traceparent_tracestate_or_baggage_leaves_even_with_a_w3c_propagator_and_an_active_span(
    authority: TimestampAuthority, w3c_propagation: None, credentials: dict[str, str]
) -> None:
    telemetry()
    tracer = trace.get_tracer("test")
    token = context.attach(baggage.set_baggage("tenant", "acme"))
    try:
        with tracer.start_as_current_span("caller"), serving(honest(authority)) as server:
            probe: dict[str, str] = {}
            propagate.inject(probe)
            assert "traceparent" in probe, "the propagator would have injected"
            TimestampClient(options(server, **credentials)).request(DIGEST, "sha256")
    finally:
        context.detach(token)
    for seen in server.requests:
        assert FORBIDDEN_HEADERS.isdisjoint(seen.names), seen.headers


@pytest.mark.parametrize("credentials", CREDENTIAL_SETS)
def test_every_header_the_stub_receives_is_one_the_client_built(
    authority: TimestampAuthority, credentials: dict[str, str]
) -> None:
    allowed = {
        "host",
        "content-type",
        "accept",
        "content-length",
        "user-agent",
        "authorization",
        "connection",
        "accept-encoding",
    }
    with serving(honest(authority)) as server:
        TimestampClient(options(server, **credentials)).request(DIGEST, "sha256")
    assert server.requests[0].names <= allowed, server.requests[0].headers
    if not credentials:
        assert "authorization" not in server.requests[0].names


def test_the_client_span_is_a_client_child_of_the_callers_span_and_names_no_url(
    authority: TimestampAuthority,
) -> None:
    spans = telemetry()
    tracer = trace.get_tracer("test")
    with tracer.start_as_current_span("seal") as parent, serving(honest(authority)) as server:
        TimestampClient(options(server, bearer_token=BEARER)).request(DIGEST, "sha256")
    (client_span,) = spans.spans("datum.tsa.request")
    assert client_span.kind is SpanKind.CLIENT
    assert client_span.parent is not None
    assert client_span.parent.span_id == parent.get_span_context().span_id
    assert client_span.status.status_code is not StatusCode.ERROR
    text = " ".join(f"{key}={value!s}" for key, value in (client_span.attributes or {}).items())
    assert "127.0.0.1" not in text
    assert "/tsa" not in text
    assert BEARER not in text
    assert all(key.startswith(("datum.", "error.")) for key in (client_span.attributes or {})), text


def test_a_failed_request_marks_the_span_with_the_error_type_and_still_names_no_url(
    authority: TimestampAuthority,
) -> None:
    spans = telemetry()
    with serving(lambda seen: Reply(503, {}, b"down")) as server:
        error = failure_of(TimestampClient(options(server)))
    (client_span,) = spans.spans("datum.tsa.request")
    assert client_span.status.status_code is StatusCode.ERROR
    assert (client_span.attributes or {}).get("error.type") == error.reason
    assert "127.0.0.1" not in " ".join(str(value) for value in (client_span.attributes or {}).values())


# -- TLS, proxies ------------------------------------------------------------------------------------------------------
def tls_material(directory: Path, *, dns_name: str | None = None) -> tuple[ssl.SSLContext, Path]:
    """A server context for 127.0.0.1 (`dns_name`: that name alone) under its own root; return it and the root's PEM."""
    now = dt.datetime.now(dt.UTC)
    root_key = ec.generate_private_key(ec.SECP256R1())
    root_name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Stub root")])
    root = (
        x509.CertificateBuilder()
        .subject_name(root_name)
        .issuer_name(root_name)
        .public_key(root_key.public_key())
        .serial_number(1)
        .not_valid_before(now - dt.timedelta(days=1))
        .not_valid_after(now + dt.timedelta(days=30))
        .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
        .add_extension(x509.KeyUsage(False, False, False, False, False, True, True, False, False), critical=True)
        .add_extension(x509.SubjectKeyIdentifier.from_public_key(root_key.public_key()), critical=False)
        .sign(root_key, hashes.SHA256())
    )
    key = ec.generate_private_key(ec.SECP256R1())
    leaf = (
        x509.CertificateBuilder()
        .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "127.0.0.1")]))
        .issuer_name(root_name)
        .public_key(key.public_key())
        .serial_number(2)
        .not_valid_before(now - dt.timedelta(days=1))
        .not_valid_after(now + dt.timedelta(days=30))
        .add_extension(
            x509.SubjectAlternativeName(
                [x509.DNSName(dns_name)]
                if dns_name is not None
                else [x509.IPAddress(__import__("ipaddress").ip_address("127.0.0.1"))]
            ),
            critical=False,
        )
        .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
        .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(root_key.public_key()), critical=False)
        .sign(root_key, hashes.SHA256())
    )
    cert_file = directory / "server.pem"
    key_file = directory / "server.key"
    root_file = directory / "root.pem"
    cert_file.write_bytes(leaf.public_bytes(serialization.Encoding.PEM))
    key_file.write_bytes(
        key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())
    )
    root_file.write_bytes(root.public_bytes(serialization.Encoding.PEM))
    context_ = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context_.load_cert_chain(cert_file, key_file)
    return context_, root_file


def test_tls_is_verified_against_ssl_cert_file_and_an_untrusted_server_is_refused(
    authority: TimestampAuthority, tsa_pki: TsaPki, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    server_context, root = tls_material(tmp_path)
    unrelated = tmp_path / "unrelated.pem"
    unrelated.write_bytes(tsa_pki.ec.root_pem)
    monkeypatch.delenv("SSL_CERT_DIR", raising=False)
    with serving(honest(authority), tls=server_context) as server:
        monkeypatch.setenv("SSL_CERT_FILE", str(root))
        assert TimestampClient(options(server)).request(DIGEST, "sha256").token
        monkeypatch.setenv("SSL_CERT_FILE", str(unrelated))
        assert failure_of(TimestampClient(options(server))).reason == "unreachable"


def test_no_tls_verification_is_ever_turned_off_in_the_timestamp_package() -> None:
    package = Path(__import__("datum_core.timestamp", fromlist=["x"]).__file__ or "").parent
    sources = {path.name: path.read_text(encoding="utf-8") for path in sorted(package.rglob("*.py"))}
    assert {"client.py", "transport.py"} <= set(sources), sorted(sources)
    forbidden = [
        r"check_hostname\s*=\s*False",
        r"setattr\([^)]*check_hostname",
        r"CERT_NONE",
        r"verify_mode",
        r"_create_unverified_context",
        r"verify\s*=\s*False",
    ]
    for name, text in sources.items():
        for pattern in forbidden:
            assert re.search(pattern, text) is None, (name, pattern)


def test_the_server_certificate_must_name_the_host_even_when_it_chains_to_the_trusted_root(
    authority: TimestampAuthority, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    server_context, root = tls_material(tmp_path, dns_name="other.example")
    monkeypatch.delenv("SSL_CERT_DIR", raising=False)
    monkeypatch.setenv("SSL_CERT_FILE", str(root))
    with serving(honest(authority), tls=server_context) as server:
        assert failure_of(TimestampClient(options(server))).reason == "unreachable"
        assert server.requests == []


def test_https_proxy_is_honoured_for_an_https_url_by_a_connect_that_carries_no_credentials(
    authority: TimestampAuthority, monkeypatch: pytest.MonkeyPatch
) -> None:
    with serving(lambda seen: Reply(502, {}, b"no tunnel")) as proxy:
        monkeypatch.setenv("HTTPS_PROXY", f"http://127.0.0.1:{proxy.port}")
        monkeypatch.delenv("NO_PROXY", raising=False)
        monkeypatch.delenv("no_proxy", raising=False)
        client = TimestampClient(
            TsaClientOptions.model_validate(
                {"url": "https://tsa.invalid.example/tsa", "bearer_token": BEARER, "timeout": 3}
            )
        )
        error = failure_of(client)
    assert error.reason == "unreachable"
    (seen,) = proxy.requests
    assert seen.method == "CONNECT"
    assert seen.target == "tsa.invalid.example:443"
    assert "authorization" not in seen.names
    assert BEARER not in str(error)


def test_no_proxy_lets_a_listed_host_go_direct(authority: TimestampAuthority, monkeypatch: pytest.MonkeyPatch) -> None:
    with serving(lambda seen: Reply(500)) as proxy, serving(honest(authority)) as server:
        monkeypatch.setenv("HTTP_PROXY", f"http://127.0.0.1:{proxy.port}")
        monkeypatch.setenv("NO_PROXY", "127.0.0.1")
        assert TimestampClient(options(server)).request(DIGEST, "sha256").token
        assert proxy.requests == []
        assert len(server.requests) == 1


# -- the seam ----------------------------------------------------------------------------------------------------------
def test_a_transport_the_application_hands_in_replaces_the_default(authority: TimestampAuthority) -> None:
    from datum_core.timestamp import TransportReply  # noqa: PLC0415

    calls: list[tuple[str, dict[str, str], float]] = []

    class Mine:
        def post(
            self, url: str, body: bytes, *, content_type: str, accept: str, headers: Mapping[str, str], timeout: float
        ) -> TransportReply:
            calls.append((url, dict(headers), timeout))
            grant = authority.issue(TimestampQuery.parse(body))
            return TransportReply(200, REPLY, grant.response)

    client = TimestampClient(
        TsaClientOptions.model_validate({"url": "https://tsa.example.test/tsa", "bearer_token": BEARER, "timeout": 7}),
        transport=Mine(),
    )
    assert client.request(DIGEST, "sha256").token
    ((url, headers, timeout),) = calls
    assert url == "https://tsa.example.test/tsa"
    assert headers.get("Authorization") == f"Bearer {BEARER}"
    assert timeout == 7


def test_a_transport_that_raises_is_unreachable_and_its_words_stay_out_of_the_error(
    authority: TimestampAuthority,
) -> None:
    class Down:
        def post(self, *args: object, **kwargs: object) -> object:
            raise OSError("connect to db.internal.example failed")

    client = TimestampClient(
        TsaClientOptions.model_validate({"url": "https://tsa.example.test/tsa", "timeout": 3}),
        transport=cast("TsaTransport", Down()),
    )
    error = failure_of(client)
    assert error.reason == "unreachable"
    assert "db.internal.example" not in str(error)


def test_two_clients_calling_at_once_do_not_share_a_nonce(authority: TimestampAuthority) -> None:
    with serving(honest(authority)) as server:
        client = TimestampClient(options(server))
        barrier = threading.Barrier(4)

        def call() -> None:
            barrier.wait(10)
            for _ in range(3):
                client.request(DIGEST, "sha256")

        threads = [threading.Thread(target=call) for _ in range(4)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(30)
    nonces = [TimestampQuery.parse(seen.body).nonce for seen in server.requests]
    assert len(nonces) == 12
    assert len(set(nonces)) == 12


# -- what the PDF seal and a verifier rely on --------------------------------------------------------------------------
@requires_openssl
def test_openssl_verifies_the_reply_the_client_returned_against_the_request_it_sent(
    authority: TimestampAuthority, tsa_pki: TsaPki, tmp_path: Path
) -> None:
    with serving(honest(authority)) as server:
        grant = TimestampClient(options(server)).request(DIGEST, "sha256")
    sent = server.requests[0].body
    by_query = openssl_verify(tmp_path, grant.response, root_pem=tsa_pki.ec.root_pem, query=sent)
    assert by_query.returncode == 0, by_query.stderr
    assert b"Verification: OK" in by_query.stdout + by_query.stderr
    by_data = openssl_verify(tmp_path, grant.response, root_pem=tsa_pki.ec.root_pem, data=b"hello")
    assert by_data.returncode == 0, by_data.stderr
    wrong_root = openssl_verify(tmp_path, grant.response, root_pem=tsa_pki.rsa.root_pem, query=sent)
    assert wrong_root.returncode != 0


def test_the_grant_is_the_whole_reply_and_the_parsed_token_checks_and_verifies_with_no_pdf_code(
    authority: TimestampAuthority,
) -> None:
    with serving(honest(authority)) as server:
        grant = TimestampClient(options(server)).request(DIGEST, "sha256")
    parsed = grant.parsed
    assert isinstance(parsed, TimestampToken)
    assert parsed.der == grant.token
    assert (parsed.serial, parsed.gen_time) == (grant.serial, grant.gen_time)
    assert parsed.check() == ()
    assert parsed.verify_over(b"hello") == ()
    assert parsed.verify_over(b"other") == ("imprint",)
    assert grant.response.endswith(grant.token), "the response is the status followed by the token, byte for byte"
    assert isinstance(grant, TimestampGrant)


def test_a_request_for_no_certificates_gives_a_token_the_caller_checks_with_the_certificate_it_holds(
    authority: TimestampAuthority, tsa_pki: TsaPki
) -> None:
    with serving(honest(authority)) as server:
        grant = TimestampClient(options(server)).request(DIGEST, "sha256", cert_req=False)
    assert grant.parsed.certificates == ()
    assert grant.parsed.check() == ("signature",), "no certificate, no verdict"
    assert grant.parsed.check(known_certificates=[tsa_pki.ec.leaf_der]) == ()
    assert grant.parsed.verify_over(b"hello", known_certificates=[tsa_pki.ec.leaf_der]) == ()


def test_a_server_that_ignores_cert_req_gives_a_token_with_no_signer_to_find_and_so_no_token(
    authority: TimestampAuthority,
) -> None:
    ignoring = honest(authority, query_edit=lambda q: edited(q, cert_req=False))
    assert reason_for(authority, ignoring).reason == "token"


def test_the_channel_a_seal_or_a_receipt_names_changes_nothing_sent(authority: TimestampAuthority) -> None:
    with serving(honest(authority)) as server:
        client = TimestampClient(options(server))
        client.request(DIGEST, "sha256", channel="receipt")
        client.request(DIGEST, "sha256", channel="seal")
    first, second = server.requests
    assert first.names == second.names


def test_the_words_of_a_rejection_are_printable_ascii_and_cut_short(authority: TimestampAuthority) -> None:
    hostile = "first\r\nInjected: header\x00" + chr(0x202E) + "A" * 500
    body = TimestampRefusal.of(TimestampRefusedError("badRequest", hostile)).to_der()
    error = reason_for(authority, lambda seen: Reply(200, {"Content-Type": REPLY}, body))
    assert error.reason == "rejected"
    assert error.fail_info == ("badRequest",)
    assert error.server_text is not None
    assert len(error.server_text) <= 200
    assert all(" " <= ch <= "~" for ch in error.server_text)
    assert "\r" not in str(error)
    assert "\n" not in str(error)


def test_a_content_type_with_parameters_and_capitals_is_the_reply_media_type(authority: TimestampAuthority) -> None:
    with serving(honest(authority, content_type="Application/Timestamp-Reply; charset=binary")) as server:
        assert TimestampClient(options(server)).request(DIGEST, "sha256").token


def test_a_client_error_pickles_and_copies_with_all_of_its_facts() -> None:
    import copy  # noqa: PLC0415
    import pickle  # noqa: PLC0415

    error = TimestampClientError("rejected", pki_status=2, fail_info=("badAlg",), server_text="words")
    for twin in (pickle.loads(pickle.dumps(error)), copy.copy(error)):  # noqa: S301 - our own value
        assert (twin.reason, twin.pki_status, twin.fail_info, twin.server_text) == ("rejected", 2, ("badAlg",), "words")
        assert str(twin) == str(error)


# -- construction ------------------------------------------------------------------------------------------------------
@pytest.mark.parametrize(
    "fields",
    [
        pytest.param({"url": None}, id="no-url"),
        pytest.param({"url": "ftp://tsa.example.test/ts"}, id="scheme"),
        pytest.param({"url": "https://"}, id="no-host"),
        pytest.param({"url": "https://tsa.example.test/ts", "basic_user": "only-user"}, id="user-without-password"),
        pytest.param({"url": "https://tsa.example.test/ts", "basic_password": "only-pw"}, id="password-without-user"),
        pytest.param({"url": "https://tsa.example.test/ts", "basic_user": "a:b", "basic_password": "x"}, id="colon"),
    ],
)
def test_options_the_client_cannot_use_are_refused_at_construction_without_echoing_them(
    fields: dict[str, object],
) -> None:
    from datum_sandbox.checks import DatumConfigurationError  # noqa: PLC0415

    with pytest.raises(DatumConfigurationError) as raised:
        TimestampClient(TsaClientOptions.model_validate(fields))
    for fragment in ("tsa.example.test", "only-user", "only-pw", "a:b"):
        assert fragment not in str(raised.value)


def test_a_transport_that_says_it_follows_redirects_is_refused_at_construction() -> None:
    from datum_sandbox.checks import DatumConfigurationError  # noqa: PLC0415

    class Following:
        follow_redirects = True

        def post(self, *args: object, **kwargs: object) -> object:
            raise AssertionError

    with pytest.raises(DatumConfigurationError):
        TimestampClient(
            TsaClientOptions.model_validate({"url": "https://tsa.example.test/ts"}),
            transport=cast("TsaTransport", Following()),
        )


def test_the_user_info_of_the_url_is_the_basic_credential_and_is_never_sent_in_the_request_itself(
    authority: TimestampAuthority,
) -> None:
    import base64  # noqa: PLC0415

    with serving(honest(authority)) as server:
        url = TsaClientOptions.model_validate(
            {"url": f"http://u%40ser:p%3Aw@127.0.0.1:{server.port}/tsa?x=1", "timeout": 5}
        )
        TimestampClient(url).request(DIGEST, "sha256")
    (seen,) = server.requests
    assert seen.target == "/tsa?x=1"
    assert seen.header("Host") == f"127.0.0.1:{server.port}"
    expected = base64.b64encode(b"u@ser:p:w").decode()
    assert seen.header("Authorization") == f"Basic {expected}"
    assert "u%40ser" not in repr(seen.headers)


def test_the_bearer_token_wins_over_basic_credentials_and_the_url_user_info(authority: TimestampAuthority) -> None:
    with serving(honest(authority)) as server:
        options_ = TsaClientOptions.model_validate(
            {
                "url": f"http://urluser:urlpw@127.0.0.1:{server.port}/tsa",
                "bearer_token": BEARER,
                "basic_user": BASIC_USER,
                "basic_password": BASIC_PASSWORD,
            }
        )
        TimestampClient(options_).request(DIGEST, "sha256")
    assert server.requests[0].header("Authorization") == f"Bearer {BEARER}"


def test_instrumentation_is_told_to_stand_aside_while_the_transport_runs(authority: TimestampAuthority) -> None:
    from opentelemetry.context import (  # noqa: PLC0415
        _SUPPRESS_INSTRUMENTATION_KEY,  # pyright: ignore[reportPrivateUsage]
    )

    seen: list[object] = []

    class Watching:
        def post(self, url: str, body: bytes, **kwargs: Any) -> TransportReply:
            seen.append(context.get_value(_SUPPRESS_INSTRUMENTATION_KEY))
            return TransportReply(200, REPLY, authority.issue(TimestampQuery.parse(body)).response)

    client = TimestampClient(
        TsaClientOptions.model_validate({"url": "https://tsa.example.test/ts"}),
        transport=cast("TsaTransport", Watching()),
    )
    client.request(DIGEST, "sha256")
    assert seen == [True]
    assert context.get_value(_SUPPRESS_INSTRUMENTATION_KEY) is None, "the context is restored"


def test_a_transport_the_application_hands_in_is_given_the_url_without_its_user_info(
    authority: TimestampAuthority,
) -> None:
    urls: list[str] = []

    class Mine:
        def post(self, url: str, body: bytes, **kwargs: Any) -> TransportReply:
            urls.append(url)
            return TransportReply(200, REPLY, authority.issue(TimestampQuery.parse(body)).response)

    client = TimestampClient(
        TsaClientOptions.model_validate({"url": "https://urluser:urlpw@tsa.example.test:8443/ts?x=1"}),
        transport=cast("TsaTransport", Mine()),
    )
    client.request(DIGEST, "sha256")
    assert urls == ["https://tsa.example.test:8443/ts?x=1"]


# -- one deadline for the whole call: the head, a chunk-size line and the handshake are bounded too --------------------
@contextlib.contextmanager
def trickling(payload: bytes, delay: float) -> Iterator[int]:
    """A raw socket server: read the request head, then send `payload` one byte per `delay` seconds."""
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    listener.listen(1)
    listener.settimeout(0.1)
    stop = threading.Event()

    def serve() -> None:
        connection: socket.socket | None = None
        while connection is None and not stop.is_set():
            with contextlib.suppress(TimeoutError):
                connection, _ = listener.accept()
        if connection is None:
            return
        with connection:
            connection.settimeout(0.1)
            seen = b""
            while b"\r\n\r\n" not in seen and not stop.is_set():
                with contextlib.suppress(TimeoutError, OSError):
                    seen += connection.recv(4096) or b"\r\n\r\n"
            for index in range(len(payload)):
                try:
                    connection.sendall(payload[index : index + 1])
                except OSError:
                    return
                if stop.wait(delay):
                    return

    thread = threading.Thread(target=serve, daemon=True)
    thread.start()
    try:
        yield int(listener.getsockname()[1])
    finally:
        stop.set()
        thread.join(10)
        listener.close()


_HEAD = b"HTTP/1.1 200 OK\r\nContent-Type: application/timestamp-reply\r\n"


@pytest.mark.parametrize(
    ("scheme", "payload"),
    [
        pytest.param("http", _HEAD + b"X-Pad: " + b"a" * 100 + b"\r\nContent-Length: 0\r\n\r\n", id="head"),
        pytest.param(
            "http",
            _HEAD + b"Transfer-Encoding: chunked\r\n\r\n1;" + b"a" * 100 + b"\r\nx\r\n0\r\n\r\n",
            id="chunk-line",
        ),
        pytest.param("https", b"\x16\x03\x03\x00\xff" + b"a" * 250, id="tls-handshake"),
    ],
)
def test_a_server_that_trickles_its_head_a_chunk_line_or_its_handshake_is_cut_off_at_the_whole_timeout(
    scheme: str, payload: bytes
) -> None:
    started = time.monotonic()
    with trickling(payload, 0.1) as port:
        client = TimestampClient(
            TsaClientOptions.model_validate({"url": f"{scheme}://127.0.0.1:{port}/tsa", "timeout": 0.6})
        )
        error = failure_of(client)
    assert error.reason == "unreachable"
    assert time.monotonic() - started < 3


# -- no credential in a traceback's frame locals ----------------------------------------------------------------------
def frame_locals(error: BaseException) -> str:
    """Every local of every `datum_core` frame in `error`'s traceback chain, as a locals-capturing reporter shows."""
    lines: list[str] = []
    pending: list[traceback.TracebackException | None] = [
        traceback.TracebackException.from_exception(error, capture_locals=True)
    ]
    while pending:
        current = pending.pop()
        if current is None:
            continue
        for frame in current.stack:
            if "datum_core" in frame.filename:
                lines.extend(f"{name}={value}" for name, value in (frame.locals or {}).items())
        pending.extend([current.__cause__, current.__context__])
    return "\n".join(lines)


def test_the_credentials_are_in_no_traceback_frame_of_an_unreachable_error_or_a_refused_construction() -> None:
    from datum_sandbox.checks import DatumConfigurationError  # noqa: PLC0415

    url_secret = "urlpw-ZZ-SECRET-URL-ZZ"
    client = TimestampClient(
        TsaClientOptions.model_validate(
            {"url": f"http://urluser:{url_secret}@127.0.0.1:{free_port()}/tsa", "bearer_token": BEARER, "timeout": 2}
        )
    )
    unreachable = failure_of(client)
    assert unreachable.reason == "unreachable"
    with pytest.raises(DatumConfigurationError) as refused:
        TimestampClient(
            TsaClientOptions.model_validate(
                {"url": f"http://urluser:{url_secret}@tsa.example.test/ts", "basic_user": "only-user"}
            )
        )
    for error in (unreachable, refused.value):
        text = frame_locals(error)
        assert text, "the probe saw some frames"
        for secret in (BEARER, url_secret):
            assert secret not in text


# -- the proxy never sees an http request or its credentials ----------------------------------------------------
def test_an_http_url_through_http_proxy_is_tunnelled_by_connect_and_the_proxy_sees_no_request_header(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    with serving(lambda seen: Reply(502, {}, b"no tunnel")) as proxy:
        monkeypatch.setenv("HTTP_PROXY", f"http://127.0.0.1:{proxy.port}")
        monkeypatch.delenv("NO_PROXY", raising=False)
        monkeypatch.delenv("no_proxy", raising=False)
        client = TimestampClient(TsaClientOptions.model_validate({"url": "http://tsa.example.test/tsa", "timeout": 3}))
        error = failure_of(client)
    assert error.reason == "unreachable"
    (seen,) = proxy.requests
    assert seen.method == "CONNECT"
    assert seen.target == "tsa.example.test:80"
    assert "authorization" not in seen.names


# -- the token must be the signer's own, not only validly signed ------------------------------------------------------
def test_a_token_carrying_a_look_alike_of_the_signers_certificate_is_no_token(tsa_pki: TsaPki) -> None:
    authority = make_authority(tsa_pki.rsa)
    leaf = tsa_pki.rsa.leaf_der
    alike = tsa_pki.look_alike(tsa_pki.rsa)
    assert len(alike) == len(leaf)

    def swapped(grant: TimestampGrant) -> bytes:
        assert grant.response.count(leaf) == 1
        return grant.response.replace(leaf, alike)

    assert reason_for(authority, honest(authority, reply_edit=swapped)).reason == "token"


def test_a_token_issued_outside_its_signers_validity_is_no_token(tsa_pki: TsaPki) -> None:
    authority = make_authority(tsa_pki.ec, now=lambda: dt.datetime(2040, 6, 1, tzinfo=dt.UTC))
    assert reason_for(authority, honest(authority)).reason == "token"


# -- spans and trace context on every path ----------------------------------------------------------------------------
def test_an_unexpected_exception_in_the_exchange_still_marks_the_span(
    authority: TimestampAuthority, monkeypatch: pytest.MonkeyPatch
) -> None:
    def boom(self: object, *args: object, **kwargs: object) -> tuple[str, ...]:
        raise RuntimeError("boom")

    monkeypatch.setattr(TimestampToken, "verify_digest", boom)
    spans = telemetry()
    with serving(honest(authority)) as server, pytest.raises(RuntimeError):
        TimestampClient(options(server)).request(DIGEST, "sha256")
    (client_span,) = spans.spans("datum.tsa.request")
    assert client_span.status.status_code is StatusCode.ERROR
    assert (client_span.attributes or {}).get("error.type") == "RuntimeError"
    assert (client_span.attributes or {}).get("datum.outcome") == "refused"


def test_the_span_and_the_headers_are_right_when_the_runner_calls_from_a_worker_thread(
    authority: TimestampAuthority, w3c_propagation: None
) -> None:
    spans = telemetry()
    tracer = trace.get_tracer("test")
    with serving(honest(authority)) as server:
        client = TimestampClient(options(server, bearer_token=BEARER))

        async def run() -> int:
            with tracer.start_as_current_span("seal") as parent:
                await anyio.to_thread.run_sync(lambda: client.request(DIGEST, "sha256"))
                return parent.get_span_context().span_id

        parent_id = anyio.run(run)
    (client_span,) = spans.spans("datum.tsa.request")
    assert client_span.parent is not None
    assert client_span.parent.span_id == parent_id
    for seen in server.requests:
        assert FORBIDDEN_HEADERS.isdisjoint(seen.names), seen.headers


@pytest.mark.parametrize(
    "behavior",
    [
        pytest.param(lambda seen: Reply(503, {}, b"down"), id="refusal"),
        pytest.param(lambda seen: Reply(302, {"Location": "http://127.0.0.1:9/x"}), id="redirect"),
        pytest.param(lambda seen: Reply(hang_up=True), id="unreachable"),
    ],
)
def test_no_trace_context_leaves_on_a_failing_path_either(behavior: Behavior, w3c_propagation: None) -> None:
    telemetry()
    tracer = trace.get_tracer("test")
    token = context.attach(baggage.set_baggage("tenant", "acme"))
    try:
        with tracer.start_as_current_span("caller"), serving(behavior) as server:
            failure_of(TimestampClient(options(server, bearer_token=BEARER)))
    finally:
        context.detach(token)
    assert server.requests
    for seen in server.requests:
        assert FORBIDDEN_HEADERS.isdisjoint(seen.names), seen.headers


# -- credentials never cross a plain-http network ----------------------------------------------------------
PLAIN_CREDENTIALS = [
    pytest.param({"bearer_token": BEARER}, "bearer_token", id="bearer"),
    pytest.param({"basic_user": BASIC_USER, "basic_password": BASIC_PASSWORD}, "basic_user", id="basic"),
    pytest.param(
        {"url": "http://urluser:urlpw-ZZ-SECRET-URL-ZZ@tsa.example.test/ts"}, "url (user-info)", id="user-info"
    ),
]


@pytest.mark.parametrize(("fields", "named"), PLAIN_CREDENTIALS)
def test_credentials_for_an_http_url_that_is_not_loopback_are_refused_at_construction(
    fields: dict[str, object], named: str
) -> None:
    """Red against the pre-change client, which sent the credentials in clear to any http host."""
    from datum_sandbox.checks import DatumConfigurationError  # noqa: PLC0415

    merged = {"url": "http://tsa.example.test/ts", **fields}
    with pytest.raises(DatumConfigurationError) as raised:
        TimestampClient(TsaClientOptions.model_validate(merged))
    text = str(raised.value) + " " + (raised.value.hint or "")
    assert named in text
    for fragment in ("tsa.example.test", BEARER, BASIC_PASSWORD, "urlpw-ZZ-SECRET-URL-ZZ", BASIC_USER):
        assert fragment not in text


@pytest.mark.parametrize("host", ["127.0.0.1", "127.9.8.7", "[::1]", "localhost", "LOCALHOST", "localhost."], ids=str)
@pytest.mark.parametrize("fields", [p.values[0] for p in PLAIN_CREDENTIALS[:2]], ids=["bearer", "basic"])
def test_credentials_for_a_loopback_http_url_are_allowed(host: str, fields: dict[str, object]) -> None:
    TimestampClient(TsaClientOptions.model_validate({"url": f"http://{host}:9/ts", **fields}))
    TimestampClient(TsaClientOptions.model_validate({"url": f"http://user:pw@{host}:9/ts"}))


@pytest.mark.parametrize(
    "host", ["128.0.0.1", "10.0.0.1", "[2001:db8::1]", "localhost.example.test", "127.0.0.1.evil.test"]
)
def test_a_host_that_only_looks_like_loopback_is_not_loopback(host: str) -> None:
    from datum_sandbox.checks import DatumConfigurationError  # noqa: PLC0415

    with pytest.raises(DatumConfigurationError):
        TimestampClient(TsaClientOptions.model_validate({"url": f"http://{host}/ts", "bearer_token": BEARER}))


def test_credentials_for_an_https_url_are_allowed_and_plain_http_without_credentials_too() -> None:
    TimestampClient(TsaClientOptions.model_validate({"url": "https://tsa.example.test/ts", "bearer_token": BEARER}))
    TimestampClient(
        TsaClientOptions.model_validate(
            {"url": "https://u:p@tsa.example.test/ts", "basic_user": BASIC_USER, "basic_password": BASIC_PASSWORD}
        )
    )
    TimestampClient(TsaClientOptions.model_validate({"url": "http://tsa.example.test/ts"}))


@pytest.mark.parametrize("bad", ["a\rb", "a\nb", "a\x00b", "tok\r\nX-Injected: 1"], ids=["cr", "lf", "nul", "crlf"])
def test_a_bearer_token_with_a_line_break_or_nul_is_refused_at_construction(bad: str) -> None:
    """Red against the pre-change client, which built the header from it (as `basic_user` is already refused)."""
    from datum_sandbox.checks import DatumConfigurationError  # noqa: PLC0415

    with pytest.raises(DatumConfigurationError) as raised:
        TimestampClient(TsaClientOptions.model_validate({"url": "https://tsa.example.test/ts", "bearer_token": bad}))
    assert "bearer_token" in str(raised.value)
    assert "X-Injected" not in str(raised.value)


# -- the client's own size and imprint-algorithm checks ----------------------------------------------------------------
def handed_in(reply: Callable[[bytes], TransportReply]) -> TimestampClient:
    class Mine:
        def post(
            self, url: str, body: bytes, *, content_type: str, accept: str, headers: Mapping[str, str], timeout: float
        ) -> TransportReply:
            return reply(body)

    return TimestampClient(
        TsaClientOptions.model_validate({"url": "https://tsa.example.test/tsa", "timeout": 3}), transport=Mine()
    )


def test_a_handed_in_transport_that_returns_more_than_1_mib_is_too_large() -> None:
    """Red against a mutant that drops the client's own size check (the reply then reads `unreadable`)."""
    over = failure_of(handed_in(lambda body: TransportReply(200, REPLY, b"\x30" * (MIB + 1))))
    assert over.reason == "too-large"
    at_cap = failure_of(handed_in(lambda body: TransportReply(200, REPLY, b"\x30" * MIB)))
    assert at_cap.reason == "unreadable"


@pytest.mark.parametrize("other", ["sha384", "sha512"])
def test_the_same_bytes_under_another_hash_algorithm_are_not_the_imprint_asked(
    authority: TimestampAuthority, other: str
) -> None:
    """The same 32 bytes under another hash OID are `imprint`; red against a mutant that compares bytes alone."""

    def relabelled(query: TimestampQuery) -> TimestampQuery:
        twin = edited(query)  # a copy; the constructor would refuse 32 bytes under another algorithm, so set it after
        object.__setattr__(twin, "imprint_algorithm", other)
        return twin

    behavior = honest(authority, query_edit=relabelled)
    assert reason_for(authority, behavior).reason == "imprint"


# -- the failure span carries exactly the outcome and the error type ---------------------------------------------------
def test_a_failed_request_span_has_exactly_the_outcome_and_the_error_type_unreachable() -> None:
    spans = telemetry()
    client = TimestampClient(
        TsaClientOptions.model_validate({"url": f"http://127.0.0.1:{free_port()}/tsa", "timeout": 2})
    )
    assert failure_of(client).reason == "unreachable"
    (client_span,) = spans.spans("datum.tsa.request")
    assert dict(client_span.attributes or {}) == {"datum.outcome": "refused", "error.type": "unreachable"}


def test_a_failed_request_span_has_exactly_the_outcome_and_the_error_type_too_large() -> None:
    spans = telemetry()
    assert failure_of(handed_in(lambda body: TransportReply(200, REPLY, b"\x30" * (MIB + 1)))).reason == "too-large"
    (client_span,) = spans.spans("datum.tsa.request")
    assert dict(client_span.attributes or {}) == {"datum.outcome": "refused", "error.type": "too-large"}
    assert set(client_span.attributes or {}) == {"datum.outcome", "error.type"}
