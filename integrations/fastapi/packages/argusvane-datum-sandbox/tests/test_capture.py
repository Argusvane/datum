"""The failed-run capture: the directory's hardening, atomic files, bounds, the writer.

Every case runs on a temporary directory. The owner refusal uses the sink's `euid` seam (a directory owned by another
user needs root); the macOS ACL case runs `chmod +a` for real and is skipped elsewhere.
"""

import contextlib
import json
import logging
import os
import stat
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest
from sandbox_fakes import SECRET, FakeRuntime, context

from datum_sandbox import DatumSandbox, SandboxSettings
from datum_sandbox.checks import DatumConfigurationError
from datum_sandbox.diagnostics import (
    CAPTURE_ID,
    CaptureListing,
    DirectoryCaptureSink,
    FailedRunCapture,
    PartlyRemovedError,
    RunCapture,
    acl_problem,
    capture_id,
)
from datum_sandbox.protocol import SandboxError

posix_only = pytest.mark.skipif(os.name != "posix", reason="the capture directory needs a POSIX file system")
pytestmark = posix_only


def capture(n: int = 0, size: int = 10, when: str = "20261123-120000") -> RunCapture:
    return RunCapture(
        id=f"{when}-{n:012x}",
        stdin=b"i" * size,
        stdout=b"o",
        stderr=b"e",
        run_js=b"r",
        meta=b"{}",
    )


@pytest.fixture
def directory(tmp_path: Path) -> Path:
    return tmp_path / "captures"


