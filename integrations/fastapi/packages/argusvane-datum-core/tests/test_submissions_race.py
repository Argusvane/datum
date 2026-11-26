"""Two deliveries in flight may both reach the handler (no lock holds across instances); the third is a redelivery.

The protocol is `find` before the handler and `record` after it with NO lock between. The test is the guard against a
well-meant lock: both threads must be inside the handler at the same moment, or the barrier breaks and the test fails.
"""

import threading
from concurrent.futures import ThreadPoolExecutor
from typing import Any

from submissions_support import bus, envelope, started

from datum_core.submissions import Accepted, Redelivered


def test_two_in_flight_deliveries_both_reach_the_handler_and_the_next_one_is_a_redelivery() -> None:
    inside = threading.Barrier(2)

    with started() as rig:
        rig.handler.hold = lambda: inside.wait(timeout=10)

        def deliver() -> Any:
            return rig.submit(envelope(), bus(submission_key="attempt-1"))

        with ThreadPoolExecutor(max_workers=2) as pool:
            first, second = [future.result(timeout=30) for future in [pool.submit(deliver), pool.submit(deliver)]]
        later = rig.submit(envelope(), bus(submission_key="attempt-1"))

    assert len(rig.handler.calls) == 2  # both in-flight deliveries, none for the later one
    assert {type(first), type(second)} <= {Accepted, Redelivered}
    assert isinstance(later, Redelivered)
    stored = {remembered.receipt for *_, remembered in rig.idempotency.records}
    assert later.receipt in stored


def test_the_receipt_a_redelivery_answers_is_the_one_the_store_kept_for_the_winner() -> None:
    inside = threading.Barrier(2)
    with started() as rig:
        rig.handler.hold = lambda: inside.wait(timeout=10)
        with ThreadPoolExecutor(max_workers=2) as pool:
            outcomes = [
                f.result(timeout=30)
                for f in [pool.submit(rig.submit, envelope(), bus(submission_key="attempt-1")) for _ in range(2)]
            ]
        later = rig.submit(envelope(), bus(submission_key="attempt-1"))
    winner = rig.idempotency.find("contact", "1", "attempt-1")
    assert isinstance(later, Redelivered)
    assert winner is not None
    assert later.receipt == winner.receipt
    assert all(isinstance(o, Accepted | Redelivered) for o in outcomes)


def test_the_handler_is_handed_the_digest_it_can_be_idempotent_on() -> None:
    with started() as rig:
        rig.submit(envelope())
    (accepted,) = rig.handler.calls
    assert len(accepted.digest) == 64
