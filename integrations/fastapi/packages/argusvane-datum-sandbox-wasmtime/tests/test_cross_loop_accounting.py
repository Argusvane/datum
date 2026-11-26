"""Cross-loop safety : one runtime driven from eight threads, each under its own `asyncio.run`.

Every call is accounted once (answered, budget-stopped, refused or failed), every slot comes back, no thread dies with
an exception, the epoch clock is the one Datum thread besides the runs, and after `close()` no Datum thread is left
at once and no other thread after a short settle (anyio's and asyncio's pool workers linger a few milliseconds). The
negative control shows the thread-death count would catch loop-bound state in the process: one `anyio.CapacityLimiter`
shared across the eight loops fails in their threads.
"""

import asyncio
import random
import threading
import time
from collections import Counter
from pathlib import Path

import pytest
from guests import datum_limits

from datum_sandbox.testing.runtime_support import STARTED, budget, live_threads, run_raw, settle
from datum_sandbox.wasi import EngineBusyError, EngineSettings, RunEnd
from datum_sandbox_wasmtime import WasmtimeGuestRuntime
from datum_sandbox_wasmtime._clock import THREAD_NAME

pytestmark = pytest.mark.runtime

LOOPS = 8
TASKS = 6
ITERATIONS = 4
SLOTS = 4
SCRIPTS = {
    "answer": ("print('ok');", RunEnd.CLEAN),
    "spin": (f"print('{STARTED}'); for (;;) {{}}", RunEnd.BUDGET),
    "throw": ("throw new Error('no');", RunEnd.EXIT),
}
KINDS = ["answer"] * 6 + ["spin", "throw"]


class Deaths:
    """Count the threads that died with an exception while installed as `threading.excepthook`."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.seen: list[str] = []

    def __call__(self, args: threading.ExceptHookArgs) -> None:
        with self.lock:
            self.seen.append(f"{args.thread.name if args.thread else '?'}: {args.exc_type.__name__}")


def _call(runtime: WasmtimeGuestRuntime, kind: str) -> str:
    script, want = SCRIPTS[kind]
    try:
        result = run_raw(runtime, script, budget(0.3, 32, wait=0.3))
    except EngineBusyError:
        return "refused"
    return "expected" if result.end is want else f"unexpected {result.end}"


def _loop_thread(
    runtime: WasmtimeGuestRuntime, seed: int, tally: Counter[tuple[str, str]], guard: threading.Lock
) -> None:
    rnd = random.Random(seed)  # noqa: S311 - a test's input mix

    async def one() -> None:
        for _ in range(ITERATIONS):
            kind = rnd.choice(KINDS)
            outcome = await asyncio.to_thread(_call, runtime, kind)
            with guard:
                tally[kind, outcome] += 1

    async def main() -> None:
        await asyncio.gather(*(one() for _ in range(TASKS)))

    asyncio.run(main())


def test_eight_event_loops_share_one_runtime_and_every_call_is_accounted(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    deaths = Deaths()
    monkeypatch.setattr(threading, "excepthook", deaths)
    before = live_threads()
    runtime = WasmtimeGuestRuntime(datum_limits(SLOTS, 1, tmp_path, 0.05), EngineSettings(stop_grace=5.0))
    tally: Counter[tuple[str, str]] = Counter()
    guard = threading.Lock()
    threads = [
        threading.Thread(target=_loop_thread, args=(runtime, seed, tally, guard), name=f"loop-{seed}")
        for seed in range(LOOPS)
    ]
    try:
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(240)
        hung = [thread.name for thread in threads if thread.is_alive()]
        during = {t.name for t in live_threads() - before}
        stats = runtime.stats()["validation"]
    finally:
        runtime.close()
    assert hung == []
    assert deaths.seen == []
    assert sum(tally.values()) == LOOPS * TASKS * ITERATIONS, "every call answered exactly once"
    unexpected = {key: n for key, n in tally.items() if key[1] not in {"expected", "refused"}}
    assert unexpected == {}, "a spin is only ever stopped or refused, an answer only answered or refused"
    assert (stats.slots_in_use, stats.runs_in_flight, stats.stuck_runs, stats.stray_runs) == (0, 0, 0, 0)
    assert THREAD_NAME in during, "the one clock thread ran beside the runs"
    assert not [t for t in live_threads() - before if t.name.startswith("datum-")], "no Datum thread after close"
    assert settle(lambda: live_threads() <= before, timeout=1.0), sorted(t.name for t in live_threads() - before)


def test_the_negative_control_a_loop_bound_limiter_shared_across_loops_kills_threads(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    anyio = pytest.importorskip("anyio")
    deaths = Deaths()
    monkeypatch.setattr(threading, "excepthook", deaths)
    limiter = anyio.CapacityLimiter(2)

    async def main() -> None:
        for _ in range(5):
            async with limiter:
                await asyncio.sleep(0.02)

    threads = [threading.Thread(target=asyncio.run, args=(main(),), daemon=True) for _ in range(LOOPS)]
    began = time.monotonic()
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(max(0.0, 10 - (time.monotonic() - began)))
    blocked = sum(thread.is_alive() for thread in threads)
    assert deaths.seen or blocked, "a loop-bound primitive in process state shows as dead or blocked threads"
