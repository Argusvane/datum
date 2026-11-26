"""`LimitsThrottle`: the fixed-window throttle over `limits`, and `AsyncLimitsThrottle`, its `limits.aio` face.

Built on: `limits` (its `FixedWindowRateLimiter`, `RateLimitItemPerSecond`, `storage_from_string`) does the
counting; this module only turns a request's components into a storage key, a kind into a limit and a reset time into
`Retry-After`. `hmac` (SHA-256, keyed by a salt), `secrets` (the per-process salt) and `json` make the key: a plain hash
of an address is reversible by enumeration, so a storage dump alone names no caller. A storage failure fails OPEN (the
request is allowed, the failure logged once per window and shown as `degraded` in `details()`): a counter outage
must not take the form down. A memory URI is always Datum's own capped storage (`limits` ships no cap); any other URI
goes to `limits` unchanged (apart from the `async+` prefix the sync face drops).

Each face also keeps the address limit (`check_address`): every request of a throttled route counted under its client
address alone, before the route reads the body, so a flood of bodies that never parse is counted too (the per-form key
needs the form, which only the parsed body names). It shares the window, the storage, the salt and the key cap, under
the key word `address`, which no `ThrottleKind` is, so it never shares a window with a per-form key.
"""

import hashlib
import hmac
import json
import logging
import math
import secrets
import threading
import time
from contextlib import suppress
from typing import Final
from urllib.parse import urlsplit

from limits import RateLimitItem, RateLimitItemPerSecond
from limits.aio.storage import MemoryStorage as AsyncMemoryStorage
from limits.aio.storage import Storage as AsyncStorage
from limits.aio.strategies import FixedWindowRateLimiter as AsyncFixedWindowRateLimiter
from limits.errors import ConfigurationError
from limits.storage import MemoryStorage, Storage, storage_from_string
from limits.strategies import FixedWindowRateLimiter

from datum_core.checks import E005, W004, throttle_storage_unusable
from datum_core.config.models import Throttle, ThrottleBy, ThrottleKind
from datum_core.loggers import SUBMISSIONS
from datum_core.throttle.address import counted_address
from datum_core.throttle.model import Allow, Deny, ThrottleKey
from datum_core.throttle.storage import BoundedMemoryStorage
from datum_sandbox.checks import CheckLevel, DatumCheck

__all__ = [
    "ADDRESS_KEY_SPACE",
    "HEALTH_NAME",
    "KEY_SALT_CHECK_ID",
    "AsyncLimitsThrottle",
    "LimitsThrottle",
    "LimitsThrottleBase",
    "address_key",
    "address_storage_key",
    "key_components",
    "storage_key",
]

HEALTH_NAME = "stores.throttle"
KEY_SALT_CHECK_ID: Final = E005
"""The start check that refuses a shared storage with no `datum.web.throttle.key_salt` (`datum.E005`)."""
_LOG = logging.getLogger(SUBMISSIONS)
_ASYNC_PREFIX = "async+"
_MEMORY_SCHEMES = frozenset({"memory"})
_PARTS = ((ThrottleBy.IP, "ip"), (ThrottleBy.FORM, "form_key"), (ThrottleBy.PRINCIPAL, "principal"))
_CALLER_TAG: Final = b"caller\x00"
"""Prefixed to the caller's components, so its digest is never the key's (`by` without `form` has the same parts)."""
ADDRESS_KEY_SPACE: Final = "address"
"""The key word of the address limit's windows: internal, never a `ThrottleKind`, so `limits` cannot name it."""


def key_components(by: tuple[ThrottleBy, ...], key: ThrottleKey) -> dict[str, str | None]:
    """Return what a request is counted under: the chosen fields of `key` by name, and nothing else."""
    return {part.value: getattr(key, attribute) for part, attribute in _PARTS if part in by}


def storage_key(by: tuple[ThrottleBy, ...], key: ThrottleKey, salt: bytes = b"") -> str:
    """Return the identifier given to any storage: `datum:throttle:<kind>:<key>:<caller>`.

    `<key>` is the salted SHA-256 of the chosen components; `<caller>` is the salted SHA-256 of the same components
    but the form (the address and the principal), so every window of one caller shares it whatever form it names.
    The capped memory storage reads `<caller>` to choose what to evict (`BoundedMemoryStorage`); neither part names
    a raw component.
    """
    kind = ThrottleKind.SUBMIT if key.kind is None else key.kind
    components = key_components(by, key)
    caller = {name: value for name, value in components.items() if name != ThrottleBy.FORM.value}
    whole = hmac.new(salt, _canonical(components), hashlib.sha256).hexdigest()
    who = hmac.new(salt, _CALLER_TAG + _canonical(caller), hashlib.sha256).hexdigest()
    return f"datum:throttle:{kind.value}:{whole}:{who}"


