"""The timestamp server's store seams and `SettingsTsaClientStore`.

The store-facing Protocols and the records they pass (`TsaSerialAllocator`, `TsaLog` + `TsaLogEntry`,
`TsaClientStore` + `TsaClientRecord`) live here, below `timestamp` in the layering, so the stores implement them
without importing the timestamp package; `datum_core.timestamp.protocols` re-exports them unchanged.

`SettingsTsaClientStore` keeps the clients `datum.tsa.clients` lists.

A client is a SHA-256 of its key (`dtsa_` + base64url of 32 bytes); the settings hold the hashes, never a key. The store
is not a memory store in that sense: what it knows is its configuration, which a restart reads again,
so it needs no acknowledgement. Each client has a store id derived from its hash by a second, domain-separated hash,
so the id is stable across restarts and reorderings of the list and is neither the key nor its hash: it is what the
issue log, the events and the flood counters carry.

Built on: the standard library has `hashlib` (the id) and `threading.Lock` (the use counters), and the settings
type `Sha256` already normalises a hash to 64 lower-case hex characters; nothing else keeps clients, so this is one
dict.
A revocation in the settings is removing the hash; `revoked` exists for a store that keeps revoked rows (the SQL one)
and for the shared contract.
"""

import hashlib
import re
import threading
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Final, Protocol, Self

__all__ = [
    "SettingsTsaClientStore",
    "TsaClientRecord",
    "TsaClientStore",
    "TsaLog",
    "TsaLogEntry",
    "TsaSerialAllocator",
]

_HASH: Final = re.compile(r"[0-9a-fA-F]{64}")
_ID_DOMAIN: Final = b"datum-tsa-client\x00"
_ID_LENGTH: Final = 16


# -- the store seams (re-exported by `datum_core.timestamp.protocols`) --


class TsaSerialAllocator(Protocol):
    """Hands out serial numbers: allocated before signing, never reused, strictly increasing within one process."""

    def allocate(self) -> int:
        """Return the next serial (positive, at most 160 bits); a failure raises and ends in a 503."""
        ...


@dataclass(frozen=True, slots=True)
class TsaLogEntry:
    """One issued token: scalars only, no request bytes beyond the imprint (hex) and no key or key hash."""

    serial: int
    gen_time: datetime
    imprint_algorithm: str
    imprint: str
    client: str | None = None


class TsaLog(Protocol):
    """A bounded record of issued tokens."""

    def append(self, entry: TsaLogEntry) -> None:
        """Keep `entry`; the log drops its oldest rows past its bound."""
        ...

    def recent(self, limit: int) -> tuple[TsaLogEntry, ...]:
        """Return up to `limit` entries, newest first."""
        ...


@dataclass(frozen=True, slots=True)
class TsaClientRecord:
    """A client of the endpoint as the store knows it: the store's own id (never the key or its hash)."""

    id: str
    revoked: bool = False


class TsaClientStore(Protocol):
    """Clients by the SHA-256 of their key (`dtsa_` + base64url of 32 bytes)."""

    def find(self, key_hash: str) -> TsaClientRecord | None:
        """Return the client the hash names, or None; a revoked client is returned with `revoked` set."""
        ...

    def record_use(self, client_id: str, at: datetime) -> None:
        """Note one use of the client (`last_used`, `uses`)."""
        ...


# -- the settings client store --


class _ClientSettings(Protocol):
    """What the store reads of `datum.tsa` (a structural type: `stores` sits below `config` in the layering)."""

    @property
    def clients(self) -> Sequence[str]:
        """The SHA-256 of each client key."""
        ...


def _client_id(key_hash: str) -> str:
    """Return the store id of the client whose key hashes to `key_hash` (lower-case hex)."""
    return "c-" + hashlib.sha256(_ID_DOMAIN + bytes.fromhex(key_hash)).hexdigest()[:_ID_LENGTH]


class SettingsTsaClientStore:
    """Clients by the SHA-256 of their key, from a list of hashes; answers `TsaClientRecord`, notes uses in memory."""

    def __init__(self, hashes: Iterable[str], *, revoked: Iterable[str] = ()) -> None:
        """Know exactly the clients whose key hashes are `hashes`; those also in `revoked` are revoked.

        A hash that is not 64 hexadecimal characters is a `ValueError` (the message never quotes it).
        """
        self._records: dict[str, TsaClientRecord] = {}
        gone = {self._normal(item) for item in revoked}
        for item in hashes:
            key_hash = self._normal(item)
            self._records[key_hash] = TsaClientRecord(_client_id(key_hash), key_hash in gone)
        self._ids = {record.id for record in self._records.values()}
        self._uses: dict[str, tuple[int, datetime]] = {}
        self._lock = threading.Lock()

    @classmethod
    def from_settings(cls, tsa: _ClientSettings) -> Self:
        """Build the store from `datum.tsa.clients`."""
        return cls(tsa.clients)

    @staticmethod
    def _normal(key_hash: str) -> str:
        if not _HASH.fullmatch(key_hash):
            raise ValueError("a client key hash is 64 hexadecimal characters (a SHA-256)")
        return key_hash.lower()

    def find(self, key_hash: str) -> TsaClientRecord | None:
        """Return the client the hash names (revoked ones included, marked), or None; a malformed hash finds nobody."""
        if not _HASH.fullmatch(key_hash):
            return None
        return self._records.get(key_hash.lower())

    def record_use(self, client_id: str, at: datetime) -> None:
        """Note one use of the client (a count and the latest instant); an id the store does not know is ignored."""
        if client_id not in self._ids:
            return
        with self._lock:
            uses, latest = self._uses.get(client_id, (0, at))
            self._uses[client_id] = (uses + 1, max(latest, at))

    def usage(self, client_id: str) -> tuple[int, datetime | None]:
        """Return how many uses were noted for the client and the latest instant (0 and None: none)."""
        with self._lock:
            found = self._uses.get(client_id)
        return (0, None) if found is None else found

    def details(self) -> dict[str, object]:
        """Health details: the kind and how many clients the store knows."""
        return {"store": "settings", "clients": len(self._records)}
