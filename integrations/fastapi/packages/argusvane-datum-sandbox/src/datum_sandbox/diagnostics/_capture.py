"""The failed-run capture (`datum.runtime.diagnostics.capture.*`): the bytes of a failed run, kept to replay it.

A capture holds the run's stdin (the submitted answers, the form definition and the nonce), its stdout and stderr, its
`run.js` and a `meta.json` (the trace fields, the program's sha256 and ABI, the engine and the settings report). That is
personal data in clear text, so the capture is off by default, the start WARNs that it is on, and the directory is held
to owner-only access before the first byte is written.

`FailedRunCapture` is the part every sink shares: the bounds (`max_runs` and `max_bytes` kept, `queue_bytes` waiting),
the queue and its one daemon writer thread. `offer` never blocks and never raises: a capture that does not fit is
dropped and counted. The writer writes through a `RunCaptureSink` and evicts the oldest captures (by name, never the one
just written) until both bounds hold; whatever the sink raises (an `Exception`) is counted and WARNed with the capture
id and the exception class only (an `OSError`'s message carries a path). Each writer has its own queue (a generation),
so a writer left behind by a stop can never take a later start's captures, and a start refuses while the last writer
lives.

`DirectoryCaptureSink` is the default sink: a POSIX directory, created 0700 if missing (made with the mode, never
`chmod`ed after), that must be a real directory (not a link), owned by the effective user (the owner of a probe file the
sink creates there), with no group or other permission bit, and on macOS without an access-control entry (`/bin/ls
-lde`, failing closed). The directory is opened once (`O_DIRECTORY | O_NOFOLLOW`) and every file is made through that
handle (`dir_fd`), so a path swapped after the open is never followed; before each write the handle and the path are
checked again (same device and inode, same owner, no group or other bit, no ACL). A capture is written into
`.partial-<id>` (0700) with files `O_CREAT | O_EXCL | O_NOFOLLOW` 0600, each synced, then renamed to `<id>` in one
atomic step, so a directory with a capture's name is always complete. Names come from the capture id alone (a UTC time
and a random run id). Eviction renames `<id>` to `.evict-<id>` before deleting it and touches capture-named directories
only; a `.partial-*` or
`.evict-*` left by a crash or a failed delete is never removed automatically (the start WARN counts them).
"""

import contextlib
import logging
import os
import queue
import re
import shutil
import stat
import subprocess
import sys
import threading
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Final, Protocol, cast

from datum_sandbox.checks import DatumConfigurationError
from datum_sandbox.diagnostics._report import scrub
from datum_sandbox.loggers import RUNTIME
from datum_sandbox.protocol._watch import fatal

logger = logging.getLogger(RUNTIME)

CAPTURE_ID: Final = re.compile(r"[0-9]{8}-[0-9]{6}-[0-9a-f]{12}")
"""A capture's id and directory name: `<UTC yyyymmdd>-<hhmmss>-<12 hex of the run id>`."""
PARTIAL_PREFIX: Final = ".partial-"
EVICT_PREFIX: Final = ".evict-"
FILES: Final = ("stdin.bin", "stdout.bin", "stderr.bin", "run.js", "meta.json")
"""The files of a capture, in the order they are written."""
_DIRECTORY_KEY: Final = "datum.runtime.diagnostics.capture.directory"
_WARN_EVERY: Final = 60.0
_LS: Final = "/bin/ls"
_LS_TIMEOUT: Final = 5.0
_LS_MAX: Final = 64 * 1024
_LS_MODE: Final = re.compile(r"d[-rwxsStT]{9}[@+.]?")
_ACE: Final = re.compile(r"\s*\d+:\s")
_WRITER_NAME: Final = "datum-sandbox-capture"


@dataclass(frozen=True, slots=True)
class RunCapture:
    """One failed run's bytes, ready to write: its id, the four run files and `meta.json` (UTF-8 JSON)."""

    id: str
    stdin: bytes = field(repr=False)
    stdout: bytes = field(repr=False)
    stderr: bytes = field(repr=False)
    run_js: bytes = field(repr=False)
    meta: bytes = field(repr=False)

    def __post_init__(self) -> None:
        """Hold the id to the capture pattern: no name a sink writes comes from anything else."""
        if not CAPTURE_ID.fullmatch(self.id):
            raise ValueError("a capture id is <yyyymmdd>-<hhmmss>-<12 hex>")

    @property
    def size(self) -> int:
        """The bytes the capture holds."""
        return len(self.stdin) + len(self.stdout) + len(self.stderr) + len(self.run_js) + len(self.meta)

    def files(self) -> tuple[tuple[str, bytes], ...]:
        """Return the files as (name, bytes), in `FILES` order."""
        return tuple(zip(FILES, (self.stdin, self.stdout, self.stderr, self.run_js, self.meta), strict=True))


