"""`TimestampIssuedEvent` and `TimestampRefusedEvent`, and the span `datum.tsa.issue`.

Both events are frozen slotted dataclasses of scalars, in `datum_core.events`. `TimestampIssuedEvent` is published after
the token (and the log row), a refusal publishes `TimestampRefusedEvent` only; `client` is the store's client id,
never a key or a hash. A listener that raises changes no answer and the next listener still runs. The span carries
`datum.channel` and `datum.outcome` (`granted`), and `error.type` set to the RFC 3161 failure name on a refusal; it
never carries an imprint, a nonce, a serial, a key or a client key.
"""

import dataclasses
import logging
from datetime import datetime
from typing import Any

import pytest
from observe_support import telemetry
from opentelemetry.trace import StatusCode
from submissions_support import assign
from tsa_der import query_der, token_parts
from tsa_support import (
    CLIENT_KEY,
    IdentityKey,
    ListLog,
    key_hash,
    make_authority,
    query_of,
    sha256,
    started_tsa,
    tsa_config,
)

from datum_core.events import (
    DatumEvent,
    EventDispatcher,
    TimestampIssuedEvent,
    TimestampRefusedEvent,
    listener,
)
from datum_core.loggers import EVENTS
from datum_core.testing.tsa_pki import INSTANT, TsaPki
from datum_core.timestamp import TimestampRefusedError

SCALARS = (int, float, str, bool, type(None))


def test_the_issued_event_is_a_frozen_slotted_record_of_the_four_fields() -> None:
    fields = {field.name for field in dataclasses.fields(TimestampIssuedEvent)}
    assert fields == {"serial", "gen_time", "imprint_algorithm", "client"}
    event = TimestampIssuedEvent(serial=7, gen_time=INSTANT, imprint_algorithm="sha256", client=None)
    assert isinstance(event, DatumEvent)
    assert not hasattr(event, "__dict__")
    with pytest.raises(dataclasses.FrozenInstanceError):
        assign(event, "serial", 8)


def test_the_refused_event_is_a_frozen_slotted_record_of_the_two_fields() -> None:
    assert {field.name for field in dataclasses.fields(TimestampRefusedEvent)} == {"fail_info", "reason"}
    event = TimestampRefusedEvent(fail_info="badAlg", reason="Words.")
    assert isinstance(event, DatumEvent)
    assert not hasattr(event, "__dict__")
    with pytest.raises(dataclasses.FrozenInstanceError):
        assign(event, "reason", "x")


def test_both_events_hold_scalars_only() -> None:
    issued = TimestampIssuedEvent(serial=1, gen_time=INSTANT, imprint_algorithm="sha256", client="client-1")
    refused = TimestampRefusedEvent(fail_info="badAlg", reason="Words.")
    for value in (*dataclasses.astuple(issued), *dataclasses.astuple(refused)):
        assert isinstance(value, (*SCALARS, datetime))


def test_a_listener_typed_for_each_event_is_accepted() -> None:
    def on_issued(event: TimestampIssuedEvent) -> None:
        assert event.serial >= 0

    def on_refused(event: TimestampRefusedEvent) -> None:
        assert event.fail_info

    listener(TimestampIssuedEvent, on_issued)
    listener(TimestampRefusedEvent, on_refused)
    listener(DatumEvent, lambda event: None)


# -- when they are published -------------------------------------------------------------------------------------------
def test_a_token_publishes_the_issued_event_once_with_the_serial_the_time_the_algorithm_and_the_client(
    tsa_pki: TsaPki,
) -> None:
    with started_tsa(tsa_pki.ec) as rig:
        grant = rig.authority.issue(query_of(), client="client-4")
        events = list(rig.events)
    assert [type(event) for event in events] == [TimestampIssuedEvent]
    event = events[0]
    assert isinstance(event, TimestampIssuedEvent)
    assert (event.serial, event.gen_time, event.imprint_algorithm, event.client) == (
        grant.serial,
        INSTANT,
        "sha256",
        "client-4",
    )


def test_a_refusal_publishes_the_refused_event_only_and_it_takes_no_serial(tsa_pki: TsaPki) -> None:
    with started_tsa(tsa_pki.ec) as rig:
        answer = rig.authority.answer(query_der(b"\x01" * 20, algorithm_oid="1.3.14.3.2.26"))
        events = list(rig.events)
        assert rig.serials.allocations == 0
    assert [type(event) for event in events] == [TimestampRefusedEvent]
    event = events[0]
    assert isinstance(event, TimestampRefusedEvent)
    assert event.fail_info == "badAlg"
    assert answer.refusal is not None
    assert event.reason == answer.refusal.text


