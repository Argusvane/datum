"""`BoundedMap`: a thread-safe insertion-ordered map that drops its least recently used entry past a capacity.

Built on: `functools.lru_cache` caches a function's calls, not a map a caller fills and reads by key; `cachetools`
is not a dependency and a third-party cache would add one for twenty lines; `collections.OrderedDict` gives the order
and `threading.Lock` the safety. Used by the memory snapshot store and the definition service's public-copy cache.
"""

import threading
from collections import OrderedDict
from collections.abc import Hashable


class BoundedMap[K: Hashable, V]:
    """At most `capacity` entries; a read or write makes an entry the newest, a write past capacity drops the oldest."""

    def __init__(self, capacity: int) -> None:
        """Keep `capacity` (at least 1) entries."""
        if capacity < 1:
            raise ValueError("a bounded map keeps at least one entry")
        self.capacity = capacity
        self._entries: OrderedDict[K, V] = OrderedDict()
        self._lock = threading.Lock()

    def get(self, key: K) -> V | None:
        """Return the entry (and make it the newest), or None."""
        with self._lock:
            found = self._entries.get(key)
            if found is not None:
                self._entries.move_to_end(key)
            return found

    def put(self, key: K, value: V) -> None:
        """Store the entry as the newest and drop the oldest ones past capacity."""
        with self._lock:
            self._entries[key] = value
            self._entries.move_to_end(key)
            while len(self._entries) > self.capacity:
                self._entries.popitem(last=False)

    def touch(self, key: K) -> bool:
        """Make an existing entry the newest; say whether it exists."""
        with self._lock:
            if key not in self._entries:
                return False
            self._entries.move_to_end(key)
            return True

    def __len__(self) -> int:
        """Return the number of entries held."""
        with self._lock:
            return len(self._entries)