@dataclass(frozen=True, slots=True)
class CaptureListing:
    """What a sink holds at open: each kept capture's id and size, and the leftovers it will not touch."""

    kept: Mapping[str, int]
    leftovers: int = 0


class PartlyRemovedError(OSError):
    """A capture was taken out of the names (it no longer counts) but its leftovers could not all be deleted."""


class RunCaptureSink(Protocol):
    """Where captures go. `FailedRunCapture` owns the bounds, the queue and the writer thread for every sink."""

    def open(self) -> CaptureListing:
        """Check the destination, refusing an unsafe one (`DatumConfigurationError`); list what it already holds."""
        ...

    def write(self, capture: RunCapture) -> int:
        """Write the capture so that it is visible whole or not at all; return the bytes now held for it."""
        ...

    def remove(self, capture_id: str) -> None:
        """Remove a capture; `PartlyRemovedError` when it left the names but not every byte went."""
        ...

    def describe(self) -> str:
        """Say where captures go, for the start WARN and the report (scrubbed before it is shown)."""
        ...


# -- the file sink
# ------------------------------------------------------------------------------------------------------


def _refuse(problem: str, action: str) -> DatumConfigurationError:
    return DatumConfigurationError(f"{_DIRECTORY_KEY}: {problem}", hint=action)


def read_acl_listing(directory: Path) -> str:
    """Run `/bin/ls -lde -- <directory>` (no shell, a timeout, bounded output); return its stdout, raise on failure."""
    done = subprocess.run(  # noqa: S603 - an absolute binary, no shell, the path as one argument
        [_LS, "-lde", "--", str(directory)],
        capture_output=True,
        timeout=_LS_TIMEOUT,
        check=False,
        env={"LC_ALL": "C", "PATH": "/usr/bin:/bin"},
    )
    if done.returncode != 0:
        raise OSError(f"ls exited {done.returncode}")
    if len(done.stdout) > _LS_MAX:
        raise OSError("ls answered too much")
    return done.stdout.decode("utf-8", "replace")


def acl_problem(listing: str) -> str | None:
    """Read `ls -lde` output: `None` for a directory with no ACL; else what is wrong. Unreadable output is a problem."""
    lines = [line for line in listing.splitlines() if line.strip()]
    if not lines:
        return "the access-control check answered nothing"
    mode = lines[0].split(maxsplit=1)[0] if lines[0].split() else ""
    if not _LS_MODE.fullmatch(mode):
        return "the access-control check answered something that is not a directory listing"
    if mode.endswith("+"):
        return "it carries an access-control list"
    if any(_ACE.match(line) for line in lines[1:]):
        return "it carries an access-control entry"
    return None


def _is_macos() -> bool:
    return sys.platform == "darwin"


