"""`BoundedMemoryStorage`: the in-memory counter store of `limits`' public storage interface, with a cap on its keys.

Built on: `limits.storage.MemoryStorage` is the standard in-memory store, and ships no size cap: an attacker who
varies the key grows it until the process is out of memory, and its internals (Counter, per-key locks, a timer thread)
are private, so wrapping or trimming them would rest on what a minor release may change. This class implements the six
public abstract methods of `limits.storage.Storage` over one dict, one lock and a heap (`heapq`), and nothing else of
`limits`. The fixed-window strategy needs only those six.

Policy at the cap: a new key first drops every expired window. When none has expired, a sixteenth of the live windows
(at least one) goes, one at a time from the caller holding the most windows: that caller gives up its window of the
fewest attempts first, the newest among equals. The caller is the key's address and principal, every part but the
form: `storage_key` ends each key with the caller's digest, which `caller_of` reads, and a key of another shape is a
caller of its own. So one address that opens windows by naming many forms (an unknown form id still opens one) pays
for the room it takes: its windows of one attempt go before its full window, and another caller's window is not
touched while it holds more. That still fails OPEN: an attacker with as many addresses as windows can restart other
callers' counters, and no caller is ever locked out. An eviction of a live window is counted, and warned once per
window on `datum.submissions`; the warning names the setting, never a key.
"""

import heapq
import logging
import re
import threading
import time
from dataclasses import dataclass
from typing import Final

from limits.storage import Storage

from datum_core.loggers import SUBMISSIONS

__all__ = ["BoundedMemoryStorage", "caller_of"]

_LOG = logging.getLogger(SUBMISSIONS)
_CALLER: Final = re.compile(r"datum:throttle:[a-z]+:[0-9a-f]{64}:(?P<caller>[0-9a-f]{64})(?![0-9a-f])")
"""The caller's digest at the end of a `storage_key`, inside whatever framing `limits` adds around it."""
_SHARE: Final = 16
"""At the cap with nothing expired, one window in this many (at least one) is evicted."""


def caller_of(key: str) -> str:
    """Return who `key` counts for: the caller's digest `storage_key` ends it with, else the whole key."""
    found = _CALLER.search(key)
    return key if found is None else found.group("caller")


@dataclass(slots=True)
class _Window:
    count: int
    expires: float
    serial: int
    caller: str


class BoundedMemoryStorage(Storage):
    """Counters by key with a window each, at most `max_keys` of them, safe under threads."""

    def __init__(self, max_keys: int = 10_000) -> None:
        """Hold at most `max_keys` (at least 1) counters."""
        if max_keys < 1:
            raise ValueError("a throttle storage keeps at least one key")
        super().__init__()
        self.max_keys = max_keys
        self.evictions = 0
        self._windows: dict[str, _Window] = {}
        self._order: list[tuple[float, int, str]] = []  # (expires, serial, key); stale when the key's window differs
        self._serial = 0
        self._lock = threading.Lock()
        self._warn_after = 0.0

    @property
    def base_exceptions(self) -> type[Exception] | tuple[type[Exception], ...]:
        """Nothing in memory raises a storage error."""
        return ValueError

    def __len__(self) -> int:
        """Return the number of keys held (expired ones count until they are touched or evicted)."""
        with self._lock:
            return len(self._windows)

    def incr(self, key: str, expiry: int, amount: int = 1) -> int:
        """Add to the key's counter, starting a window of `expiry` seconds when it has none; return the count."""
        now = time.time()
        warn = False
        with self._lock:
            window = self._windows.get(key)
            if window is not None and window.expires > now:
                window.count += amount
                return window.count
            if window is None and len(self._windows) >= self.max_keys:
                warn = self._make_room(now, now + expiry)
            self._serial += 1
            caller = caller_of(key) if window is None else window.caller
            self._windows[key] = _Window(amount, now + expiry, self._serial, caller)
            heapq.heappush(self._order, (now + expiry, self._serial, key))
            if len(self._order) > 4 * self.max_keys + 16:
                self._order = [(w.expires, w.serial, k) for k, w in self._windows.items()]
                heapq.heapify(self._order)
        if warn:
            _LOG.warning(
                "datum.web.throttle.max_keys (%d) is reached: new keys evict live windows, those of the caller holding "
                "the most first, so their counters restart (the throttle fails open); raise max_keys or use a shared "
                "storage",
                self.max_keys,
            )
        return amount

    def _make_room(self, now: float, window_end: float) -> bool:
        """Drop the expired windows, else a sixteenth of the live ones; say whether to warn. The lock is held."""
        self._drop_expired(now)
        if len(self._windows) < self.max_keys:
            return False
        # Each caller's windows, the cheapest last (the fewest attempts, then the newest), so `pop()` takes it.
        by_caller: dict[str, list[tuple[int, int, str]]] = {}
        for key, window in self._windows.items():
            by_caller.setdefault(window.caller, []).append((window.count, -window.serial, key))
        # The caller holding the most first; among callers holding as many, the one whose cheapest window is cheapest.
        heaviest: list[tuple[int, int, int, list[tuple[int, int, str]]]] = []
        for held in by_caller.values():
            held.sort(reverse=True)
            count, newest, _ = held[-1]
            heaviest.append((-len(held), count, newest, held))
        heapq.heapify(heaviest)
        for _ in range(max(1, self.max_keys // _SHARE)):
            if not heaviest:
                break
            _, _, _, held = heapq.heappop(heaviest)
            _, _, victim = held.pop()
            del self._windows[victim]
            self.evictions += 1
            if held:
                count, newest, _ = held[-1]
                heapq.heappush(heaviest, (-len(held), count, newest, held))
        if now >= self._warn_after:
            self._warn_after = window_end
            return True
        return False

    def _drop_expired(self, now: float) -> None:
        """Forget every window that has ended, soonest first off the heap. The lock is held."""
        while self._order and self._order[0][0] <= now:
            _, serial, key = heapq.heappop(self._order)
            held = self._windows.get(key)
            if held is not None and held.serial == serial:
                del self._windows[key]

    def get(self, key: str) -> int:
        """Return the key's count in its live window, else 0."""
        with self._lock:
            window = self._windows.get(key)
            if window is None:
                return 0
            if window.expires <= time.time():
                del self._windows[key]
                return 0
            return window.count

    def get_expiry(self, key: str) -> float:
        """Return when the key's window ends (epoch seconds), or now for a key with none."""
        with self._lock:
            window = self._windows.get(key)
        return time.time() if window is None else window.expires

    def check(self) -> bool:
        """Memory is always healthy."""
        return True

    def reset(self) -> int | None:
        """Forget every key; return how many were held."""
        with self._lock:
            held = len(self._windows)
            self._windows.clear()
            self._order.clear()
        return held

    def clear(self, key: str) -> None:
        """Forget one key."""
        with self._lock:
            self._windows.pop(key, None)

    def details(self) -> dict[str, object]:
        """Health details: the kind, the keys held, the cap, the evictions, and that the counters are per process."""
        with self._lock:
            return {
                "store": "memory",
                "keys": len(self._windows),
                "maxKeys": self.max_keys,
                "evictions": self.evictions,
                "perProcess": True,
            }