def address_storage_key(address: str, salt: bytes = b"") -> str:
    """Return the identifier of an address window: `datum:throttle:address:<key>:<caller>`.

    `address` is already counted (`counted_address`). Both digests are of `{"ip": address}`, salted, as `storage_key`
    makes them; the word `address` keeps the window apart from every per-form one. The caller digest is the one the
    same address has in its per-form windows when `by` is ip and form, so the capped storage evicts them as one
    caller's.
    """
    components: dict[str, str | None] = {ThrottleBy.IP.value: address}
    whole = hmac.new(salt, _canonical(components), hashlib.sha256).hexdigest()
    who = hmac.new(salt, _CALLER_TAG + _canonical(components), hashlib.sha256).hexdigest()
    return f"datum:throttle:{ADDRESS_KEY_SPACE}:{whole}:{who}"


def address_key(address: str | None, kind: ThrottleKind, channel: str) -> ThrottleKey:
    """Return the key an address-limit refusal names: the counted address, the route's kind and the channel."""
    return ThrottleKey(ip=counted_address(address), kind=kind, channel=channel)


def _canonical(components: dict[str, str | None]) -> bytes:
    return json.dumps(components, sort_keys=True, separators=(",", ":")).encode()


def _scheme(uri: str) -> str:
    scheme = urlsplit(uri).scheme
    return scheme.removeprefix(_ASYNC_PREFIX)


def _window(settings: Throttle) -> int:
    return max(1, math.ceil(settings.window.total_seconds()))


def _items(settings: Throttle) -> dict[ThrottleKind, RateLimitItem]:
    window = _window(settings)
    return {kind: RateLimitItemPerSecond(settings.limits.get(kind, settings.limit), window) for kind in ThrottleKind}


def _address_item(settings: Throttle) -> RateLimitItem | None:
    """Return the address limit per window, or None while it is off (`address_limit` None, or throttle disabled)."""
    if not settings.enabled or settings.address_limit is None:
        return None
    return RateLimitItemPerSecond(settings.address_limit, _window(settings))