class DirectoryCaptureSink:
    """The default sink: an owner-only POSIX directory (see the module docstring for every check)."""

    def __init__(
        self,
        directory: str | os.PathLike[str],
        *,
        acl_listing: Callable[[Path], str] | None = None,
        check_acl: bool | None = None,
        euid: Callable[[], int] | None = None,
    ) -> None:
        """Keep the directory.

        `acl_listing` replaces the `ls` call, `check_acl` forces the ACL check on or off (it runs on macOS by default)
        and `euid` names the effective user: seams for tests, which cannot make another user's directory without root.
        """
        self._path = Path(directory)
        self._euid = euid or os.geteuid
        self._acl_listing = acl_listing or read_acl_listing
        self._check_acl = _is_macos() if check_acl is None else check_acl
        self._fd: int | None = None
        self._identity: tuple[int, int] | None = None
        self._uid: int | None = None
        self._lock = threading.Lock()

    @property
    def path(self) -> Path:
        """The capture directory."""
        return self._path

    def describe(self) -> str:
        """Say where captures go."""
        return f"directory {self._path}"

    def open(self) -> CaptureListing:
        """Create the directory 0700 if missing, check it, open it, and list the captures it holds."""
        if os.name != "posix" or not hasattr(os, "geteuid"):
            raise _refuse(
                "the failed-run capture needs a POSIX file system to hold its directory to owner-only access",
                "turn datum.runtime.diagnostics.capture.enabled off: Windows and ACL-only file systems are not "
                "supported",
            )
        try:
            self._path.mkdir(mode=0o700)  # made with the mode (the umask can only take bits away), never chmod-ed
        except FileExistsError:
            pass
        except OSError as error:
            raise _refuse(
                f"{self._path} cannot be created ({type(error).__name__})",
                "create the directory yourself, owned by this process's user, with mode 0700",
            ) from None
        flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
        try:
            fd = os.open(self._path, flags)
        except OSError as error:
            raise _refuse(
                f"{self._path} cannot be opened as a directory without following a link ({type(error).__name__})",
                "point it at a real directory (not a symbolic link, not a file) owned by this process's user, "
                "mode 0700",
            ) from None
        try:
            self._check(fd, first=True)
            listing = self._listing(fd)
        except BaseException:
            os.close(fd)
            raise
        with self._lock:
            if self._fd is not None:
                os.close(self._fd)
            self._fd = fd
        return listing

    def close(self) -> None:
        """Close the directory handle."""
        with self._lock:
            fd, self._fd = self._fd, None
        if fd is not None:
            os.close(fd)

    def _check(self, fd: int, *, first: bool) -> None:
        """Hold the open directory and its path to the rules: the same directory, owner-only, no link, no ACL."""
        held = os.fstat(fd)
        try:
            named = os.lstat(self._path)
        except OSError as error:
            raise _refuse(f"{self._path} is gone ({type(error).__name__})", "recreate it, mode 0700") from None
        if not stat.S_ISDIR(held.st_mode) or stat.S_ISLNK(named.st_mode) or not stat.S_ISDIR(named.st_mode):
            raise _refuse(f"{self._path} is not a real directory", "point it at a directory, not a link or a file")
        if (named.st_dev, named.st_ino) != (held.st_dev, held.st_ino):
            raise _refuse(f"{self._path} was replaced after the start", "restart with the directory left in place")
        if first:
            self._identity = (held.st_dev, held.st_ino)
            self._uid = self._probe_owner(fd)
        elif self._identity != (held.st_dev, held.st_ino):  # pragma: no cover - the handle never changes
            raise _refuse(f"{self._path} is not the directory the start opened", "restart")
        if held.st_uid != self._uid or held.st_uid != self._euid():
            raise _refuse(
                f"{self._path} is owned by another user", "give the directory to the user this process runs as"
            )
        if held.st_mode & 0o077:
            raise _refuse(
                f"{self._path} has group or other permissions (mode {stat.S_IMODE(held.st_mode):04o})",
                f"run chmod 700 {self._path} (captured runs hold the submitted answers)",
            )
        if self._check_acl:
            try:
                problem = acl_problem(self._acl_listing(self._path))
            except (OSError, subprocess.SubprocessError, ValueError) as error:
                problem = f"the access-control check could not run ({type(error).__name__})"
            if problem is not None:
                raise _refuse(
                    f"{self._path}: {problem}; an access-control entry opens every capture file whatever its mode",
                    f"run chmod -N {self._path}, and remove any inheritable entry from its parent directory",
                )

    def _probe_owner(self, fd: int) -> int:
        """Return the owner of a file this process creates in the directory (its effective user, whatever it says)."""
        name = f".probe-{os.urandom(6).hex()}"
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
        try:
            probe = os.open(name, flags, 0o600, dir_fd=fd)
        except OSError as error:
            raise _refuse(
                f"{self._path} is not writable by this process ({type(error).__name__})",
                "give the directory to the user this process runs as, mode 0700",
            ) from None
        try:
            return os.fstat(probe).st_uid
        finally:
            os.close(probe)
            with contextlib.suppress(OSError):
                os.unlink(name, dir_fd=fd)

    def _listing(self, fd: int) -> CaptureListing:
        kept: dict[str, int] = {}
        leftovers = 0
        for name in sorted(os.listdir(fd)):
            if name.startswith((PARTIAL_PREFIX, EVICT_PREFIX)):
                leftovers += 1
            elif CAPTURE_ID.fullmatch(name):
                kept[name] = _tree_size(fd, name)
        return CaptureListing(kept, leftovers)

    def _held(self) -> int:
        with self._lock:
            fd = self._fd
        if fd is None:
            raise OSError("the capture directory is not open")
        self._check(fd, first=False)
        return fd

    def write(self, capture: RunCapture) -> int:
        """Write `.partial-<id>` (0700, files 0600, each synced), then rename it to `<id>` in one step."""
        fd = self._held()
        partial = PARTIAL_PREFIX + capture.id
        os.mkdir(partial, 0o700, dir_fd=fd)
        inner = os.open(partial, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0), dir_fd=fd)
        try:
            for name, data in capture.files():
                _write_new(inner, name, data)
            os.fsync(inner)
        finally:
            os.close(inner)
        if _exists(fd, capture.id):
            raise FileExistsError("a capture with this id is already kept")
        os.rename(partial, capture.id, src_dir_fd=fd, dst_dir_fd=fd)
        with contextlib.suppress(OSError):
            os.fsync(fd)
        return capture.size

    def remove(self, capture_id: str) -> None:
        """Rename `<id>` to `.evict-<id>` (it leaves the names), then delete it without following a link."""
        if not CAPTURE_ID.fullmatch(capture_id):
            raise ValueError("not a capture id")
        fd = self._held()
        evicted = EVICT_PREFIX + capture_id
        os.rename(capture_id, evicted, src_dir_fd=fd, dst_dir_fd=fd)
        try:
            shutil.rmtree(evicted, dir_fd=fd)
        except OSError as error:
            raise PartlyRemovedError(f"capture {capture_id} left the names but not every file went") from error


