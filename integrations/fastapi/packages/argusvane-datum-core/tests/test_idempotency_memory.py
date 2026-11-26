"""The in-memory idempotency store: the shared protocol contract, then what only a bounded memory store owes."""

import threading
from concurrent.futures import ThreadPoolExecutor
from typing import TYPE_CHECKING

import pytest

from datum_core.checks import W004
from datum_core.stores.memory import MemorySubmissionIdempotencyStore
from datum_core.submissions import SubmissionIdempotencyStore, SubmissionReceipt
from datum_core.testing.idempotency_contract import IdempotencyStoreContract
from datum_sandbox.checks import CheckLevel

if TYPE_CHECKING:
    from datum_sandbox.json import JsonValue


class TestMemoryStoreKeepsTheContract(IdempotencyStoreContract):
    @pytest.fixture
    def store(self) -> SubmissionIdempotencyStore:
        return MemorySubmissionIdempotencyStore(10_000)


def receipt(n: int) -> SubmissionReceipt:
    return SubmissionReceipt(id=f"id-{n}", reference=f"REF-{n}")


def digest(n: int) -> str:
    return f"{n:064x}"


def test_the_health_name_is_the_flat_dotted_one() -> None:
    assert MemorySubmissionIdempotencyStore(16).health_name == "stores.idempotency"


def test_the_store_holds_at_most_memory_size_receipts_and_drops_the_oldest() -> None:
    store: MemorySubmissionIdempotencyStore[SubmissionReceipt] = MemorySubmissionIdempotencyStore(16)
    for n in range(40):
        store.record("contact", "1", digest(n), receipt(n))
    assert store.details()["entries"] == 16
    assert store.details()["maxEntries"] == 16
    assert store.find("contact", "1", digest(0)) is None
    assert store.find("contact", "1", digest(39)) == receipt(39)


def test_an_evicted_key_can_only_lose_a_redelivery_never_answer_another_form_or_digest() -> None:
    store: MemorySubmissionIdempotencyStore[SubmissionReceipt] = MemorySubmissionIdempotencyStore(16)
    store.record("contact", "1", digest(1), receipt(1))
    for n in range(100, 140):
        store.record("claims", "1", digest(n), receipt(n))
    assert store.find("contact", "1", digest(1)) is None
    assert store.find("contact", "1", digest(100)) is None
    assert store.find("claims", "1", digest(139)) == receipt(139)


def test_the_bound_holds_under_eight_threads() -> None:
    store: MemorySubmissionIdempotencyStore[SubmissionReceipt] = MemorySubmissionIdempotencyStore(64)
    gate = threading.Barrier(8)

    def write(thread: int) -> None:
        gate.wait(timeout=30)
        for n in range(500):
            store.record("contact", "1", digest(thread * 1000 + n), receipt(n))

    with ThreadPoolExecutor(max_workers=8) as pool:
        for future in [pool.submit(write, t) for t in range(8)]:
            future.result(timeout=60)
    assert store.details()["entries"] == 64


@pytest.mark.parametrize("size", [0, -1])
def test_a_store_of_no_receipts_is_refused(size: int) -> None:
    with pytest.raises(ValueError, match="at least"):
        MemorySubmissionIdempotencyStore(size)


def test_the_store_states_the_w004_warning_and_its_details() -> None:
    store: MemorySubmissionIdempotencyStore[SubmissionReceipt] = MemorySubmissionIdempotencyStore(32)
    check = store.check()
    assert (check.level, check.id) == (CheckLevel.WARNING, W004)
    assert "stores.idempotency" in check.msg
    assert store.details() == {"store": "memory", "entries": 0, "maxEntries": 32}


def test_the_receipt_a_find_answers_is_a_value_not_a_handle_into_the_store() -> None:
    store: MemorySubmissionIdempotencyStore[SubmissionReceipt] = MemorySubmissionIdempotencyStore(32)
    items: list[JsonValue] = ["v"]
    payload: dict[str, JsonValue] = {"k": items}
    store.record("contact", "1", digest(1), SubmissionReceipt(id="a", reference="b", receipt=payload))
    items.append("caller")
    first = store.find("contact", "1", digest(1))
    assert first is not None
    assert first.receipt is not None
    first_items = first.receipt["k"]
    assert isinstance(first_items, list)
    first_items.append("reader")
    returned = store.record("contact", "1", digest(1), SubmissionReceipt(id="c", reference="d", receipt={"k": []}))
    assert returned.receipt is not None
    returned_items = returned.receipt["k"]
    assert isinstance(returned_items, list)
    returned_items.append("loser")
    found = store.find("contact", "1", digest(1))
    assert found is not None
    assert found.receipt == {"k": ["v"]}