class LimitsThrottleBase[Limiter]:
    """What both faces share: the settings, the key salt, the fail-open bookkeeping and the start checks.

    A subclass says how its store is built (`_build`) and whether the counters live in this process (`_in_process`);
    `delegate` is a face that counts for this one (the async face over a memory URI). Built on: nothing in
    `limits` carries a salt, a fail-open policy or Datum's check ids, so this is Datum's own.
    """

    def __init__(self, settings: Throttle) -> None:
        """Hold `datum.web.throttle` and make the key salt (the setting's, else a random one per process)."""
        self._settings = settings
        self._items = _items(settings)
        self._address_item = _address_item(settings)
        given = settings.key_salt
        self._salt = given.get_secret_value().encode() if given is not None else secrets.token_bytes(32)
        self._lock = threading.Lock()
        self._degraded = False
        self._log_after = 0.0
        self._limiter: Limiter | None = None
        self.delegate: LimitsThrottle | None = None

    def _build(self) -> Limiter:
        """Build the limiter over the store the URI names (may raise)."""
        raise NotImplementedError

    def _in_process(self) -> bool:
        raise NotImplementedError

    def _store_name(self) -> str:
        raise NotImplementedError

    def _ready(self) -> Limiter:
        """Return the limiter, building the store on first use (a failed build is retried by the next call)."""
        if self._limiter is None:
            self._limiter = self._build()
        return self._limiter

    def _try_build(self) -> None:
        """Build the store a network URI names now; a failure waits for `storage_check` (the start) to be reported."""
        if self._limiter is None and self.delegate is None:
            with suppress(Exception):
                self._ready()

    def storage_check(self) -> DatumCheck | None:
        """Build the store now and return `datum.E006` when it cannot be built (a missing client library, a bad URI)."""
        if self.delegate is not None:
            return self.delegate.storage_check()
        if not self._settings.enabled:
            return None
        try:
            self._ready()
        except Exception as error:
            return throttle_storage_unusable(type(error).__name__)
        return None

    def _failed(self, error: Exception) -> None:
        """Note a storage failure: degraded, and one ERROR per window naming the class, never the storage's words."""
        now = time.time()
        with self._lock:
            self._degraded = True
            if now < self._log_after:
                return
            self._log_after = now + self._settings.window.total_seconds()
        _LOG.error(
            "%s: the counter storage failed (%s); requests are allowed until it answers (the throttle fails open)",
            HEALTH_NAME,
            type(error).__name__,
        )

    def check_key_salt(self) -> DatumCheck | None:
        """Return an ERROR while the counters are shared (not in this process) and `key_salt` is unset, else None."""
        if self.delegate is not None:
            return self.delegate.check_key_salt()
        if not self._settings.enabled or self._in_process() or self._settings.key_salt is not None:
            return None
        return DatumCheck(
            CheckLevel.ERROR,
            KEY_SALT_CHECK_ID,
            f"{HEALTH_NAME} counts in a shared storage but datum.web.throttle.key_salt is not set; workers with "
            "different salts would count one caller apart, and an unsalted key can be reversed from a storage dump",
            "set datum.web.throttle.key_salt to a secret of at least 32 bytes, the same on every worker",
        )

    def check_w004(self) -> DatumCheck | None:
        """`datum.W004` while the counters live in this process's memory, else None."""
        if self.delegate is not None:
            return self.delegate.check_w004()
        if not self._in_process():
            return None
        return DatumCheck(
            CheckLevel.WARNING,
            W004,
            f"{HEALTH_NAME} keeps request counters in this process's memory; each worker counts alone, so N workers "
            "allow N times the limit, and a restart forgets them",
            "set datum.web.throttle.storage to a shared storage (async+redis://...), or run one worker",
        )

    def details(self) -> dict[str, object]:
        """Health details: the store's kind (never the URI), `perProcess` and `degraded` while its last call failed."""
        if self.delegate is not None:
            return self.delegate.details()
        return {"store": self._store_name(), "perProcess": self._in_process(), "degraded": self._degraded}

    @property
    def in_process(self) -> bool:
        """Whether the counters live in this process's memory (counting them does no I/O)."""
        if self.delegate is not None:
            return self.delegate.in_process
        return self._in_process()

    def _counted(self, key: ThrottleKey) -> tuple[RateLimitItem, str]:
        kind = ThrottleKind.SUBMIT if key.kind is None else key.kind
        return self._items[kind], storage_key(self._settings.by, key, self._salt)

    def _address_counted(self, address: str | None) -> tuple[RateLimitItem, str] | None:
        """Return the address window a request counts in, or None: the limit is off, or the request has no address."""
        counted = counted_address(address)
        if self._address_item is None or not counted:
            return None
        return self._address_item, address_storage_key(counted, self._salt)

    def _answer(self, allowed: bool, reset: float) -> Allow | Deny:
        with self._lock:
            self._degraded = False
        return Allow() if allowed else Deny(max(1, math.ceil(reset - time.time())))


class LimitsThrottle(LimitsThrottleBase[FixedWindowRateLimiter]):
    """`SubmissionThrottle` over `limits`' fixed window: `limit` per `window` per kind, keyed by `by`."""

    def __init__(self, settings: Throttle, *, storage: Storage | None = None) -> None:
        """Count under `datum.web.throttle`; `storage` replaces the one the setting's URI names."""
        super().__init__(settings)
        self._storage: Storage | None = storage
        if storage is not None:
            self._limiter = FixedWindowRateLimiter(storage)
        elif _scheme(settings.storage) in _MEMORY_SCHEMES:
            self._storage = BoundedMemoryStorage(settings.max_keys)
            self._limiter = FixedWindowRateLimiter(self._storage)
        self._try_build()

    @property
    def storage(self) -> Storage:
        """The store counted in; a network one is built on first use (`storage_check` builds it at start)."""
        self._ready()
        assert self._storage is not None  # noqa: S101 - _ready set it
        return self._storage

    def _build(self) -> FixedWindowRateLimiter:
        made = storage_from_string(self._settings.storage.removeprefix(_ASYNC_PREFIX))
        if not isinstance(made, Storage):
            raise ConfigurationError(f"{_scheme(self._settings.storage)} is not a synchronous limits storage")
        self._storage = made
        return FixedWindowRateLimiter(made)

    def check(self, key: ThrottleKey) -> Allow | Deny:
        """Count the request; `Deny` carries whole seconds to the window's reset, at least 1."""
        if not self._settings.enabled:
            return Allow()
        return self._hit(*self._counted(key))

    def check_address(self, address: str | None) -> Allow | Deny:
        """Count one request under its client address alone (the address limit); `Allow` when it is not counted.

        It is not counted while the limit is off, while the throttle is disabled, or when the request has no address.
        """
        counted = self._address_counted(address)
        return Allow() if counted is None else self._hit(*counted)

    def _hit(self, item: RateLimitItem, identifier: str) -> Allow | Deny:
        try:
            limiter = self._ready()
            allowed = limiter.hit(item, identifier)
            reset = 0.0 if allowed else limiter.storage.get_expiry(item.key_for(identifier))
        except MemoryError:
            raise
        except Exception as error:
            self._failed(error)
            return Allow()
        return self._answer(allowed, reset)

    def details(self) -> dict[str, object]:
        """Health details: the storage's own for the bounded one, else its kind; `degraded` while its call failed."""
        if isinstance(self._storage, BoundedMemoryStorage):
            return {**self._storage.details(), "degraded": self._degraded}
        return super().details()

    def _store_name(self) -> str:
        schemes = getattr(type(self._storage), "STORAGE_SCHEME", None) or ["custom"]
        return str(schemes[0]).removeprefix(_ASYNC_PREFIX)

    def _in_process(self) -> bool:
        return isinstance(self._storage, (BoundedMemoryStorage, MemoryStorage))


