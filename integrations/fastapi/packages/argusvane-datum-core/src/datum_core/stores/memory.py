"""The in-memory forms stores: a bounded form repository, snapshot store and translation catalog store.

Both are per-process: a second worker or a restart does not see what this one holds, so each states the `datum.W004`
warning (`check()`) and its health details (`details()`), which `datum_core.Datum` places under `stores.forms`,
`stores.snapshots` and `stores.translations`. Built on: `OrderedDict` and a lock (see
`datum_core.stores.bounded`) and the canonical writer of this package; nothing in the standard library or
pydantic is a keyed store with a bound.
The form repository's compare-and-set is one lock over a dict: one lock makes each create and compare-and-set whole; the
definition is copied and hashed outside it. No library holds a bounded compare-and-set map.
"""

import copy
import heapq
import math
import threading
from collections import deque
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, cast

from datum_core.canonical import canonical_digest
from datum_core.checks import W004
from datum_core.stores import Catalog, CatalogView, StoredCatalog, StoredDefinition, StoreFullError, catalog_etag
from datum_core.stores.bounded import BoundedMap
from datum_core.stores.keys import is_form_key
from datum_sandbox.checks import CheckLevel, DatumCheck
from datum_sandbox.json import JsonValue

if TYPE_CHECKING:
    from datum_core.stores.tsa import TsaLogEntry

__all__ = [
    "FloodCount",
    "InMemoryTsaFlood",
    "MemoryDefinitionSnapshotStore",
    "MemoryFormDefinitionRepository",
    "MemorySubmissionIdempotencyStore",
    "MemoryTranslationCatalogStore",
    "MemoryTsaLog",
    "MemoryTsaSerialAllocator",
    "StoreFullError",
]

_SQL_HINT = "give Datum a SQL engine (datum.sql) or your own store, or run one worker"


def _require_plain_key(key: str) -> None:
    """Refuse a key outside the form-key grammar (no `@`, one to 128 characters) before any lock is taken."""
    if not is_form_key(key) or "@" in key:
        raise ValueError("a form key is one to 128 letters, digits, dots, hyphens or underscores")


def memory_store_check(store: str, what: str) -> DatumCheck:
    """`datum.W004` for one in-memory store: `store` is its health name, `what` the sentence about what it holds."""
    return DatumCheck(
        CheckLevel.WARNING,
        W004,
        f"{store} keeps {what} in this process's memory; a second worker or a restart does not see it",
        _SQL_HINT,
    )