def wait_for(condition: object, timeout: float = 10.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if callable(condition) and condition():
            return True
        time.sleep(0.01)
    return False


def sink_at(path: Path, **options: object) -> DirectoryCaptureSink:
    return DirectoryCaptureSink(path, check_acl=False, **options)  # type: ignore[arg-type]


# -- the directory -------------------------------------------------------------------------------------------------


def test_a_missing_directory_is_made_0700_and_every_file_0600(directory: Path) -> None:
    sink = sink_at(directory)
    listing = sink.open()
    assert listing == CaptureListing({}, 0)
    assert stat.S_IMODE(directory.stat().st_mode) == 0o700
    sink.write(capture(1))
    kept = directory / capture(1).id
    assert stat.S_IMODE(kept.stat().st_mode) == 0o700
    assert sorted(p.name for p in kept.iterdir()) == sorted(
        ["stdin.bin", "stdout.bin", "stderr.bin", "run.js", "meta.json"]
    )
    assert {stat.S_IMODE(p.stat().st_mode) for p in kept.iterdir()} == {0o600}
    assert [p.name for p in directory.iterdir()] == [capture(1).id], "no probe or partial is left behind"
    sink.close()


@pytest.mark.parametrize("mode", [0o750, 0o705, 0o740, 0o701, 0o770])
def test_a_directory_with_group_or_other_bits_is_refused(directory: Path, mode: int) -> None:
    directory.mkdir(mode=0o700)
    directory.chmod(mode)
    with pytest.raises(DatumConfigurationError, match="group or other permissions"):
        sink_at(directory).open()


def test_a_symlinked_directory_is_refused(tmp_path: Path) -> None:
    real = tmp_path / "real"
    real.mkdir(mode=0o700)
    link = tmp_path / "link"
    link.symlink_to(real)
    with pytest.raises(DatumConfigurationError, match="link"):
        sink_at(link).open()


def test_a_file_in_place_of_the_directory_is_refused(directory: Path) -> None:
    directory.write_bytes(b"not a directory")
    with pytest.raises(DatumConfigurationError, match=r"datum\.runtime\.diagnostics\.capture\.directory"):
        sink_at(directory).open()


@pytest.mark.skipif(hasattr(os, "geteuid") and os.geteuid() == 0, reason="root writes into a read-only directory")
def test_an_unwritable_directory_is_refused(directory: Path) -> None:
    directory.mkdir(mode=0o500)
    try:
        with pytest.raises(DatumConfigurationError, match="not writable"):
            sink_at(directory).open()
    finally:
        directory.chmod(0o700)


def test_a_directory_owned_by_another_user_is_refused(directory: Path) -> None:
    """The owner check compares the directory's owner with the effective user (here a seam: another uid)."""
    directory.mkdir(mode=0o700)
    with pytest.raises(DatumConfigurationError, match="owned by another user"):
        sink_at(directory, euid=lambda: os.geteuid() + 1).open()


def test_the_checks_run_again_before_every_write(directory: Path) -> None:
    sink = sink_at(directory)
    sink.open()
    directory.chmod(0o755)
    with pytest.raises(DatumConfigurationError, match="group or other"):
        sink.write(capture(1))
    directory.chmod(0o700)
    sink.write(capture(1))
    moved = directory.parent / "moved"
    directory.rename(moved)
    directory.mkdir(mode=0o700)
    with pytest.raises(DatumConfigurationError, match="replaced"):
        sink.write(capture(2))
    sink.close()


def test_a_directory_swapped_for_a_link_after_the_start_is_refused(tmp_path: Path) -> None:
    directory = tmp_path / "captures"
    sink = sink_at(directory)
    sink.open()
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir(mode=0o700)
    directory.rename(tmp_path / "old")
    directory.symlink_to(elsewhere)
    with pytest.raises(DatumConfigurationError):
        sink.write(capture(1))
    assert list(elsewhere.iterdir()) == [], "nothing was written through the link"
    sink.close()


# -- the macOS access-control check --------------------------------------------------------------------------------


def test_the_acl_parser_accepts_a_plain_listing_and_refuses_an_acl() -> None:
    assert acl_problem("drwx------  2 me  staff  64 Nov 23 12:00 /c\n") is None
    assert acl_problem("drwx------@ 2 me  staff  64 Nov 23 12:00 /c\n") is None
    assert acl_problem("drwx------+ 2 me  staff  64 Nov 23 12:00 /c\n") is not None
    listing = "drwx------@ 2 me  staff  64 Nov 23 12:00 /c\n 0: group:everyone allow list,search,file_inherit\n"
    assert acl_problem(listing) is not None, "an entry shows even where '@' hides the '+'"
    assert acl_problem("") is not None, "no answer fails closed"
    assert acl_problem("total 0\n") is not None, "an answer that is no directory listing fails closed"


def test_an_acl_check_that_cannot_run_refuses_the_start(directory: Path) -> None:
    def broken(path: Path) -> str:
        raise OSError("ls is gone")

    with pytest.raises(DatumConfigurationError, match="could not run"):
        DirectoryCaptureSink(directory, check_acl=True, acl_listing=broken).open()


def test_an_acl_listing_with_an_entry_refuses_and_names_the_fix(directory: Path) -> None:
    def with_entry(path: Path) -> str:
        return f"drwx------+ 2 me staff 64 Nov 23 12:00 {path}\n 0: group:everyone allow read\n"

    with pytest.raises(DatumConfigurationError) as refused:
        DirectoryCaptureSink(directory, check_acl=True, acl_listing=with_entry).open()
    assert "chmod -N" in refused.value.hint


@pytest.mark.skipif(sys.platform != "darwin", reason="macOS ACLs")
def test_a_real_inherited_acl_on_macos_is_refused(directory: Path) -> None:
    directory.mkdir(mode=0o700)
    subprocess.run(  # noqa: S603 - a fixed system binary and a test directory
        ["/bin/chmod", "+a", "group:everyone allow list,search,read,file_inherit,directory_inherit", str(directory)],
        check=True,
    )
    try:
        with pytest.raises(DatumConfigurationError, match="access-control"):
            DirectoryCaptureSink(directory).open()
    finally:
        subprocess.run(["/bin/chmod", "-N", str(directory)], check=True)  # noqa: S603


# -- names and atomic visibility -----------------------------------------------------------------------------------


def test_names_come_from_the_capture_id_alone() -> None:
    assert CAPTURE_ID.fullmatch(capture_id("0123456789ab"))
    for hostile in ("../../etc", "20261123-120000-0123456789ab/../x", "a\x00b", "20261123-120000-ZZZZZZZZZZZZ"):
        with pytest.raises(ValueError, match="capture id"):
            RunCapture(id=hostile, stdin=b"", stdout=b"", stderr=b"", run_js=b"", meta=b"")


def test_a_capture_directory_is_visible_only_when_complete(directory: Path) -> None:
    sink = sink_at(directory)
    sink.open()
    seen: list[set[str]] = []
    stop = threading.Event()

    def watch() -> None:
        while not stop.is_set():
            for entry in list(directory.iterdir()):
                if CAPTURE_ID.fullmatch(entry.name):
                    with contextlib.suppress(FileNotFoundError):  # evicted in between
                        seen.append({p.name for p in entry.iterdir()})

    watcher = threading.Thread(target=watch)
    watcher.start()
    try:
        for n in range(20):
            sink.write(capture(n, size=256 * 1024))
    finally:
        stop.set()
        watcher.join()
    assert seen, "the watcher saw captures"
    assert all(len(names) == 5 for names in seen), "a capture-named directory always held all five files"
    sink.close()


# -- the queue, the bounds and the writer --------------------------------------------------------------------------


class MemorySink:
    """A sink in memory; `delay` slows every write, `fail` makes writes raise, `kept` is what it holds."""

    def __init__(self, *, delay: float = 0.0, fail: BaseException | None = None, listing: CaptureListing | None = None):
        self.delay = delay
        self.fail = fail
        self.listing = listing or CaptureListing({})
        self.kept: dict[str, int] = {}
        self.removed: list[str] = []
        self.remove_error: OSError | None = None
        self.written = threading.Event()

    def open(self) -> CaptureListing:
        return self.listing

    def write(self, item: RunCapture) -> int:
        if self.delay:
            time.sleep(self.delay)
        if self.fail is not None:
            raise self.fail
        self.kept[item.id] = item.size
        self.written.set()
        return item.size

    def remove(self, capture_id: str) -> None:
        if self.remove_error is not None:
            raise self.remove_error
        self.removed.append(capture_id)
        self.kept.pop(capture_id, None)

    def describe(self) -> str:
        return "memory"


@pytest.fixture
def warnings() -> list[str]:
    return []


def started_capture(sink: object, warnings: list[str], **bounds: int) -> FailedRunCapture:
    options = {"max_runs": 3, "max_bytes": 1000, "queue_bytes": 1000, **bounds}
    made = FailedRunCapture(sink, warn=warnings.append, **options)  # type: ignore[arg-type]
    made.start()
    return made


def test_the_start_warns_that_captures_hold_personal_data(warnings: list[str]) -> None:
    sink = MemorySink(listing=CaptureListing({}, leftovers=2))
    made = started_capture(sink, warnings)
    made.stop(1)
    assert "personal data" in warnings[0]
    assert "2 leftover" in warnings[0]


def test_eviction_keeps_max_runs_by_name_oldest_first(warnings: list[str]) -> None:
    sink = MemorySink()
    made = started_capture(sink, warnings, max_runs=3)
    for n in range(5):
        assert made.offer(capture(n)) == capture(n).id
    made.stop(5)
    assert sorted(sink.kept) == [capture(n).id for n in (2, 3, 4)]
    assert sink.removed == [capture(0).id, capture(1).id]


def test_eviction_keeps_max_bytes(warnings: list[str]) -> None:
    sink = MemorySink()
    made = started_capture(sink, warnings, max_runs=100, max_bytes=50)
    for n in range(5):
        made.offer(capture(n, size=16))  # 20 bytes each
    made.stop(5)
    assert sum(sink.kept.values()) <= 50
    assert len(sink.kept) == 2


def test_the_capture_just_written_is_never_evicted_even_with_the_clock_stepped_back(warnings: list[str]) -> None:
    sink = MemorySink()
    made = started_capture(sink, warnings, max_runs=1)
    made.offer(capture(1, when="20261123-120000"))
    made.offer(capture(2, when="20250101-000000"))  # an older name, written last
    made.stop(5)
    assert list(sink.kept) == [capture(2, when="20250101-000000").id]


def test_an_oversize_capture_is_dropped_and_counted(warnings: list[str]) -> None:
    made = started_capture(MemorySink(), warnings, max_bytes=10)
    assert made.offer(capture(1, size=100)) == "dropped"
    made.stop(1)
    assert made.dropped == 1
    assert any("larger than max_bytes" in text for text in warnings)


def test_a_full_queue_drops_without_blocking(warnings: list[str]) -> None:
    sink = MemorySink(delay=0.5)
    made = started_capture(sink, warnings, queue_bytes=30, max_runs=100, max_bytes=1000)
    began = time.monotonic()
    answers = [made.offer(capture(n, size=6)) for n in range(5)]  # 10 bytes each; 30 fit in the queue
    assert time.monotonic() - began < 0.2, "offer never waits for the writer"
    assert answers.count("dropped") >= 2
    made.stop(5)
    assert made.dropped >= 2


def test_drop_warnings_are_rate_limited(warnings: list[str]) -> None:
    made = started_capture(MemorySink(), warnings, max_bytes=5)
    for n in range(50):
        made.offer(capture(n, size=100))
    made.stop(1)
    assert len([text for text in warnings if "dropped" in text]) == 1
    assert made.dropped == 50


def test_a_write_error_is_counted_and_named_by_id_and_class_only(warnings: list[str], tmp_path: Path) -> None:
    sink = MemorySink(fail=OSError(f"cannot write {tmp_path}/secret-path"))
    made = started_capture(sink, warnings)
    made.offer(capture(1))
    assert wait_for(lambda: made.failed == 1)
    made.stop(1)
    text = next(text for text in warnings if "could not write" in text)
    assert capture(1).id in text
    assert "OSError" in text
    assert str(tmp_path) not in text, "an OSError's message carries a path: never in the warning"


def test_a_sink_that_raises_an_assertion_error_keeps_the_writer_alive(warnings: list[str]) -> None:
    sink = MemorySink(fail=AssertionError("boom"))
    made = started_capture(sink, warnings)
    made.offer(capture(1))
    assert wait_for(lambda: made.failed == 1)
    sink.fail = None
    made.offer(capture(2))
    assert sink.written.wait(5), "the writer still writes after the sink raised"
    made.stop(1)


def test_a_failed_rename_on_eviction_keeps_the_capture_counted(warnings: list[str]) -> None:
    sink = MemorySink()
    made = started_capture(sink, warnings, max_runs=1)
    sink.remove_error = OSError("busy")
    made.offer(capture(1))
    made.offer(capture(2))
    assert wait_for(lambda: made.failed == 1)
    assert set(made.kept) == {capture(1).id, capture(2).id}, "still held and counted"
    sink.remove_error = PartlyRemovedError("left the names")
    made.offer(capture(3))
    made.stop(5)
    assert capture(1).id not in made.kept, "a capture that left the names is no longer counted"


def test_stop_drains_the_queue_within_its_grace(warnings: list[str]) -> None:
    sink = MemorySink(delay=0.05)
    made = started_capture(sink, warnings, max_runs=100, max_bytes=10_000)
    for n in range(5):
        made.offer(capture(n))
    began = time.monotonic()
    made.stop(5)
    assert time.monotonic() - began < 5
    assert len(sink.kept) == 5


def test_stop_never_takes_longer_than_its_grace_and_drops_the_rest(warnings: list[str]) -> None:
    sink = MemorySink(delay=0.4)
    made = started_capture(sink, warnings, max_runs=100, max_bytes=10_000)
    for n in range(10):
        made.offer(capture(n))
    began = time.monotonic()
    made.stop(1.0)
    assert time.monotonic() - began < 1.0 + 0.3
    assert made.dropped > 0


def test_a_start_refuses_while_the_last_writer_still_runs(warnings: list[str]) -> None:
    release = threading.Event()

    class Stubborn(MemorySink):
        def write(self, item: RunCapture) -> int:
            release.wait(10)  # ignores the stop
            return super().write(item)

    sink = Stubborn()
    made = started_capture(sink, warnings)
    made.offer(capture(1))
    time.sleep(0.05)
    made.stop(0.2)
    with pytest.raises(RuntimeError, match="still running"):
        made.start()
    release.set()
    assert wait_for(lambda: not any(t.name == "datum-sandbox-capture" and t.is_alive() for t in threading.enumerate()))
    made.start()
    made.stop(1)


def test_bounds_below_one_refuse_the_build() -> None:
    for name in ("max_runs", "max_bytes", "queue_bytes"):
        with pytest.raises(DatumConfigurationError, match=name):
            FailedRunCapture(MemorySink(), **{"max_runs": 1, "max_bytes": 1, "queue_bytes": 1, name: 0})  # type: ignore[arg-type]
    with pytest.raises(DatumConfigurationError, match="max_runs"):
        SandboxSettings.build(capture_max_runs=0)


def test_a_throwing_describe_never_fails_the_start_or_the_report(warnings: list[str]) -> None:
    class Nameless(MemorySink):
        def describe(self) -> str:
            raise RuntimeError("no name")

    made = started_capture(Nameless(), warnings)
    assert made.describe() == "a Nameless"
    made.stop(1)


def test_descriptions_are_scrubbed_in_the_warning(warnings: list[str]) -> None:
    class Remote(MemorySink):
        def describe(self) -> str:
            return "object store https://key:secret@minio.example/captures?token=abc"

    made = started_capture(Remote(), warnings)
    made.stop(1)
    assert "secret" not in warnings[0]
    assert "abc" not in warnings[0]
    assert "https://***@minio.example/captures?token=***" in warnings[0]


# -- through the sandbox -------------------------------------------------------------------------------------------


def sandbox_capturing(directory: Path, **values: object) -> tuple[DatumSandbox, FakeRuntime]:
    runtime = FakeRuntime()
    settings = SandboxSettings.build(
        capture_enabled=True,
        capture_directory=str(directory),
        report=False,
        warm_up_runs=1,
        **values,  # type: ignore[arg-type]
    )
    sandbox = DatumSandbox(settings, runtime=runtime)
    return sandbox, runtime


def test_a_failed_run_is_captured_with_owner_only_modes_and_a_verdict_is_not(
    directory: Path, caplog: pytest.LogCaptureFixture
) -> None:
    sandbox, _ = sandbox_capturing(directory)  # on macOS the ACL check runs for real: the tmp directory has none
    with caplog.at_level(logging.WARNING, logger="datum.runtime"):
        sandbox.start()
    try:
        assert "personal data" in caplog.text
        sandbox.sandbox.validate(context("Ada"), real=False)
        with pytest.raises(SandboxError):
            sandbox.sandbox.validate(context("TRAP-ME", secret=SECRET), real=False)
        capture_ = sandbox.capture
        assert capture_ is not None
        assert wait_for(lambda: capture_.written == 1)
    finally:
        sandbox.stop()
    (kept,) = [entry for entry in directory.iterdir() if CAPTURE_ID.fullmatch(entry.name)]
    assert stat.S_IMODE(directory.stat().st_mode) == 0o700
    assert stat.S_IMODE(kept.stat().st_mode) == 0o700
    assert {stat.S_IMODE(p.stat().st_mode) for p in kept.iterdir()} == {0o600}
    assert SECRET.encode() in (kept / "stdin.bin").read_bytes(), "the capture holds the run's own input"
    meta = json.loads((kept / "meta.json").read_text())
    assert meta["trace"]["outcome"] == "trap"
    assert meta["program"]["kind"] == "sandbox"
    nonce = (kept / "stdin.bin").read_bytes()[:32].decode("ascii")
    assert nonce not in (kept / "meta.json").read_text(), "meta.json never holds the run's nonce"
    assert (kept / "run.js").read_bytes().startswith(b"(function (std, print, evaluate)")


def test_the_status_carries_the_capture_counters_while_it_is_on(directory: Path) -> None:
    sandbox, _ = sandbox_capturing(directory)
    sandbox.start()
    try:
        details = sandbox.status().details
        assert (details["captureDropped"], details["captureFailed"]) == (0, 0)
    finally:
        sandbox.stop()


def test_an_unsafe_directory_refuses_the_start_whatever_fail_fast_says(directory: Path) -> None:
    directory.mkdir(mode=0o755)
    directory.chmod(0o755)
    sandbox, runtime = sandbox_capturing(directory, fail_fast=False)
    with pytest.raises(DatumConfigurationError, match="group or other"):
        sandbox.start()
    assert runtime.runs == [], "no run was made before the refusal"


def test_capture_without_a_directory_refuses_the_start() -> None:
    runtime = FakeRuntime()
    sandbox = DatumSandbox(SandboxSettings.build(capture_enabled=True, report=False), runtime=runtime)
    with pytest.raises(DatumConfigurationError, match=r"capture\.directory is not set"):
        sandbox.start()
