"""The seam `TsaTimeSource`: an instant or a reason; a source that raises is unavailable; unavailable costs nothing.

`Reading.available(instant)` is the token's time; `Reading.unavailable(reason)` is 503 `timeNotAvailable` with the
reason as the status text (it reaches clients, so a source keeps hostnames and addresses out of it). A source that
raises counts as unavailable and its message goes to the log only. Unavailable means no key use, no serial, the
refused event and, in `Datum`, a down `tsa` health component (`test_datum_tsa_wiring`). The order is
policy > customizers > time > key > serial > signature.
"""

import logging
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from submissions_support import ThreadLoopAwaiter
from tsa_der import generalized_time, parse_reply, query_der, token_parts
from tsa_support import Clock, CountingSerials, IdentityKey, ListLog, make_authority, sha256

from datum_core.events import DatumEvent, EventDispatcher, TimestampIssuedEvent, TimestampRefusedEvent
from datum_core.loggers import TSA
from datum_core.testing.tsa_pki import INSTANT, TsaPki
from datum_core.timestamp import TimestampAuthority, TimestampQuery, TimestampRefusedError
from datum_core.timestamp.protocols import Reading

DIGEST = sha256(b"hello")
QUERY = query_der(DIGEST)


def query() -> TimestampQuery:
    return TimestampQuery.parse(QUERY)


class Rig:
    def __init__(self, tsa_pki: TsaPki, clock: object, **seams: Any) -> None:
        self.key = IdentityKey(tsa_pki.ec)
        self.serials = CountingSerials()
        self.events: list[DatumEvent] = []
        self.log = ListLog()
        self.authority: TimestampAuthority = make_authority(
            tsa_pki.ec,
            key=self.key,
            serials=self.serials,
            time_source=clock,
            log=self.log,
            events=EventDispatcher([(DatumEvent, self.events.append)]),
            **seams,
        )

    def untouched(self) -> bool:
        return self.key.signs == 0 and self.serials.allocations == 0 and not self.log.entries


def test_the_token_carries_the_instant_the_source_read_not_the_clock_of_the_process(tsa_pki: TsaPki) -> None:
    moment = datetime(2026, 12, 25, 6, 30, 15, tzinfo=UTC)
    rig = Rig(tsa_pki, Clock(moment))
    grant = rig.authority.issue(query())
    assert token_parts(grant.token).tst.gen_time == generalized_time(moment)
    assert grant.gen_time == moment


def test_the_source_is_read_once_per_token(tsa_pki: TsaPki) -> None:
    clock = Clock()
    rig = Rig(tsa_pki, clock)
    rig.authority.issue(query())
    rig.authority.issue(query())
    assert clock.reads == 2


def test_with_no_source_the_default_wraps_the_now_callable_and_is_always_available(tsa_pki: TsaPki) -> None:
    later = INSTANT + timedelta(hours=3)
    grant = make_authority(tsa_pki.ec, now=lambda: later).issue(query())
    assert grant.gen_time == later


# -- unavailable -------------------------------------------------------------------------------------------------------
def test_an_unavailable_source_refuses_with_time_not_available_and_its_reason(tsa_pki: TsaPki) -> None:
    clock = Clock()
    clock.reason = "The clock is not synchronised."
    rig = Rig(tsa_pki, clock)
    with pytest.raises(TimestampRefusedError) as raised:
        rig.authority.issue(query())
    assert raised.value.failure == "timeNotAvailable"
    assert "The clock is not synchronised." in raised.value.message


def test_unavailable_costs_no_key_use_no_serial_and_no_log_row(tsa_pki: TsaPki) -> None:
    clock = Clock()
    clock.reason = "down"
    rig = Rig(tsa_pki, clock)
    with pytest.raises(TimestampRefusedError):
        rig.authority.issue(query())
    assert rig.untouched()


def test_the_answer_is_a_503_rejection_with_bit_14_and_the_reason_as_its_words(tsa_pki: TsaPki) -> None:
    clock = Clock()
    clock.reason = "No time today."
    rig = Rig(tsa_pki, clock)
    answer = rig.authority.answer(QUERY)
    assert answer.refusal is not None
    assert answer.refusal.http_status == 503
    read = parse_reply(answer.response)
    assert read.fail_bits == {14}
    assert any("No time today." in text for text in read.texts)


