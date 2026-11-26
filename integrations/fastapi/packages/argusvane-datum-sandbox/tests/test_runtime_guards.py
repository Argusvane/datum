"""Guards of the runtime, the capture sink and the async facade: eviction, start and stop, hooks, redaction."""

import logging
import shutil
import threading
import time
from pathlib import Path
from typing import Any

import anyio
import pytest
from sandbox_fakes import FakeRuntime, context

from datum_sandbox import DatumSandbox, SandboxSettings, SandboxState
from datum_sandbox.aio import AsyncDatumSandbox
from datum_sandbox.checks import DatumConfigurationError
from datum_sandbox.diagnostics import (
    CAPTURE_ID,
    CaptureListing,
    DirectoryCaptureSink,
    FailedRunCapture,
    RunCapture,
    TraceRecord,
    scrub,
    without_paths,
)
from datum_sandbox.protocol import APP_RUN_SCRIPT, SandboxError
from datum_sandbox.wasi import (
    Available,
    DiscoveredRuntime,
    EngineSelectionError,
    GuestRun,
    GuestRuntimes,
    RunEnd,
    RunResult,
)


def capture(n: int, when: str = "20261123-120000", size: int = 10) -> RunCapture:
    return RunCapture(f"{when}-{n:012x}", b"i" * size, b"o", b"e", b"r", b"{}")