def test_the_events_carry_no_imprint_nonce_key_or_request_byte(tsa_pki: TsaPki) -> None:
    digest = sha256(b"hello")
    with started_tsa(tsa_pki.ec) as rig:
        rig.authority.issue(query_of(b"hello", nonce=0x5EC12E7), client="client-1")
        rig.authority.answer(query_der(b"\x01" * 20, algorithm_oid="1.3.14.3.2.26", nonce=0x5EC12E7))
        text = " ".join(repr(event) + str(dataclasses.astuple(event)) for event in rig.events)
    assert digest.hex() not in text
    assert str(0x5EC12E7) not in text
    assert f"{0x5EC12E7:x}" not in text
    assert CLIENT_KEY not in text
    assert key_hash(CLIENT_KEY) not in text


def test_a_client_is_the_stores_id_never_its_key_or_hash(tsa_pki: TsaPki) -> None:
    with started_tsa(tsa_pki.ec, tsa_config(access="clients", clients=[key_hash(CLIENT_KEY)])) as rig:
        gate = rig.datum.timestamp_gate
        assert gate is not None
        admitted = gate.admit(
            {"Content-Type": "application/timestamp-query", "Authorization": f"Bearer {CLIENT_KEY}"},
            remote_address="192.0.2.1",
        )
        client = getattr(admitted, "client", None)
        assert client
        rig.authority.issue(query_of(), client=client)
        event = rig.events[-1]
    assert isinstance(event, TimestampIssuedEvent)
    assert event.client == client
    assert CLIENT_KEY not in repr(event)
    assert key_hash(CLIENT_KEY) not in repr(event)


# -- a raising listener ------------------------------------------------------------------------------------------------
def test_a_raising_listener_changes_no_answer_and_the_next_listener_still_runs(
    tsa_pki: TsaPki, caplog: pytest.LogCaptureFixture
) -> None:
    seen: list[DatumEvent] = []

    def boom(event: TimestampIssuedEvent) -> None:
        raise RuntimeError("listener bug")

    dispatcher = EventDispatcher([listener(TimestampIssuedEvent, boom), listener(TimestampIssuedEvent, seen.append)])
    authority = make_authority(tsa_pki.ec, events=dispatcher)
    with caplog.at_level(logging.ERROR, logger=EVENTS):
        grant = authority.issue(query_of())
    assert grant.token
    assert token_parts(grant.token).tst.serial == grant.serial
    assert len(seen) == 1
    assert any("listener bug" in str(record.exc_info) for record in caplog.records)


def test_a_raising_listener_on_a_refusal_changes_the_rejection_not_at_all(tsa_pki: TsaPki) -> None:
    def boom(event: TimestampRefusedEvent) -> None:
        raise RuntimeError("listener bug")

    authority = make_authority(tsa_pki.ec, events=EventDispatcher([listener(TimestampRefusedEvent, boom)]))
    plain = make_authority(tsa_pki.ec)
    request = query_der(b"\x01" * 20, algorithm_oid="1.3.14.3.2.26")
    assert authority.answer(request).response == plain.answer(request).response


# -- the span ----------------------------------------------------------------------------------------------------------
def span_text(span: Any) -> str:
    return " ".join(f"{key}={value}" for key, value in (span.attributes or {}).items())


def test_a_token_is_one_datum_tsa_issue_span_with_the_channel_and_the_outcome_granted(tsa_pki: TsaPki) -> None:
    spans = telemetry()
    with started_tsa(tsa_pki.ec) as rig:
        rig.authority.issue(query_of(b"hello", nonce=0x5EC12E7), channel="seal", client="client-1")
    (span,) = spans.spans("datum.tsa.issue")
    attributes = dict(span.attributes or {})
    assert attributes["datum.channel"] == "seal"
    assert attributes["datum.outcome"] == "granted"
    assert "error.type" not in attributes
    assert span.status.status_code is not StatusCode.ERROR


