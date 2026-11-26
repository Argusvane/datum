"""The output cap on the wasmtime binding itself, with no Datum engine .

The rule: the stdout and stderr callbacks keep the bytes up to the cap, then discard, returning the full
count; they never raise and never touch the Store. A finite producer ends by itself; an endless one is ended by the
wall budget's epoch interrupt from the clock thread. These pin what the engine relies on from wasmtime-py, so a
binding release that changes it turns a test red before the engine misbehaves. The epoch-stop assertion of the first
draft is gone: no stop is issued from a callback.

Each case also asserts that nothing reached the process's own streams (the binding prints a failed callback there).
"""

import hashlib
import json
from importlib import resources
from pathlib import Path

import pytest
import wasmtime
from guests import ENDLESS, FINITE, LINE, TICK, Clock, epoch_engine, qjs_module, run_guest

from datum_sandbox.testing.runtime_support import expected_prefix, producer_script

pytestmark = pytest.mark.runtime

CAPS = [
    pytest.param(64 * 1024, id="aligned"),
    pytest.param(64 * 1024 + 100, id="unaligned"),
    pytest.param(1, id="one-byte"),
    pytest.param(LINE - 1, id="inside-the-first-write"),
]


@pytest.fixture(scope="module")
def engine() -> wasmtime.Engine:
    return epoch_engine()


@pytest.fixture(scope="module", autouse=True)
def clock(engine: wasmtime.Engine) -> Clock:  # type: ignore[misc]
    ticking = Clock(engine)
    yield ticking
    ticking.close()


FINITE_BYTES = 4096 * LINE


@pytest.mark.parametrize("fd", [1, 2])
def test_a_finite_producer_that_exactly_fits_the_cap_leaves_the_flag_down(
    engine: wasmtime.Engine, capfd: pytest.CaptureFixture[str], fd: int
) -> None:
    module = wasmtime.Module(engine, FINITE.replace("FD", str(fd)))
    ended = run_guest(engine, module, fd=fd, cap=FINITE_BYTES, wall=10)
    assert ended.how == "return"
    assert ended.sink.capped is False, "no byte was dropped"
    assert ended.sink.value() == b"\0" * FINITE_BYTES
    seen = capfd.readouterr()
    assert (seen.out, seen.err) == ("", "")


@pytest.mark.parametrize("fd", [1, 2])
@pytest.mark.parametrize("cap", [*CAPS, pytest.param(FINITE_BYTES - 1, id="one-byte-over")])
def test_a_finite_producer_runs_to_its_end_and_the_sink_keeps_exactly_the_cap(
    engine: wasmtime.Engine, capfd: pytest.CaptureFixture[str], fd: int, cap: int
) -> None:
    module = wasmtime.Module(engine, FINITE.replace("FD", str(fd)))
    ended = run_guest(engine, module, fd=fd, cap=cap, wall=10)
    assert ended.how == "return", "the callbacks never stop a finite producer: it ends by itself"
    assert ended.sink.capped is True
    assert ended.sink.value() == b"\0" * cap, "exactly the first cap bytes, at most the cap stored"
    assert ended.calls >= 4096 * LINE // LINE, "the callback kept being called and answered the full count"
    seen = capfd.readouterr()
    assert (seen.out, seen.err) == ("", "")


@pytest.mark.parametrize("cap", CAPS)
def test_an_endless_producer_is_ended_by_the_epoch_interrupt_within_the_wall_budget(
    engine: wasmtime.Engine, capfd: pytest.CaptureFixture[str], cap: int
) -> None:
    wall = 0.5
    module = wasmtime.Module(engine, ENDLESS.replace("FD", "1"))
    ended = run_guest(engine, module, fd=1, cap=cap, wall=wall)
    assert ended.how == "trap"
    assert ended.trap == str(wasmtime.TrapCode.INTERRUPT)
    assert wall - TICK <= ended.seconds < wall + 3 * TICK + 0.5, "ended by the wall budget, not earlier or much later"
    assert ended.sink.capped is True
    assert ended.sink.value() == b"\0" * cap
    seen = capfd.readouterr()
    assert (seen.out, seen.err) == ("", "")


def test_the_pinned_qjs_module_is_the_one_the_runtime_json_names() -> None:
    root = resources.files("datum_qjs_wasm")
    record = json.loads((root / "runtime.json").read_text(encoding="utf-8"))
    assert hashlib.sha256((root / "qjs-wasi.wasm").read_bytes()).hexdigest() == record["sha256"]


@pytest.mark.parametrize("cap", [32 * 1024 * 1024, 32 * 1024 * 1024 + 7, 64 * 1024])
def test_a_forty_mib_qjs_print_ends_by_itself_with_the_exact_prefix(
    engine: wasmtime.Engine, capfd: pytest.CaptureFixture[str], tmp_path: Path, cap: int
) -> None:
    module = qjs_module(engine)
    script = producer_script(40 * 1024).encode()
    ended = run_guest(
        engine,
        module,
        fd=1,
        cap=cap,
        wall=60,
        argv=("qjs", "--std", "/app/run.js"),
        files={"run.js": script},
        workdir=tmp_path,
    )
    assert ended.how in {"return", "exit"}
    assert ended.exit_code in {None, 0}
    assert ended.sink.capped is True
    assert len(ended.sink.value()) <= cap
    assert ended.sink.value() == expected_prefix(cap)
    seen = capfd.readouterr()
    assert (seen.out, seen.err) == ("", "")