def test_unavailable_publishes_the_refused_event_and_no_issued_event(tsa_pki: TsaPki) -> None:
    clock = Clock()
    clock.reason = "down"
    rig = Rig(tsa_pki, clock)
    rig.authority.answer(QUERY)
    assert [type(event) for event in rig.events] == [TimestampRefusedEvent]
    event = rig.events[0]
    assert isinstance(event, TimestampRefusedEvent)
    assert event.fail_info == "timeNotAvailable"
    assert "down" in event.reason


def test_the_source_coming_back_makes_the_next_token_possible(tsa_pki: TsaPki) -> None:
    clock = Clock()
    clock.reason = "down"
    rig = Rig(tsa_pki, clock)
    with pytest.raises(TimestampRefusedError):
        rig.authority.issue(query())
    clock.reason = None
    assert rig.authority.issue(query()).serial == 1


# -- a source that raises ----------------------------------------------------------------------------------------------
def test_a_raising_source_is_unavailable_and_its_message_reaches_the_log_only(
    tsa_pki: TsaPki, caplog: pytest.LogCaptureFixture
) -> None:
    clock = Clock()
    clock.error = ConnectionError("cannot reach ntp.internal.example:123")
    rig = Rig(tsa_pki, clock)
    with caplog.at_level(logging.DEBUG, logger=TSA):
        answer = rig.authority.answer(QUERY)
    assert answer.refusal is not None
    assert answer.refusal.failure == "timeNotAvailable"
    assert "ntp.internal.example" not in answer.refusal.text
    assert "ntp.internal.example" not in str(answer.response)
    assert "ntp.internal.example" in caplog.text or any(
        "ntp.internal.example" in str(r.exc_info) for r in caplog.records
    )
    refused = [e for e in rig.events if isinstance(e, TimestampRefusedEvent)]
    assert refused
    assert "ntp.internal.example" not in refused[0].reason
    assert rig.untouched()


def test_a_source_answering_the_wrong_type_is_unavailable_too(tsa_pki: TsaPki) -> None:
    class Wrong:
        def read(self) -> object:
            return datetime.now(UTC)  # a datetime, not a Reading

    rig = Rig(tsa_pki, Wrong())
    with pytest.raises(TimestampRefusedError) as raised:
        rig.authority.issue(query())
    assert raised.value.failure == "timeNotAvailable"
    assert rig.untouched()


def test_an_async_source_is_resolved_through_the_awaiter(tsa_pki: TsaPki) -> None:
    class Async:
        async def read(self) -> Reading:
            return Reading.available(INSTANT + timedelta(minutes=5))

    awaiter = ThreadLoopAwaiter()
    try:
        grant = make_authority(tsa_pki.ec, time_source=Async(), awaiter=awaiter).issue(query())
    finally:
        awaiter.close()
    assert grant.gen_time == INSTANT + timedelta(minutes=5)


# -- the order ---------------------------------------------------------------------------------------------------------
def test_time_is_read_before_the_serial_and_the_serial_before_the_signature(tsa_pki: TsaPki) -> None:
    trail: list[str] = []

    class TrailClock(Clock):
        def read(self) -> Reading:
            trail.append("time")
            return super().read()

    class TrailSerials(CountingSerials):
        def allocate(self) -> int:
            trail.append("serial")
            return super().allocate()

    class TrailKey(IdentityKey):
        def sign(self, data: bytes) -> bytes:
            trail.append("sign")
            return super().sign(data)

    make_authority(tsa_pki.ec, key=TrailKey(tsa_pki.ec), serials=TrailSerials(), time_source=TrailClock()).issue(
        query()
    )
    assert trail == ["time", "serial", "sign"]


def test_an_issued_token_publishes_the_issued_event_after_the_token_and_logs_a_row(tsa_pki: TsaPki) -> None:
    rig = Rig(tsa_pki, Clock())
    grant = rig.authority.issue(query(), client="client-3")
    assert [type(event) for event in rig.events] == [TimestampIssuedEvent]
    event = rig.events[0]
    assert isinstance(event, TimestampIssuedEvent)
    assert (event.serial, event.gen_time, event.imprint_algorithm, event.client) == (
        grant.serial,
        grant.gen_time,
        "sha256",
        "client-3",
    )
    (row,) = rig.log.entries
    assert (row.serial, row.gen_time, row.imprint_algorithm, row.imprint, row.client) == (
        grant.serial,
        grant.gen_time,
        "sha256",
        DIGEST.hex(),
        "client-3",
    )
