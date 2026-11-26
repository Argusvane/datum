"""Idempotency through `Datum`: the default store, the W004 notice, the health component and `info()`."""

import logging
from typing import Any

import pytest
from submissions_support import capabilities_of, plain_datum

from datum_core import Datum
from datum_core.loggers import CHECKS
from datum_core.stores.memory import MemorySubmissionIdempotencyStore
from datum_core.submissions import RememberedReceipt

SUBMISSIONS_ON = {"web": {"api": {"endpoints": {"submissions": True}}}}


def datum(sections: dict[str, Any] | None = None, **seams: Any) -> Datum:
    return plain_datum(sections or SUBMISSIONS_ON, **seams)


def test_the_default_store_is_the_memory_store_sized_by_the_setting() -> None:
    running = datum({"submissions": {"idempotency": {"memory_size": 128}}, **SUBMISSIONS_ON})
    assert isinstance(running.idempotency_store, MemorySubmissionIdempotencyStore)
    assert running.idempotency_store.details()["maxEntries"] == 128


def test_the_health_component_is_flat_and_reads_memory() -> None:
    running = datum()
    running.start()
    try:
        component = running.health().components["stores.idempotency"]
    finally:
        running.stop()
    assert component.status == "up"
    assert component.details["store"] == "memory"
    assert component.details["maxEntries"] == 10_000


def test_info_names_the_idempotency_store_kind_under_the_capabilities() -> None:
    running = datum()
    assert capabilities_of(running)["idempotency"] == "memory"


def test_an_application_store_reads_custom_in_info_and_health() -> None:
    class Own:
        def find(self, form_key: str, version: str, submission_key: str) -> RememberedReceipt | None:
            return None

        def record(
            self, form_key: str, version: str, submission_key: str, remembered: RememberedReceipt
        ) -> RememberedReceipt:
            return remembered

    running = datum(idempotency_store=Own())
    running.start()
    try:
        assert capabilities_of(running)["idempotency"] == "custom"
        assert running.health().components["stores.idempotency"].details["store"] == "custom"
    finally:
        running.stop()


def test_the_memory_store_is_one_w004_at_start_when_submissions_are_served(caplog: pytest.LogCaptureFixture) -> None:
    running = datum()
    with caplog.at_level(logging.WARNING, logger=CHECKS):
        running.start()
    running.stop()
    found = [r.getMessage() for r in caplog.records if getattr(r, "datum_check_id", "") == "datum.W004"]
    assert len([m for m in found if "stores.idempotency" in m]) == 1


def test_an_application_store_raises_no_w004_for_idempotency(caplog: pytest.LogCaptureFixture) -> None:
    class Own:
        def find(self, form_key: str, version: str, submission_key: str) -> None:
            return None

        def record(
            self, form_key: str, version: str, submission_key: str, remembered: RememberedReceipt
        ) -> RememberedReceipt:
            return remembered

    running = datum(idempotency_store=Own())
    with caplog.at_level(logging.WARNING, logger=CHECKS):
        running.start()
    running.stop()
    assert not [r for r in caplog.records if "stores.idempotency" in r.getMessage()]


def test_nothing_here_needs_allow_memory_stores_and_the_start_succeeds() -> None:
    running = datum()
    running.start()
    assert running.started
    running.stop()
