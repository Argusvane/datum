"""The `limits>=5,<6` canary: the storage interface Datum's bounded storage implements, and the strategies it feeds."""

import inspect

import limits
import pytest
from limits import aio
from limits.storage import MemoryStorage, Storage

from datum_core.throttle import BoundedMemoryStorage

ABSTRACT = {"incr", "get", "get_expiry", "check", "reset", "clear"}


def test_the_public_storage_interface_is_the_six_methods_datum_implements() -> None:
    assert {name for name in dir(Storage) if getattr(getattr(Storage, name), "__isabstractmethod__", False)} >= ABSTRACT
    for name in ABSTRACT:
        assert callable(getattr(BoundedMemoryStorage, name))
        assert not getattr(getattr(BoundedMemoryStorage, name), "__isabstractmethod__", False)


def test_the_signatures_datum_relies_on_are_unchanged() -> None:
    assert list(inspect.signature(Storage.incr).parameters) == ["self", "key", "expiry", "amount"]
    assert list(inspect.signature(Storage.get_expiry).parameters) == ["self", "key"]
    assert list(inspect.signature(Storage.clear).parameters) == ["self", "key"]


def test_limits_is_in_the_supported_major_and_ships_the_fixed_window_strategy_both_ways() -> None:
    assert limits.__version__.split(".")[0] == "5"
    assert hasattr(limits.strategies, "FixedWindowRateLimiter")
    assert hasattr(aio.strategies, "FixedWindowRateLimiter")
    assert issubclass(MemoryStorage, Storage)


def test_the_async_strategy_face_refuses_the_sync_bounded_storage() -> None:
    with pytest.raises(AssertionError):
        aio.strategies.FixedWindowRateLimiter(BoundedMemoryStorage(1))


def test_the_bounded_storage_is_a_sync_limits_storage() -> None:
    assert issubclass(BoundedMemoryStorage, Storage)