def _write_new(dir_fd: int, name: str, data: bytes) -> None:
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0)
    handle = os.open(name, flags, 0o600, dir_fd=dir_fd)
    try:
        view = memoryview(data)
        while view:
            written = os.write(handle, view)
            view = view[written:]
        os.fsync(handle)
    finally:
        os.close(handle)


def _exists(dir_fd: int, name: str) -> bool:
    try:
        os.stat(name, dir_fd=dir_fd, follow_symlinks=False)
    except FileNotFoundError:
        return False
    return True


def _tree_size(dir_fd: int, name: str) -> int:
    total = 0
    try:
        inner = os.open(name, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0), dir_fd=dir_fd)
    except OSError:
        return 0
    try:
        for entry in os.listdir(inner):  # noqa: PTH208 - through the open handle, never the path
            with contextlib.suppress(OSError):
                info = os.stat(entry, dir_fd=inner, follow_symlinks=False)
                if stat.S_ISREG(info.st_mode):
                    total += info.st_size
    finally:
        os.close(inner)
    return total


# -- the queue and the writer ------------------------------------------------------------------------------------------


class _RateLimitedWarning:
    """One WARN a minute at most for one kind of trouble, with the count since the last one in its text."""

    def __init__(self, warn: Callable[[str], None], clock: Callable[[], float]) -> None:
        self._warn = warn
        self._clock = clock
        self._lock = threading.Lock()
        self._last: float | None = None
        self._since = 0

    def __call__(self, text: Callable[[int], str]) -> None:
        with self._lock:
            self._since += 1
            now = self._clock()
            if self._last is not None and now - self._last < _WARN_EVERY:
                return
            self._last, count, self._since = now, self._since, 0
        with contextlib.suppress(Exception):  # a WARN that fails never reaches the run
            self._warn(text(count))


_END: Final = object()

_WRITERS_LOCK: Final = threading.Lock()
_WRITERS: Final[dict[object, threading.Thread]] = {}
"""The writer thread last started for each destination (a directory sink's path, else the sink object's id)."""


def _destination(sink: object) -> object:
    path = getattr(sink, "path", None)
    return ("path", str(path)) if isinstance(path, Path) else ("sink", id(sink))


class _Generation:
    """One writer's queue, so an old writer never takes a later start's captures."""

    def __init__(self) -> None:
        self.items: queue.SimpleQueue[object] = queue.SimpleQueue()
        self.stopping = threading.Event()