class MemoryFormDefinitionRepository:
    """Form definitions by id, writable: `create` and compare-and-set `replace`; a full store refuses a new form.

    The bound counts forms, not versions, and nothing is ever evicted: a form definition is authoritative data.
    A definition is copied in and out, so no caller changes stored state. One lock makes each create and
    compare-and-set whole; the definition is copied and hashed outside it.
    """

    health_name = "stores.forms"

    def __init__(self, seed: Iterable[Mapping[str, JsonValue]] = (), *, max_entries: int = 1000) -> None:
        """Hold at most `max_entries` forms (at least 1), starting with `seed`, each keyed by its `id`."""
        if max_entries < 1:
            raise ValueError("a form repository holds at least one form")
        self.max_entries = max_entries
        self._forms: dict[str, StoredDefinition] = {}
        self._table = threading.Lock()
        for definition in seed:
            form_id = definition.get("id")
            if not isinstance(form_id, str) or not is_form_key(form_id) or "@" in form_id:
                raise ValueError("a seeded definition needs a string id that is a form key (letters, digits, . - _)")
            if form_id in self._forms:
                raise ValueError(f'the seed repeats the id "{form_id}"')
            if len(self._forms) >= max_entries:
                raise ValueError(f"the seed holds more than max_entries forms ({max_entries})")
            copied = copy.deepcopy(dict(definition))
            self._forms[form_id] = StoredDefinition(form_id, copied, canonical_digest(copied))

    @staticmethod
    def _out(stored: StoredDefinition) -> StoredDefinition:
        return StoredDefinition(stored.key, copy.deepcopy(stored.definition), stored.sha256)

    def current(self, key: str) -> StoredDefinition | None:
        """Return a copy of the form's current version, or None."""
        with self._table:
            found = self._forms.get(key)
        return None if found is None else self._out(found)

    def create(self, key: str, definition: Mapping[str, JsonValue]) -> StoredDefinition | None:
        """Store a new form and return it; None when the key is taken; `StoreFullError` when the store is full."""
        _require_plain_key(key)
        copied = copy.deepcopy(dict(definition))
        stored = StoredDefinition(key, copied, canonical_digest(copied))
        with self._table:
            if key in self._forms:
                return None
            if len(self._forms) >= self.max_entries:
                raise StoreFullError(f"the in-memory form repository holds {self.max_entries} forms")
            self._forms[key] = stored
        return self._out(stored)

    def replace(
        self, key: str, definition: Mapping[str, JsonValue], expected_sha256: str | None
    ) -> StoredDefinition | None:
        """Swap an existing form's definition when its stored hash is `expected_sha256` (None: any); else None."""
        _require_plain_key(key)
        copied = copy.deepcopy(dict(definition))
        stored = StoredDefinition(key, copied, canonical_digest(copied))
        with self._table:
            held = self._forms.get(key)
            if held is None or (expected_sha256 is not None and held.sha256 != expected_sha256):
                return None
            self._forms[key] = stored
        return self._out(stored)

    def check(self) -> DatumCheck:
        """Return the `datum.W004` warning for this store."""
        return memory_store_check(self.health_name, "form definitions")

    def details(self) -> dict[str, object]:
        """Health details: the kind, the forms held and the bound."""
        with self._table:
            held = len(self._forms)
        return {"store": "memory", "entries": held, "maxEntries": self.max_entries}


class MemoryDefinitionSnapshotStore:
    """Definitions by form key and canonical hash, so a version can be asked for by hash; the oldest are dropped."""

    health_name = "stores.snapshots"

    def __init__(self, max_entries: int = 500) -> None:
        """Keep at most `max_entries` (`datum.forms.snapshots.max_entries`, at least 1) snapshots."""
        self._entries: BoundedMap[tuple[str, str], dict[str, JsonValue]] = BoundedMap(max_entries)

    @property
    def max_entries(self) -> int:
        """The bound."""
        return self._entries.capacity

    def record(self, key: str, sha256: str, definition: Mapping[str, JsonValue]) -> None:
        """Remember a definition; recording one that is held makes it the newest, and holds one entry."""
        if not self._entries.touch((key, sha256)):
            self._entries.put((key, sha256), copy.deepcopy(dict(definition)))

    def find(self, key: str, sha256: str) -> dict[str, JsonValue] | None:
        """Return a copy of the definition recorded under the key and hash, or None."""
        found = self._entries.get((key, sha256))
        return None if found is None else copy.deepcopy(found)

    def check(self) -> DatumCheck:
        """Return the `datum.W004` warning for this store."""
        return memory_store_check(self.health_name, "definition snapshots")

    def details(self) -> dict[str, object]:
        """Health details: the kind, the entries held and the bound."""
        return {"store": "memory", "entries": len(self._entries), "maxEntries": self.max_entries}


