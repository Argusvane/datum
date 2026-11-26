"""The throttle through the service: who is counted, which kind, the answer, health and the notices."""

import logging

import pytest
import time_machine
from submissions_support import (
    bus,
    capabilities_of,
    definition,
    envelope,
    http_context,
    journey_check,
    plain_datum,
    started,
    wrapped,
)
from throttle_support import START

from datum_core.config.models import ThrottleKind
from datum_core.loggers import CHECKS
from datum_core.submissions import Accepted, FormRef, PdfChecked, Throttled
from datum_core.throttle import LimitsThrottle

SUBMISSIONS_ON = {"web": {"api": {"endpoints": {"submissions": True}}}}


def limited(limit: int) -> dict[str, object]:
    return {"web": {"throttle": {"limit": limit, "window": 60}}}


def test_the_default_throttle_is_limits_throttle_over_the_bounded_memory_storage() -> None:
    with started(throttle=None) as rig:
        assert isinstance(rig.datum.throttle, LimitsThrottle)


def test_a_route_caller_over_the_limit_is_throttled_with_whole_seconds_at_least_one() -> None:
    with started(limited(2), throttle=None) as rig, time_machine.travel(START, tick=False) as clock:
        answers = [rig.submit(envelope(values={"name": f"n{n}"}), http_context()) for n in range(2)]
        clock.shift(59.5)
        denied = rig.submit(envelope(values={"name": "n3"}), http_context())
    assert all(isinstance(answer, Accepted) for answer in answers)
    assert isinstance(denied, Throttled)
    assert type(denied.retry_after) is int
    assert denied.retry_after == 1


def test_a_denied_request_costs_no_run_and_no_handler_call() -> None:
    with started(limited(1), throttle=None) as rig, time_machine.travel(START, tick=False):
        rig.submit(envelope(values={"name": "one"}), http_context())
        runs = len(rig.sandbox.validations)
        rig.submit(envelope(values={"name": "two"}), http_context())
    assert len(rig.sandbox.validations) == runs
    assert len(rig.handler.calls) == 1


def test_a_bus_caller_with_no_throttle_key_is_not_counted_however_many_it_sends() -> None:
    with started(limited(1), throttle=None) as rig:
        answers = [rig.submit(envelope(values={"name": f"n{n}"}), bus()) for n in range(10)]
    assert all(isinstance(answer, Accepted) for answer in answers)


def test_a_bus_caller_does_not_use_up_a_route_callers_budget() -> None:
    with started(limited(1), throttle=None) as rig, time_machine.travel(START, tick=False):
        for n in range(5):
            rig.submit(envelope(values={"name": f"bus{n}"}), bus())
        routed = rig.submit(envelope(values={"name": "http"}), http_context())
    assert isinstance(routed, Accepted)


def test_each_service_call_counts_under_its_own_kind_and_inspect_counts_as_a_test() -> None:
    with started() as rig:
        form = FormRef.from_document()
        rig.service.submit(form, envelope(), http_context())
        rig.service.validate(form, journey_check(envelope()), http_context())
        rig.service.test(form, wrapped(envelope()), http_context())
        rig.service.inspect("abi", definition(), http_context())
    assert [key.kind for key in rig.throttle.keys] == [
        ThrottleKind.SUBMIT,
        ThrottleKind.VALIDATE,
        ThrottleKind.TEST,
        ThrottleKind.TEST,
    ]


def test_the_service_completes_the_callers_key_with_the_form_and_the_channel() -> None:
    with started() as rig:
        rig.submit(envelope(form="contact"), http_context(ip="198.51.100.4", principal="alice"))
    (key,) = rig.throttle.keys
    assert (key.ip, key.principal, key.form_key, key.kind, key.channel) == (
        "198.51.100.4",
        "alice",
        "contact",
        ThrottleKind.SUBMIT,
        "http",
    )


def test_a_throttled_inspect_costs_no_run() -> None:
    with started() as rig:
        rig.throttle.deny = 4
        outcome = rig.service.inspect("abi", definition(), http_context())
    assert isinstance(outcome, Throttled)
    assert rig.sandbox.inspections == []
    assert rig.events == []


def test_the_pdf_dry_run_is_not_counted() -> None:
    with started() as rig:
        rig.throttle.deny = 4
        outcome = rig.service.pdf_check(FormRef.from_document(), envelope(), http_context())
    assert isinstance(outcome, PdfChecked), "a throttle that would deny is never asked"
    assert rig.throttle.keys == []
    assert rig.events == []


def test_throttle_health_is_a_flat_component_reading_memory_with_the_cap_and_evictions() -> None:
    running = plain_datum({"web": {"throttle": {"max_keys": 50}}})
    running.start()
    try:
        component = running.health().components["stores.throttle"]
        capability = capabilities_of(running)["throttle"]
    finally:
        running.stop()
    assert component.status == "up"
    assert component.details["store"] == "memory"
    assert component.details["maxKeys"] == 50
    assert component.details["evictions"] == 0
    assert capability == "memory"


def test_an_application_throttle_reads_custom() -> None:
    with started() as rig:
        assert rig.datum.health().components["stores.throttle"].details["store"] == "custom"
        assert capabilities_of(rig.datum)["throttle"] == "custom"


def test_the_memory_throttle_is_one_w004_when_submissions_are_served(caplog: pytest.LogCaptureFixture) -> None:
    running = plain_datum(SUBMISSIONS_ON)
    with caplog.at_level(logging.WARNING, logger=CHECKS):
        running.start()
    running.stop()
    found = [r.getMessage() for r in caplog.records if getattr(r, "datum_check_id", "") == "datum.W004"]
    assert len([m for m in found if "stores.throttle" in m]) == 1
    assert any("per process" in m or "this process" in m for m in found if "stores.throttle" in m)
