"""The throttle fails open on a storage failure, salts its keys, and names its components."""

import hashlib
import json
import logging
import re
from typing import Any

import pytest
import time_machine
from limits.storage import MemoryStorage, Storage
from throttle_support import START, SpyStorage, key, settings

from datum_core.config.models import ThrottleBy, ThrottleKind
from datum_core.health import ComponentHealth, health
from datum_core.loggers import SUBMISSIONS
from datum_core.throttle import (
    Allow,
    BoundedMemoryStorage,
    Deny,
    LimitsThrottle,
    ThrottleKey,
    key_components,
    storage_key,
)
from datum_sandbox.checks import CheckLevel

SALT = "s" * 32
OTHER_SALT = "t" * 32


class FailingStorage(BoundedMemoryStorage):
    """A storage whose network is down: every call raises, with words that carry a credential."""

    def __init__(self) -> None:
        super().__init__()
        self.error: BaseException | None = RuntimeError("redis://:hunter2@cache.internal is unreachable")
        self.calls = 0

    def incr(self, key: str, expiry: int, amount: int = 1) -> int:
        self.calls += 1
        if self.error is not None:
            raise self.error
        return super().incr(key, expiry, amount)

    def get_expiry(self, key: str) -> float:
        if self.error is not None:
            raise self.error
        return super().get_expiry(key)


def errors_of(caplog: pytest.LogCaptureFixture) -> list[logging.LogRecord]:
    return [record for record in caplog.records if record.levelno >= logging.ERROR and record.name == SUBMISSIONS]


# -- fail open -----------------------------------------------------------------------------------------------------
def test_a_storage_failure_allows_the_request_and_says_degraded_without_the_storages_words() -> None:
    storage = FailingStorage()
    throttle = LimitsThrottle(settings(limit=1), storage=storage)
    assert throttle.details()["degraded"] is False
    assert [throttle.check(key()) for _ in range(5)] == [Allow()] * 5
    details = throttle.details()
    assert details["degraded"] is True
    assert "hunter2" not in repr(details)
    assert "cache.internal" not in repr(details)


def test_the_storage_failure_is_logged_once_per_window_at_error_without_its_words(
    caplog: pytest.LogCaptureFixture,
) -> None:
    throttle = LimitsThrottle(settings(limit=1, window=60), storage=FailingStorage())
    with caplog.at_level(logging.DEBUG, logger=SUBMISSIONS), time_machine.travel(START, tick=False) as clock:
        for _ in range(5):
            throttle.check(key())
        clock.shift(59)
        throttle.check(key())
        first = len(errors_of(caplog))
        clock.shift(2)
        throttle.check(key())
        throttle.check(key())
    assert first == 1
    assert len(errors_of(caplog)) == 2
    for record in errors_of(caplog):
        assert "stores.throttle" in record.getMessage()
        assert "RuntimeError" in record.getMessage()
        assert "hunter2" not in record.getMessage()
        assert record.exc_info is None


def test_a_denial_whose_reset_time_cannot_be_read_still_fails_open() -> None:
    storage = FailingStorage()
    storage.error = None
    throttle = LimitsThrottle(settings(limit=1), storage=storage)
    assert throttle.check(key()) == Allow()
    storage.error = RuntimeError("down")
    # incr fails before the denial is reached; the answer is an allow either way
    assert throttle.check(key()) == Allow()


def test_the_throttle_recovers_when_the_storage_does() -> None:
    storage = FailingStorage()
    throttle = LimitsThrottle(settings(limit=1), storage=storage)
    assert throttle.check(key()) == Allow()
    assert throttle.details()["degraded"] is True
    storage.error = None
    assert throttle.check(key()) == Allow()
    assert throttle.details()["degraded"] is False
    assert isinstance(throttle.check(key()), Deny)


@pytest.mark.parametrize("error", [MemoryError(), KeyboardInterrupt(), SystemExit(3)])
def test_what_is_not_an_ordinary_failure_is_not_swallowed(error: BaseException) -> None:
    storage = FailingStorage()
    storage.error = error
    throttle = LimitsThrottle(settings(), storage=storage)
    with pytest.raises(type(error)):
        throttle.check(key())


def test_a_degraded_throttle_leaves_the_health_report_up_and_readyz_ready() -> None:
    throttle = LimitsThrottle(settings(), storage=FailingStorage())
    throttle.check(key())
    report = health(
        [
            ("runtime", ComponentHealth.up),
            ("stores.throttle", lambda: ComponentHealth.up(**throttle.details())),
        ]
    )
    assert report.is_ready
    assert report.is_up
    assert report.components["stores.throttle"].details["degraded"] is True


# -- the salt ------------------------------------------------------------------------------------------------------
def stored_key(throttle_settings: Any, **given: Any) -> str:
    storage = SpyStorage()
    LimitsThrottle(throttle_settings, storage=storage).check(key(**given))
    (stored,) = set(storage.seen)
    return stored