class MemoryTranslationCatalogStore:
    """Translation catalogs by form key. A catalog is authoritative data, so a full store refuses a new form."""

    health_name = "stores.translations"

    def __init__(self, max_entries: int = 1000) -> None:
        """Hold catalogs for at most `max_entries` forms (at least 1)."""
        if max_entries < 1:
            raise ValueError("a translation store holds at least one catalog")
        self.max_entries = max_entries
        self._catalogs: dict[str, StoredCatalog] = {}
        self._lock = threading.Lock()

    def read(self, key: str) -> StoredCatalog | None:
        """Return a copy of the form's catalog and its ETag, or None."""
        with self._lock:
            found = self._catalogs.get(key)
        return None if found is None else StoredCatalog(copy.deepcopy(found.catalog), found.etag)

    def put(self, key: str, catalog: CatalogView) -> StoredCatalog:
        """Replace the form's catalog; its ETag is the quoted sha256 of the canonical catalog.

        This is the seeding write: it skips the key-grammar check, and the builder service never calls it (it uses
        `write`, against the ETag it read).
        """
        copied = cast("Catalog", copy.deepcopy(catalog))
        stored = StoredCatalog(copied, catalog_etag(copied))
        with self._lock:
            if key not in self._catalogs and len(self._catalogs) >= self.max_entries:
                raise StoreFullError(f"the in-memory translation store holds {self.max_entries} forms")
            self._catalogs[key] = stored
        return StoredCatalog(copy.deepcopy(copied), stored.etag)

    def write(self, key: str, catalog: CatalogView, *, expected_etag: str) -> StoredCatalog | None:
        """Store the catalog when the form's stored ETag is `expected_etag` (that of `{}` when it has none); else None.

        Raises `StoreFullError` for a new form when the store holds `max_entries` forms.
        """
        _require_plain_key(key)
        copied = cast("Catalog", copy.deepcopy(catalog))
        stored = StoredCatalog(copied, catalog_etag(copied))
        with self._lock:
            held = self._catalogs.get(key)
            if (catalog_etag({}) if held is None else held.etag) != expected_etag:
                return None
            if held is None and len(self._catalogs) >= self.max_entries:
                raise StoreFullError(f"the in-memory translation store holds {self.max_entries} forms")
            self._catalogs[key] = stored
        return StoredCatalog(copy.deepcopy(copied), stored.etag)

    def check(self) -> DatumCheck:
        """Return the `datum.W004` warning for this store."""
        return memory_store_check(self.health_name, "translation catalogs")

    def details(self) -> dict[str, object]:
        """Health details: the kind, the forms held and the bound."""
        with self._lock:
            held = len(self._catalogs)
        return {"store": "memory", "entries": held, "maxEntries": self.max_entries}


class MemorySubmissionIdempotencyStore[R]:
    """Receipts by (form key, version, submission key), at most `memory_size`; the least recently used are dropped.

    Built on: `BoundedMap` (above) gives the bound and the order, and `threading.Lock` makes the insert whole.
    Eviction can only lose a retry's receipt (the delivery runs again); the key is the whole triple, so an evicted
    key never lets another form's or attempt's receipt answer. A receipt is copied in and out: a caller holds a value.
    """

    health_name = "stores.idempotency"

    def __init__(self, memory_size: int = 10_000) -> None:
        """Keep at most `memory_size` (`datum.submissions.idempotency.memory_size`, at least 1) receipts."""
        self._receipts: BoundedMap[tuple[str, str, str], R] = BoundedMap(memory_size)
        self._insert = threading.Lock()  # held for the insert only, never across a handler

    @property
    def memory_size(self) -> int:
        """The bound."""
        return self._receipts.capacity

    def find(self, form_key: str, version: str, submission_key: str) -> R | None:
        """Return a copy of the receipt recorded for the key, or None."""
        found = self._receipts.get((form_key, version, submission_key))
        return None if found is None else copy.deepcopy(found)

    def record(self, form_key: str, version: str, submission_key: str, remembered: R) -> R:
        """Record `remembered` unless the key has one; return a copy of what stands (the first writer's)."""
        key = (form_key, version, submission_key)
        with self._insert:
            standing = self._receipts.get(key)
            if standing is None:
                standing = copy.deepcopy(remembered)
                self._receipts.put(key, standing)
        return copy.deepcopy(standing)

    def check(self) -> DatumCheck:
        """Return the `datum.W004` warning for this store."""
        return memory_store_check(self.health_name, "submission receipts")

    def details(self) -> dict[str, object]:
        """Health details: the kind, the receipts held and the bound."""
        return {"store": "memory", "entries": len(self._receipts), "maxEntries": self.memory_size}


# -- the timestamp server's stores ------------------------------------------------------------
_MILLISECOND_BITS = 32
"""Room for 2**32 serials inside one millisecond; RFC 3161 section 2.4.2 worries about 1000."""
_EPOCH = datetime(1970, 1, 1, tzinfo=UTC)
_MILLISECOND = timedelta(milliseconds=1)


