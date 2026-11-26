"""The bounded output sink a guest's stdout and stderr callbacks write into."""

import threading


class OutputSink:
    """Keep the first `cap` bytes written, drop the rest, and say so.

    `write` returns the full length it was given and never raises, so a guest producing more than the cap sees a healthy
    pipe and is ended by its budget, not by a failing write. The lock is held only for the copy; it is never held
    across a call into an engine, because an engine may run the callback on a foreign thread while the worker is parked.
    """

    __slots__ = ("_buffer", "_cap", "_capped", "_lock")

    def __init__(self, cap: int) -> None:
        """Create a sink that keeps at most `cap` bytes."""
        if cap < 0:
            raise ValueError("a sink cap must not be negative")
        self._cap = cap
        self._buffer = bytearray()
        self._capped = False
        self._lock = threading.Lock()

    def write(self, data: bytes | bytearray | memoryview) -> int:
        """Store what fits under the cap, flag the rest as dropped, and return `len(data)`."""
        size = len(data)
        with self._lock:
            room = self._cap - len(self._buffer)
            if size <= room:
                self._buffer += data
            else:
                if room > 0:
                    self._buffer += bytes(data[:room])
                self._capped = True
        return size

    @property
    def capped(self) -> bool:
        """Whether any byte was dropped."""
        with self._lock:
            return self._capped

    @property
    def cap(self) -> int:
        """The most this sink keeps."""
        return self._cap

    def value(self) -> bytes:
        """Return a copy of what was kept."""
        with self._lock:
            return bytes(self._buffer)