@pytest.mark.parametrize(
    ("request_bytes", "failure"),
    [
        (query_der(b"\x01" * 20, algorithm_oid="1.3.14.3.2.26"), "badAlg"),
        (query_der(sha256(b"x"), policy="1.2.3.4"), "unacceptedPolicy"),
        (query_der(sha256(b"x"), extension=True), "unacceptedExtension"),
        (b"garbage", "badDataFormat"),
    ],
)
def test_a_refusal_sets_error_type_to_the_rfc_3161_failure_name(
    tsa_pki: TsaPki, request_bytes: bytes, failure: str
) -> None:
    spans = telemetry()
    make_authority(tsa_pki.ec).answer(request_bytes)
    (span,) = spans.spans("datum.tsa.issue")
    attributes = dict(span.attributes or {})
    assert attributes["error.type"] == failure
    assert attributes["datum.outcome"] != "granted"


REFUSED_IMPRINT = sha256(b"refused")
REFUSED_NONCE = 0x7EF05ED


def span_haystack(span: Any) -> str:
    """Every attribute, every span event (name and attributes) and the status description of a span."""
    parts = [span_text(span), span.status.description or ""]
    for event in span.events:
        parts.append(event.name)
        parts.extend(f"{key}={value}" for key, value in (event.attributes or {}).items())
    return " ".join(parts)


def test_a_key_that_fails_to_sign_publishes_no_issued_event(tsa_pki: TsaPki) -> None:
    class Broken(IdentityKey):
        def sign(self, data: bytes) -> bytes:
            raise RuntimeError("hsm offline")

    with started_tsa(tsa_pki.ec, tsa_key_material=Broken(tsa_pki.ec)) as rig:
        with pytest.raises(TimestampRefusedError):
            rig.authority.issue(query_of())
        assert [type(e) for e in rig.events] == [TimestampRefusedEvent]


def test_the_span_never_carries_an_imprint_nonce_serial_key_or_client_key(tsa_pki: TsaPki) -> None:
    spans = telemetry()

    class FailingLog(ListLog):
        def append(self, entry: Any) -> None:
            raise OSError("disk full")

    def refuse(draft: Any) -> None:
        raise TimestampRefusedError("badRequest", "No.")

    granted = sha256(b"hello")
    searched = [granted.hex(), REFUSED_IMPRINT.hex(), str(0x5EC12E7), f"{0x5EC12E7:x}", str(REFUSED_NONCE)]
    searched += [f"{REFUSED_NONCE:x}", CLIENT_KEY, key_hash(CLIENT_KEY), "client-1"]
    refused_request = query_der(REFUSED_IMPRINT, nonce=REFUSED_NONCE)
    events: list[DatumEvent] = []
    with started_tsa(tsa_pki.ec) as rig:
        grant = rig.authority.issue(query_of(b"hello", nonce=0x5EC12E7), client="client-1")
        rig.authority.answer(query_der(b"\x01" * 20, algorithm_oid="1.3.14.3.2.26", nonce=0x5EC12E7))
        rig.authority.answer(query_der(REFUSED_IMPRINT, nonce=REFUSED_NONCE, policy="1.2.3.4"))  # unaccepted policy
        rig.clock.reason = "The clock is not synchronised."
        rig.authority.answer(refused_request)  # time source unavailable
        events += rig.events
    with started_tsa(tsa_pki.ec, timestamp_request_customizers=[refuse]) as rig:
        rig.authority.answer(refused_request)  # customizer refusal
        events += rig.events
    with started_tsa(tsa_pki.ec, tsa_log=FailingLog()) as rig:
        rig.authority.answer(refused_request)  # log failure: the serial is taken, then burnt
        burnt = rig.serials.allocations
        events += rig.events
    assert burnt == 1
    finished = spans.spans("datum.tsa.issue")
    assert len(finished) >= 6
    serials = {f"serial={grant.serial}", "datum.serial", "serial=1"}
    for span in finished:
        text = span_haystack(span)
        assert not [word for word in searched if word in text]
        assert not [word for word in serials if word in text]
        assert all(key.startswith(("datum.", "error.")) for key in (span.attributes or {}))
    for event in events:
        text = repr(event) + str(dataclasses.astuple(event))
        assert not [word for word in searched if word in text and word != "client-1"]  # the client id is allowed
    assert all(isinstance(e, (TimestampIssuedEvent, TimestampRefusedEvent)) for e in events)


def test_a_customizer_refusal_ends_the_span_with_its_failure_name(tsa_pki: TsaPki) -> None:
    spans = telemetry()

    def refuse(draft: Any) -> None:
        raise TimestampRefusedError("badRequest", "No.")

    make_authority(tsa_pki.ec, customizers=[refuse]).answer(query_der(sha256(b"x")))
    (span,) = spans.spans("datum.tsa.issue")
    assert (span.attributes or {})["error.type"] == "badRequest"