def wait_for(condition: object, timeout: float = 10.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if callable(condition) and condition():
            return True
        time.sleep(0.01)
    return False


class MemorySink:
    def __init__(self) -> None:
        self.kept: dict[str, int] = {}
        self.removed: list[str] = []
        self.stuck: set[str] = set()
        self.closed = 0
        self.fail: BaseException | None = None
        self.gate: threading.Event | None = None

    def open(self) -> CaptureListing:
        return CaptureListing({})

    def write(self, item: RunCapture) -> int:
        if self.gate is not None:
            self.gate.wait(10)
        if self.fail is not None:
            error, self.fail = self.fail, None
            raise error
        self.kept[item.id] = item.size
        return item.size

    def remove(self, capture_id: str) -> None:
        if capture_id in self.stuck:
            raise OSError("busy")
        self.removed.append(capture_id)
        self.kept.pop(capture_id, None)

    def describe(self) -> str:
        return "memory"

    def close(self) -> None:
        self.closed += 1


# -- eviction survives a capture removed by hand, and one that cannot be removed ------------------------------


@pytest.mark.skipif(not hasattr(__import__("os"), "geteuid"), reason="POSIX")
def test_a_capture_deleted_by_hand_leaves_the_count_and_the_bounds_still_hold(tmp_path: Path) -> None:
    directory = tmp_path / "captures"
    made = FailedRunCapture(
        DirectoryCaptureSink(directory, check_acl=False), max_runs=2, max_bytes=10**9, queue_bytes=10**9,
        warn=lambda _text: None,
    )  # fmt: skip
    made.start()
    for n in (1, 2):
        made.offer(capture(n, when=f"20261123-12000{n}"))
    assert wait_for(lambda: made.written == 2)
    shutil.rmtree(directory / capture(1, when="20261123-120001").id)  # an operator removes the oldest by hand
    for n in range(3, 9):
        made.offer(capture(n, when=f"20261123-12000{n}"))
    assert wait_for(lambda: made.written == 8)
    made.stop(5)
    on_disk = [entry.name for entry in directory.iterdir() if CAPTURE_ID.fullmatch(entry.name)]
    assert len(on_disk) <= 2
    assert len(made.kept) <= 2
    assert capture(1, when="20261123-120001").id not in made.kept, "the one gone by hand only left the count"
    assert made.failed == 0, "a capture already gone is no failure"


def test_a_capture_that_cannot_be_removed_is_skipped_and_the_next_oldest_goes() -> None:
    sink = MemorySink()
    sink.stuck.add(capture(1).id)
    made = FailedRunCapture(sink, max_runs=1, max_bytes=10**6, queue_bytes=10**6, warn=lambda _text: None)
    made.start()
    made.offer(capture(1))
    assert wait_for(lambda: made.written == 1)
    made.offer(capture(2))
    assert wait_for(lambda: made.written == 2)
    made.offer(capture(3))
    made.stop(5)
    assert capture(2).id in sink.removed, "the stuck capture is skipped; the next oldest is removed"
    assert made.failed >= 1


# -- a failed start keeps its captures, and the sink closes however short the stop ------------------------------


class SmokeTraps(FakeRuntime):
    def run(self, job: GuestRun, /) -> RunResult:
        if "__datum_inspect" not in job.app_files[APP_RUN_SCRIPT].decode():
            return RunResult(RunEnd.TRAP, b"", b"trap in smoke", elapsed=0.01)
        return super().run(job)


def test_a_failed_start_drains_its_capture(tmp_path: Path) -> None:
    directory = tmp_path / "captures"
    settings = SandboxSettings.build(
        capture_enabled=True, capture_directory=str(directory), report=False, warm_up_runs=1
    )
    sandbox = DatumSandbox(settings, runtime=SmokeTraps())
    with pytest.raises(Exception, match="smoke"):
        sandbox.start()
    assert sandbox.state is SandboxState.FAILED
    assert [entry for entry in directory.iterdir() if CAPTURE_ID.fullmatch(entry.name)], "the failed smoke is kept"


def test_the_sink_is_closed_even_by_a_stop_with_no_time_left() -> None:
    sink = MemorySink()
    made = FailedRunCapture(sink, max_runs=2, max_bytes=10**6, queue_bytes=10**6, warn=lambda _text: None)
    made.start()
    made.stop(0.0)
    assert wait_for(lambda: sink.closed == 1), "the writer closes the sink as it exits"
    assert sink.closed == 1


# -- no second writer while the last one still writes ---------------------------------------------------------


def test_a_restart_refuses_while_the_last_start_s_writer_still_writes() -> None:
    sink = MemorySink()
    sink.gate = threading.Event()
    settings = SandboxSettings.build(capture_enabled=True, report=False, warm_up_runs=1, shutdown_grace=0.2)
    sandbox = DatumSandbox(settings, runtime=FakeRuntime(), capture_sink=sink)
    sandbox.start()
    with pytest.raises(SandboxError):
        sandbox.sandbox.validate(context("TRAP-ME"), real=False)
    time.sleep(0.1)
    sandbox.stop()
    try:
        with pytest.raises(RuntimeError, match="still"):
            sandbox.start()
        other = DatumSandbox(settings, runtime=FakeRuntime(), capture_sink=sink)
        with pytest.raises(RuntimeError, match="still"):
            other.start()
    finally:
        sink.gate.set()
    assert wait_for(lambda: not any(t.name == "datum-sandbox-capture" for t in threading.enumerate()))
    sandbox.start()
    sandbox.stop()


# -- engine ids case-folded on both sides ---------------------------------------------------------------------


def test_an_engine_id_is_selected_whatever_its_case() -> None:
    provider: Any = object()  # select only hands the provider back
    found = GuestRuntimes([DiscoveredRuntime("MyEngine", "my-dist", provider=provider, availability=Available())])
    assert found.select(SandboxSettings.build(engine="MyEngine").engine.id) is provider
    assert found.select("MYENGINE") is provider
    twice = GuestRuntimes(
        [
            DiscoveredRuntime("Engine", "one", provider=provider, availability=Available()),
            DiscoveredRuntime("engine", "two", provider=provider, availability=Available()),
        ]
    )
    with pytest.raises(EngineSelectionError, match="more than one distribution"):
        twice.select("engine")


# -- a BaseException from a hook is logged, an interrupt still goes on ----------------------------------------


class Cancelled(BaseException):
    """What a library's own cancellation class looks like: not an Exception."""


def test_a_base_exception_from_the_trace_leaves_the_verdict_and_an_interrupt_goes_on(
    caplog: pytest.LogCaptureFixture,
) -> None:
    raised: list[BaseException] = []

    def trace(record: TraceRecord) -> None:
        if raised:
            raise raised[0]

    sandbox = DatumSandbox(
        SandboxSettings.build(trace="all", report=False, warm_up_runs=1), runtime=FakeRuntime(), trace=trace
    )
    sandbox.start()
    try:
        raised.append(Cancelled())
        with caplog.at_level(logging.WARNING, logger="datum.runtime"):
            assert sandbox.sandbox.validate(context("Ada"), real=False).outcome["errors"] == []
        assert "Cancelled" in caplog.text
        raised[0] = KeyboardInterrupt()
        with pytest.raises(KeyboardInterrupt):
            sandbox.sandbox.validate(context("Ada"), real=False)
    finally:
        raised.clear()
        sandbox.stop()


def test_a_base_exception_from_the_sink_keeps_the_writer_writing() -> None:
    sink = MemorySink()
    sink.fail = Cancelled()
    made = FailedRunCapture(sink, max_runs=5, max_bytes=10**6, queue_bytes=10**6, warn=lambda _text: None)
    made.start()
    made.offer(capture(1))
    assert wait_for(lambda: made.failed == 1)
    made.offer(capture(2))
    assert wait_for(lambda: made.written == 1), "the writer is still alive"
    made.stop(1)


# -- an offer racing a stop is written or counted, never stuck -------------------------------------------------


def test_an_offer_racing_the_stop_is_never_left_behind_the_end() -> None:
    sink = MemorySink()
    made = FailedRunCapture(sink, max_runs=5, max_bytes=10**6, queue_bytes=10**6, warn=lambda _text: None)
    made.start()
    generation = made._generation  # the race needs the queue the offer puts into
    assert generation is not None
    real = generation.items
    stopper = threading.Thread(target=made.stop, args=(2.0,))

    class Racing:
        def put(self, item: object) -> None:
            if isinstance(item, RunCapture) and not stopper.is_alive():
                stopper.start()  # the stop runs while this offer is between its checks and its put
                stopper.join(0.3)
            real.put(item)

        def get(self, *args: object, **kwargs: object) -> object:
            return real.get(*args, **kwargs)  # type: ignore[arg-type]

        def get_nowait(self) -> object:
            return real.get_nowait()

    generation.items = Racing()  # type: ignore[assignment]
    made.offer(capture(1))
    stopper.join(5)
    assert wait_for(lambda: made.written + made.dropped == 1), (made.written, made.dropped)
    assert made._pending == 0  # nothing is left counted as waiting


# -- a smoke run with the wrong verdict is a failed run -------------------------------------------------------


class NoVerdict(FakeRuntime):
    """Answers every validation with no errors, so the smoke run's verdict is wrong."""

    def run(self, job: GuestRun, /) -> RunResult:
        script = job.app_files[APP_RUN_SCRIPT].decode()
        if "__datum_inspect" in script:
            return super().run(job)
        body = job.stdin[:33] + b'{"values": {"name": "x"}}'
        return super().run(
            GuestRun(app_files=job.app_files, argv=job.argv, stdin=body, budget=job.budget, timed=job.timed)
        )


def test_a_smoke_with_the_wrong_verdict_is_traced_as_a_failure() -> None:
    records: list[TraceRecord] = []
    sandbox = DatumSandbox(
        SandboxSettings.build(trace="failures", report=False, warm_up_runs=1), runtime=NoVerdict(), trace=records.append
    )
    with pytest.raises(Exception, match="smoke"):
        sandbox.start()
    assert [(record.op, record.outcome) for record in records] == [("smoke", "no_outcome")]


# -- what the host's configuration refuses, the settings refuse too ----------------------------------


@pytest.mark.parametrize(
    ("values", "match"),
    [
        ({"tick": 0}, "tick"),
        ({"tick": 0.0001}, "tick"),
        ({"startup_budget": 0}, "startup_budget"),
        ({"unknown_fields": "bogus-word"}, "unknown_fields"),
        ({"log_level": "loud"}, "log_level"),
    ],
)
def test_the_floors_and_the_host_words_refuse_the_build(values: dict[str, object], match: str) -> None:
    with pytest.raises(DatumConfigurationError, match=match):
        SandboxSettings.build(**values)  # type: ignore[arg-type]
    assert SandboxSettings.build(unknown_fields="Reject", log_level="DEBUG").host.unknown_fields == "reject"


# -- the async facade always stops ---------------------------------------------------------------------------


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


@pytest.mark.anyio
async def test_a_cancel_in_the_body_still_stops_the_sandbox() -> None:
    inner = DatumSandbox(SandboxSettings.build(report=False, warm_up_runs=1), runtime=FakeRuntime())
    with anyio.move_on_after(0.5):
        async with AsyncDatumSandbox(inner):
            await anyio.sleep(10)
    assert inner.state is SandboxState.STOPPED
    assert inner.runtime is None


class SlowFailingStart(SmokeTraps):
    def run(self, job: GuestRun, /) -> RunResult:
        time.sleep(0.2)
        return super().run(job)


@pytest.mark.anyio
async def test_a_start_that_fails_under_a_cancel_is_still_stopped() -> None:
    # The worker thread finishes the start whatever the cancel; when that start fails, the cancel is already pending,
    # so only a shielded stop reaches the worker thread at all.
    stops: list[float | None] = []

    class Noting(DatumSandbox):
        def stop(self, *, deadline: float | None = None) -> None:
            stops.append(deadline)
            super().stop(deadline=deadline)

    inner = Noting(SandboxSettings.build(report=False, warm_up_runs=1), runtime=SlowFailingStart())
    with anyio.move_on_after(0.1), pytest.raises(Exception, match="smoke"):
        async with AsyncDatumSandbox(inner):
            await anyio.sleep(10)  # pragma: no cover - the start fails
    assert stops == [None], "the stop after the failed start ran although the scope was cancelled"
    assert inner.state is SandboxState.FAILED
    assert inner.runtime is None


@pytest.mark.anyio
async def test_the_calls_take_the_given_limiter() -> None:
    limiter = anyio.CapacityLimiter(1)
    seen: list[int] = []

    class Noting(FakeRuntime):
        def run(self, job: GuestRun, /) -> RunResult:
            seen.append(limiter.borrowed_tokens)
            return super().run(job)

    async with AsyncDatumSandbox(
        DatumSandbox(SandboxSettings.build(report=False, warm_up_runs=1), runtime=Noting()), limiter=limiter
    ) as sandbox:
        await sandbox.sandbox.validate(context("Ada"), real=False)
    assert seen
    assert set(seen) == {1}, "every run was made under the host's limiter"


# -- no host path and no secret in what a read shows ---------------------------------------------------


def test_a_url_secret_is_masked_whatever_it_holds() -> None:
    assert scrub("https://user:pa/ss?w@host/x") == "https://***@host/x"
    assert scrub("redis://:pa;ss@h:6379/0") == "redis://***@h:6379/0"
    assert scrub("ftp://u:p@ss@host/f") == "ftp://***@host/f"
    assert scrub("https://h/p?token=abc#k=secret") == "https://h/p?token=***#k=***"
    assert scrub("https://h/p#bare-secret") == "https://h/p#***"
    assert scrub("(see https://h/a?q=1).") == "(see https://h/a?q=***)."


def test_an_engine_note_shows_no_host_path() -> None:
    note = "guest: qjs-wasi.wasm sha256 ab (/Users/someone/own.wasm), https://h/x/y, C:\\\\Users\\\\a.wasm"
    shown = without_paths(note)
    assert "/Users/someone" not in shown
    assert "C:\\\\Users" not in shown
    assert "https://h/x/y" in shown

    class Pathed(FakeRuntime):
        def engine_info(self):  # type: ignore[no-untyped-def]
            info = super().engine_info()
            return type(info)(info.id, info.release, info.mode, ("guest (/srv/secret/own.wasm)",))

    sandbox = DatumSandbox(SandboxSettings.build(report=False, warm_up_runs=1), runtime=Pathed())
    sandbox.start()
    try:
        assert sandbox.status().details["engineNotes"] == ["guest (<path>)"]
    finally:
        sandbox.stop()