class FailedRunCapture:
    """The bounds, the queue and the one writer thread of the failed-run capture, for any `RunCaptureSink`."""

    def __init__(
        self,
        sink: RunCaptureSink,
        *,
        max_runs: int,
        max_bytes: int,
        queue_bytes: int,
        warn: Callable[[str], None] | None = None,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        """Hold the sink and the bounds (each at least 1); nothing starts here."""
        for name, value in (("max_runs", max_runs), ("max_bytes", max_bytes), ("queue_bytes", queue_bytes)):
            if isinstance(value, bool) or not isinstance(cast("object", value), int) or value < 1:
                raise DatumConfigurationError(
                    f"datum.runtime.diagnostics.capture.{name} is {value!r}: the capture's bounds are at least 1",
                    hint=f"set datum.runtime.diagnostics.capture.{name} to 1 or more",
                )
        self._sink = sink
        self._max_runs = max_runs
        self._max_bytes = max_bytes
        self._queue_bytes = queue_bytes
        self._warn = warn or logger.warning
        self._lock = threading.Lock()
        self._pending = 0
        self._kept: dict[str, int] = {}
        self._dropped = 0
        self._failed = 0
        self._written = 0
        self._generation: _Generation | None = None
        self._thread: threading.Thread | None = None
        self._drop_warning = _RateLimitedWarning(self._warn, clock)
        self._fail_warning = _RateLimitedWarning(self._warn, clock)

    # -- counters ---------------------------------------------------------------------------------------------------
    @property
    def dropped(self) -> int:
        """Captures dropped: too large, the queue full, or left in the queue at stop."""
        with self._lock:
            return self._dropped

    @property
    def failed(self) -> int:
        """Writes and removals the sink failed."""
        with self._lock:
            return self._failed

    @property
    def written(self) -> int:
        """Captures written."""
        with self._lock:
            return self._written

    @property
    def kept(self) -> dict[str, int]:
        """The captures held now, by id, with their sizes."""
        with self._lock:
            return dict(self._kept)

    def describe(self) -> str:
        """Say where captures go; a sink whose `describe` raises is named by its class."""
        try:
            return str(self._sink.describe())
        except Exception:
            return f"a {type(self._sink).__name__}"

    # -- start and stop ---------------------------------------------------------------------------------------------
    def start(self) -> None:
        """Open the sink (refusing an unsafe destination), WARN that captures hold personal data, start the writer.

        Refused with `RuntimeError` while the last writer is still alive: this capture's, or the last one started for
        the same destination by any capture (a sink that ignored the last stop must finish before the sink is opened
        again, since opening it may replace what the old writer still writes through).
        """
        thread = self._thread
        if thread is not None and thread.is_alive():
            raise RuntimeError("the failed-run capture's last writer is still running; it cannot start again yet")
        key = _destination(self._sink)
        with _WRITERS_LOCK:
            other = _WRITERS.get(key)
            if other is not None and other.is_alive():
                raise RuntimeError(
                    "the failed-run capture's last writer for this destination is still running; it cannot start again"
                    " yet"
                )
        listing = self._sink.open()
        with self._lock:
            self._kept = dict(sorted(listing.kept.items()))
            self._pending = 0
        leftovers = (
            f" {listing.leftovers} leftover .partial-* or .evict-* entries from an earlier run are there: remove them"
            " by hand."
            if listing.leftovers
            else ""
        )
        self._warn(
            f"the failed-run capture is on ({scrub(self.describe())}): every captured run holds the submitted answers"
            " and the form definition (personal data) in clear text, readable by this process's user. Turn"
            " datum.runtime.diagnostics.capture.enabled off after debugging; on macOS keep access-control entries"
            f" off the directory.{leftovers}"
        )
        generation = _Generation()
        writer = threading.Thread(target=self._write_loop, args=(generation,), name=_WRITER_NAME, daemon=True)
        with self._lock:
            self._generation = generation
        self._thread = writer
        with _WRITERS_LOCK:
            _WRITERS[key] = writer
        writer.start()

    @property
    def writer_alive(self) -> bool:
        """Whether this capture's writer thread is still running (it may outlive a stop, see `stop`)."""
        thread = self._thread
        return thread is not None and thread.is_alive()

    def stop(self, grace: float) -> None:
        """Let the writer drain within `grace` seconds, then drop what is still queued (counted) and let it go.

        It never takes longer than `grace`: the writer drains for the grace less a reserve (half of it, at most one
        second), then the queue is dropped and the writer is waited for the reserve. A sink that ignores the stop may
        finish its current write after `stop` returns; the next `start` refuses until it is done. The sink is closed by
        the writer itself as it exits, so a writer that outlives the stop still writes through an open sink, and the
        sink is closed however short the grace was.
        """
        with self._lock:  # an offer reads the generation under the same lock: none lands after the end
            generation, self._generation = self._generation, None
        thread = self._thread
        if generation is None or thread is None:
            return
        reserve = min(1.0, max(0.0, grace) / 2)
        generation.items.put(_END)
        thread.join(max(0.0, grace - reserve))
        if thread.is_alive():
            generation.stopping.set()
            self._drop_queued(generation)
            thread.join(reserve)

    def _close_sink(self) -> None:
        close = getattr(self._sink, "close", None)
        if callable(close):
            try:
                close()
            except BaseException as error:  # a sink that fails to close is logged, never raised here
                if fatal(error):
                    raise
                logger.warning("the failed-run capture could not close its sink (%s)", type(error).__name__)

    def _drop_queued(self, generation: _Generation) -> None:
        dropped = 0
        with contextlib.suppress(queue.Empty):
            while True:
                item = generation.items.get_nowait()
                if isinstance(item, RunCapture):
                    dropped += 1
                    with self._lock:
                        self._pending -= item.size
        generation.items.put(_END)  # the drain above took the end too: the writer still finds it after its write
        if dropped:
            with self._lock:
                self._dropped += dropped
            self._drop_warning(lambda count: f"the failed-run capture dropped {count} queued capture(s) at stop")

    # -- offer ------------------------------------------------------------------------------------------------------
    def offer(self, capture: RunCapture) -> str:
        """Queue a capture for the writer and return its id, or `dropped`; never blocks, never raises."""
        try:
            return self._offer(capture)
        except Exception:
            with self._lock:
                self._dropped += 1
            return "dropped"

    def _offer(self, capture: RunCapture) -> str:
        size = capture.size
        reason: str | None = None
        total = 0
        with self._lock:
            generation = self._generation
            if generation is None:
                reason = "it is not running"
            elif size > self._max_bytes:
                reason = "it is larger than max_bytes"
            elif self._pending + size > self._queue_bytes:
                reason = "its queue is full (queue_bytes)"
            else:
                self._pending += size
                generation.items.put(capture)  # under the lock: a stop swaps the generation before its end is queued
            if reason is not None:
                self._dropped += 1
                total = self._dropped
        if reason is not None:
            why = reason
            self._drop_warning(
                lambda count: f"the failed-run capture dropped {count} capture(s): {why} ({total} dropped in all)"
            )
            return "dropped"
        return capture.id

    # -- the writer -------------------------------------------------------------------------------------------------
    def _write_loop(self, generation: _Generation) -> None:
        try:
            while True:
                item = generation.items.get()
                if item is _END or generation.stopping.is_set():
                    if isinstance(item, RunCapture):
                        with self._lock:
                            self._pending -= item.size
                            self._dropped += 1
                    return
                if not isinstance(item, RunCapture):  # pragma: no cover - only captures and the end are queued
                    continue
                try:
                    self._write_one(item)
                finally:
                    with self._lock:
                        self._pending -= item.size
        finally:
            self._close_sink()

    def _write_one(self, capture: RunCapture) -> None:
        try:
            held = self._sink.write(capture)
        except BaseException as error:  # counted and WARNed with the id and the class, never the message
            if fatal(error):
                raise
            self._count_failure("write", capture.id, error)
            return
        with self._lock:
            self._kept[capture.id] = held
            self._kept = dict(sorted(self._kept.items()))
            self._written += 1
        self._evict(just_written=capture.id)

    def _evict(self, *, just_written: str) -> None:
        """Remove the oldest captures (never the one just written) until both bounds hold.

        A capture already gone (deleted by hand) only leaves the count. One whose removal fails stays counted and is
        skipped for this round, and the next oldest is tried, so one stuck capture never stops the bounds holding.
        """
        skipped: set[str] = set()
        while True:
            with self._lock:
                over = len(self._kept) > self._max_runs or sum(self._kept.values()) > self._max_bytes
                victims = [name for name in self._kept if name != just_written and name not in skipped]
                if not over or not victims:
                    return
                victim = victims[0]
            try:
                self._sink.remove(victim)
            except PartlyRemovedError as error:
                with self._lock:
                    self._kept.pop(victim, None)
                self._count_failure("remove", victim, error)
            except FileNotFoundError:
                with self._lock:
                    self._kept.pop(victim, None)
            except BaseException as error:  # counted, the capture stays held; the next one is tried
                if fatal(error):
                    raise
                skipped.add(victim)
                self._count_failure("remove", victim, error)
            else:
                with self._lock:
                    self._kept.pop(victim, None)

    def _count_failure(self, what: str, capture_id: str, error: BaseException) -> None:
        with self._lock:
            self._failed += 1
            total = self._failed
        kind = type(error).__name__
        self._fail_warning(
            lambda count: (
                f"the failed-run capture could not {what} capture {capture_id} ({kind}); {count} failure(s)"
                f" since the last warning, {total} in all"
            )
        )
