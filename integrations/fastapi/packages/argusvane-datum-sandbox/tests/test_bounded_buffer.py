"""The bounded output buffers: what a run keeps never exceeds the cap, bytes past it are dropped, the cap is flagged."""

import threading

import pytest
from hypothesis import given
from hypothesis import strategies as st

from datum_sandbox.protocol import ProgramLimits
from datum_sandbox.wasi import STDERR_CAP, STDOUT_CAP, OutputSink


def test_contract_caps() -> None:
    assert STDOUT_CAP == 32 * 1024 * 1024
    assert STDERR_CAP == 64 * 1024
    budget = ProgramLimits().validation_budget()
    assert (budget.stdout_cap, budget.stderr_cap) == (STDOUT_CAP, STDERR_CAP)


def test_exact_cap_is_not_capped() -> None:
    sink = OutputSink(4)
    assert sink.write(b"abcd") == 4
    assert sink.value() == b"abcd"
    assert not sink.capped


def test_one_byte_past_is_capped_and_dropped() -> None:
    sink = OutputSink(4)
    assert sink.write(b"abcde") == 5  # the full count: the guest sees a healthy pipe
    assert sink.value() == b"abcd"
    assert sink.capped


def test_bytes_after_the_cap_are_discarded_even_when_small() -> None:
    sink = OutputSink(4)
    sink.write(b"abc")
    sink.write(b"de")
    sink.write(b"")
    sink.write(b"f")
    assert sink.value() == b"abcd"
    assert sink.capped


def test_zero_cap_keeps_nothing() -> None:
    sink = OutputSink(0)
    assert sink.write(b"") == 0
    assert not sink.capped
    sink.write(b"x")
    assert sink.value() == b""
    assert sink.capped


def test_negative_cap_refused() -> None:
    with pytest.raises(ValueError, match="negative"):
        OutputSink(-1)


def test_stdout_cap_over_forty_mebibytes() -> None:
    sink = OutputSink(STDOUT_CAP)
    chunk = b"x" * (1024 * 1024)
    for _ in range(40):
        assert sink.write(chunk) == len(chunk)
    kept = sink.value()
    assert len(kept) == STDOUT_CAP
    assert kept == b"x" * STDOUT_CAP
    assert sink.capped


def test_memoryview_and_bytearray_writes() -> None:
    sink = OutputSink(3)
    sink.write(memoryview(b"ab"))
    sink.write(bytearray(b"cd"))
    assert sink.value() == b"abc"


def test_concurrent_writers_never_pass_the_cap() -> None:
    sink = OutputSink(10_000)

    def write() -> None:
        for _ in range(500):
            sink.write(b"0123456789abcdefghijklmnopqrstuv")

    threads = [threading.Thread(target=write) for _ in range(8)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert len(sink.value()) == 10_000
    assert sink.capped


@given(st.integers(0, 64), st.lists(st.binary(max_size=40), max_size=20))
def test_kept_is_the_prefix_and_never_exceeds_the_cap(cap: int, writes: list[bytes]) -> None:
    sink = OutputSink(cap)
    for data in writes:
        assert sink.write(data) == len(data)
        assert len(sink.value()) <= cap
    everything = b"".join(writes)
    assert sink.value() == everything[:cap]
    assert sink.capped == (len(everything) > cap)