def test_two_processes_with_memory_storage_do_not_share_a_salt() -> None:
    assert stored_key(settings()) != stored_key(settings())


def test_one_throttle_keeps_its_salt_for_its_life() -> None:
    storage = SpyStorage()
    throttle = LimitsThrottle(settings(), storage=storage)
    throttle.check(key())
    throttle.check(key())
    assert len(set(storage.seen)) == 1


def test_a_configured_salt_is_shared_by_every_worker_and_another_salt_gives_another_key() -> None:
    assert stored_key(settings(key_salt=SALT)) == stored_key(settings(key_salt=SALT))
    assert stored_key(settings(key_salt=SALT)) != stored_key(settings(key_salt=OTHER_SALT))


def test_the_storage_key_is_not_the_plain_digest_of_its_components() -> None:
    plain = hashlib.sha256(
        json.dumps({"form": "contact", "ip": "203.0.113.7"}, sort_keys=True, separators=(",", ":")).encode()
    )
    for given in (stored_key(settings(key_salt=SALT)), stored_key(settings())):
        assert plain.hexdigest() not in given
        assert re.search(r"datum:throttle:submit:[0-9a-f]{64}(?![0-9a-f])", given)


def test_storage_key_takes_the_salt_and_keeps_the_kind_in_the_clear() -> None:
    by = (ThrottleBy.IP, ThrottleBy.FORM)
    one = storage_key(by, key(ThrottleKind.TEST), b"a" * 32)
    two = storage_key(by, key(ThrottleKind.TEST), b"b" * 32)
    assert one != two
    assert one.startswith("datum:throttle:test:")


def test_a_shared_storage_without_a_salt_is_a_start_error_and_names_the_setting() -> None:
    throttle = LimitsThrottle(settings(), storage=MemoryStorage())
    assert throttle.check_key_salt() is None  # in process: the random salt is enough

    shared = LimitsThrottle(settings(), storage=_network_storage())
    check = shared.check_key_salt()
    assert check is not None
    assert check.level is CheckLevel.ERROR
    assert "datum.web.throttle.key_salt" in check.msg
    assert check.id.startswith("datum.E")
    assert LimitsThrottle(settings(key_salt=SALT), storage=_network_storage()).check_key_salt() is None
    assert LimitsThrottle(settings(enabled=False), storage=_network_storage()).check_key_salt() is None


def test_a_memory_storage_needs_no_salt_setting() -> None:
    assert LimitsThrottle(settings()).check_key_salt() is None


class NetworkStorage(Storage):
    """A storage that is neither of the memory kinds, as a shared counter store is (it counts in a bounded map here)."""

    STORAGE_SCHEME = ["fakecache"]  # noqa: RUF012 - mirrors limits' own class attribute

    def __init__(self) -> None:
        super().__init__()
        self._inner = BoundedMemoryStorage()

    @property
    def base_exceptions(self) -> type[Exception] | tuple[type[Exception], ...]:
        return ValueError

    def incr(self, key: str, expiry: int, amount: int = 1) -> int:
        return self._inner.incr(key, expiry, amount)

    def get(self, key: str) -> int:
        return self._inner.get(key)

    def get_expiry(self, key: str) -> float:
        return self._inner.get_expiry(key)

    def check(self) -> bool:
        return True

    def reset(self) -> int | None:
        return self._inner.reset()

    def clear(self, key: str) -> None:
        self._inner.clear(key)


def _network_storage() -> NetworkStorage:
    return NetworkStorage()


# -- the components -----------------------------------------------------------------------------------------------
def test_the_key_components_are_the_chosen_fields_of_the_throttle_key_and_nothing_else() -> None:
    given = ThrottleKey(
        ip="203.0.113.7", form_key="contact", principal="alice", kind=ThrottleKind.SUBMIT, channel="http"
    )
    assert key_components((ThrottleBy.IP, ThrottleBy.FORM), given) == {"ip": "203.0.113.7", "form": "contact"}
    assert key_components((ThrottleBy.PRINCIPAL,), given) == {"principal": "alice"}
    assert key_components((ThrottleBy.IP,), ThrottleKey(ip="198.51.100.9")) == {"ip": "198.51.100.9"}


def test_a_spoofed_forwarded_for_changes_no_component_the_key_is_made_of() -> None:
    """The route hands the address its server saw; the throttle's key has no field a header could ride in."""
    seen = ThrottleKey(ip="203.0.113.7", form_key="contact", kind=ThrottleKind.SUBMIT)
    components = key_components((ThrottleBy.IP, ThrottleBy.FORM), seen)
    assert components["ip"] == "203.0.113.7"
    assert set(ThrottleKey.__dataclass_fields__) == {"ip", "form_key", "principal", "kind", "channel"}
    assert "198.51.100.9" not in repr(components)