class MemoryTsaSerialAllocator:
    """Serials for timestamp tokens, kept in this process: seeded from the clock, strictly increasing, never reused.

    A serial is the clock's milliseconds since the epoch shifted left by 32 bits, or one more than the last serial
    handed out, whichever is larger. So a restart (a later clock) starts above everything the process before it gave,
    a clock set back inside the process never repeats or lowers a serial, and more than a thousand tokens in one
    millisecond are told apart. What memory cannot promise is the case across processes: a second instance, or a
    restart after the clock was set back, could repeat a serial. That is why the start refuses this store unless
    `datum.tsa.allow_memory_stores` acknowledges it (`datum.E001`). The result fits 160 bits until the
    year 2^64 milliseconds from now. The milliseconds are counted in integer arithmetic (`timedelta` floor division),
    never through a float `timestamp()`, which rounds a late instant into the next millisecond.

    Built on: the standard library has `itertools.count` (not seeded from a clock, not monotone against one) and
    `threading.Lock`; nothing allocates serials, so this is one integer under one lock.
    """

    health_name = "tsa.serials"

    def __init__(self, now: Callable[[], datetime] | None = None) -> None:
        """Read the clock through `now` (default: the real one, UTC)."""
        self._now = now or (lambda: datetime.now(UTC))
        self._last = 0
        self._lock = threading.Lock()

    def allocate(self) -> int:
        """Return the next serial: positive, at most 160 bits, greater than every serial given before."""
        instant = self._now()
        if instant.tzinfo is None or instant.utcoffset() is None:
            raise ValueError("a serial allocator's clock answers timezone-aware instants")
        seed = ((instant - _EPOCH) // _MILLISECOND) << _MILLISECOND_BITS
        with self._lock:
            self._last = max(self._last + 1, seed)
            return self._last

    def details(self) -> dict[str, object]:
        """Health details: the kind."""
        return {"store": "memory"}


class MemoryTsaLog:
    """The last `max_entries` issued tokens (scalars only), newest first; older rows are dropped.

    Built on: `collections.deque(maxlen=...)` is the standard bounded sequence; one lock makes `recent` read a
    whole list while another thread appends. The entries are frozen records, shared without copying.
    """

    health_name = "tsa.log"

    def __init__(self, max_entries: int = 1000) -> None:
        """Keep at most `max_entries` (at least 1) rows."""
        if max_entries < 1:
            raise ValueError("a timestamp log keeps at least one row (max_entries)")
        self.max_entries = max_entries
        self._rows: deque[TsaLogEntry] = deque(maxlen=max_entries)
        self._lock = threading.Lock()

    def append(self, entry: "TsaLogEntry") -> None:
        """Keep `entry` as the newest row; the oldest row goes when the log is full."""
        with self._lock:
            self._rows.append(entry)

    def recent(self, limit: int) -> tuple["TsaLogEntry", ...]:
        """Return up to `limit` rows, newest first."""
        if limit < 1:
            return ()
        with self._lock:
            newest = tuple(reversed(self._rows))
        return newest[:limit]

    def details(self) -> dict[str, object]:
        """Health details: the kind, the rows held and the bound."""
        with self._lock:
            held = len(self._rows)
        return {"store": "memory", "entries": held, "maxEntries": self.max_entries}


@dataclass(frozen=True, slots=True)
class FloodCount:
    """A key's hits in its window and the whole seconds until the window ends (at least 1; 0: it has no window)."""

    count: int
    retry_after: int


@dataclass(slots=True)
class _Window:
    count: int
    expires: float
    serial: int


class InMemoryTsaFlood:
    """Fixed-window counters by key for the timestamp endpoint's flood rule, at most `max_keys` of them (50,000).

    The window starts at the key's first hit and ends `window` seconds later; the next hit after that starts a new one.
    `now` is the caller's clock in seconds (any steady clock; a test drives it). At the cap a new key evicts the entry
    that expires soonest (an expired one first); that fails OPEN: a flooder with many keys can restart other callers'
    counters and can never lock one out, and a full table never denies the newcomer. A live entry that is evicted is
    counted in `evictions`. Counters are per process, which the `tsa` health detail says.

    The caller keys a counter by the client's store id (`TsaClientRecord.id`) or, for a caller with no known client (an
    open endpoint, a wrong key), by its address: never by a key the caller presented, so fresh keys mint no fresh
    counters and no key text is held here.

    Every hit that starts a window pushes onto the heap and stale rows (a key whose window was renewed or evicted) stay
    until popped, so the heap is rebuilt from the live windows once it holds more than `4 * max_keys + 16` rows; a row
    is stale when its serial is not its key's current window's serial, which is how eviction skips it.

    Built on: `limits` (a dependency of the throttle) counts through its own clock and exposes no `retry_after`
    for an explicit instant; `datum_core.throttle.storage.BoundedMemoryStorage` implements that library's interface over
    `time.time()`. Neither takes the caller's clock, which the gate and its tests need; `BoundedMap` is
    least-recently-used, not soonest-expiring. So this is one dict, one lock and a heap with lazy deletion.
    """

    health_name = "tsa.flood"

    def __init__(self, max_keys: int = 50_000) -> None:
        """Hold at most `max_keys` (at least 1) counters."""
        if max_keys < 1:
            raise ValueError("a flood table keeps at least one key (max_keys)")
        self.max_keys = max_keys
        self.evictions = 0
        self._windows: dict[str, _Window] = {}
        self._order: list[tuple[float, int, str]] = []  # (expires, serial, key); stale when the key's window differs
        self._serial = 0
        self._lock = threading.Lock()

    @property
    def size(self) -> int:
        """The number of keys held (expired ones count until they are touched or evicted)."""
        with self._lock:
            return len(self._windows)

    def hit(self, key: str, *, window: float, now: float) -> FloodCount:
        """Count one hit of `key` and return its count in the window and the seconds until the window ends."""
        with self._lock:
            held = self._windows.get(key)
            if held is not None and held.expires > now:
                held.count += 1
                return FloodCount(held.count, _remaining(held.expires, now))
            if held is None and len(self._windows) >= self.max_keys:
                self._evict_one(now)
            self._serial += 1
            expires = now + window
            self._windows[key] = _Window(1, expires, self._serial)
            heapq.heappush(self._order, (expires, self._serial, key))
            if len(self._order) > 4 * self.max_keys + 16:
                self._order = [(w.expires, w.serial, k) for k, w in self._windows.items()]
                heapq.heapify(self._order)
            return FloodCount(1, _remaining(expires, now))

    def peek(self, key: str, *, window: float, now: float) -> FloodCount:  # noqa: ARG002 - the window is the entry's own
        """Return `key`'s count without counting; a key with no live window is 0 with `retry_after` 0.

        The window is looked up under the lock and its fields are read after it is released: a hit on another thread
        may move the count by one in between, which a read that does not count can afford (the gate counts with `hit`).
        """
        with self._lock:
            held = self._windows.get(key)
        if held is None or held.expires <= now:
            return FloodCount(0, 0)
        return FloodCount(held.count, _remaining(held.expires, now))

    def _evict_one(self, now: float) -> None:
        """Drop the entry that expires soonest and count it when it was still live. The lock is held."""
        while self._order:
            expires, serial, victim = heapq.heappop(self._order)
            held = self._windows.get(victim)
            if held is None or held.serial != serial:
                continue
            del self._windows[victim]
            if expires > now:
                self.evictions += 1
            return

    def details(self) -> dict[str, object]:
        """Health details: the kind (per process), the keys held, the cap and the live entries evicted."""
        with self._lock:
            held = len(self._windows)
        return {
            "store": "memory (per process)",
            "keys": held,
            "maxKeys": self.max_keys,
            "evictions": self.evictions,
        }


def _remaining(expires: float, now: float) -> int:
    """Whole seconds left in a window, rounded up, at least 1."""
    return max(1, math.ceil(expires - now))