class AsyncLimitsThrottle(LimitsThrottleBase[AsyncFixedWindowRateLimiter]):
    """`AsyncSubmissionThrottle` for a network counter: memory URIs sync on the loop, any other store via `limits.aio`.

    A memory URI is pure memory (O(log n) under a lock, no I/O), so it is counted through the sync `LimitsThrottle`
    directly on the loop and keeps Datum's capped storage; there is no async twin of that storage. Any other URI
    (`async+redis://...`, or `redis://...`, which gets the `async+` prefix) goes to `limits.aio` and expires its own
    keys. The store is built when Datum starts (`storage_check`, `datum.E006` on failure), never in a request; a
    failure while counting fails open, with the same key, window and fail-open rules as the sync face.
    """

    def __init__(self, settings: Throttle, *, storage: AsyncStorage | None = None) -> None:
        """Count under `datum.web.throttle`; `storage` replaces the `limits.aio` store the setting's URI names."""
        super().__init__(settings)
        self._storage: AsyncStorage | None = storage
        if storage is not None:
            self._limiter = AsyncFixedWindowRateLimiter(storage)
        elif _scheme(settings.storage) in _MEMORY_SCHEMES:
            self.delegate = LimitsThrottle(settings)
        self._try_build()

    @property
    def sync(self) -> LimitsThrottle | None:
        """The sync face counting for a memory URI, else None."""
        return self.delegate

    async def check(self, key: ThrottleKey) -> Allow | Deny:
        """Count the request; `Deny` carries whole seconds to the window's reset, at least 1; a store failure allows."""
        if self.delegate is not None:
            return self.delegate.check(key)
        if not self._settings.enabled:
            return Allow()
        return await self._hit(*self._counted(key))

    async def check_address(self, address: str | None) -> Allow | Deny:
        """Count one request under its client address alone (see `LimitsThrottle.check_address`)."""
        if self.delegate is not None:
            return self.delegate.check_address(address)
        counted = self._address_counted(address)
        return Allow() if counted is None else await self._hit(*counted)

    async def _hit(self, item: RateLimitItem, identifier: str) -> Allow | Deny:
        try:
            limiter = self._ready()
            allowed = await limiter.hit(item, identifier)
            reset = 0.0 if allowed else await limiter.storage.get_expiry(item.key_for(identifier))
        except MemoryError:
            raise
        except Exception as error:
            self._failed(error)
            return Allow()
        return self._answer(allowed, reset)

    def _build(self) -> AsyncFixedWindowRateLimiter:
        uri = self._settings.storage
        made = storage_from_string(uri if uri.startswith(_ASYNC_PREFIX) else f"{_ASYNC_PREFIX}{uri}")
        if not isinstance(made, AsyncStorage):
            raise ConfigurationError(f"{_scheme(self._settings.storage)} is not an asynchronous limits storage")
        self._storage = made
        return AsyncFixedWindowRateLimiter(made)

    def _store_name(self) -> str:
        schemes = getattr(type(self._storage), "STORAGE_SCHEME", None) or [_scheme(self._settings.storage)]
        return str(schemes[0]).removeprefix(_ASYNC_PREFIX)

    def _in_process(self) -> bool:
        """Whether the counters live in this process: the store was given or built, and it is limits' memory store."""
        return isinstance(self._storage, AsyncMemoryStorage)
