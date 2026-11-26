"""Hook shapes the type checkers must accept (mypy --strict and pyright strict)."""

import functools
from collections.abc import Awaitable
from typing import Protocol

from datum_core.events import DatumEvent, listener
from datum_core.hooks import Awaiter, Hook, MaybeAwaitable

type Admit = Hook[[str], bool]
type Receipt = Hook[[str], str]


class SyncAdmit:
    def __call__(self, s: str) -> bool:
        return True


class AsyncAdmit:
    async def __call__(self, s: str) -> bool:
        return True


def _adm(prefix: str, s: str) -> bool:
    return s.startswith(prefix)


async def _aadm(prefix: str, s: str) -> bool:
    return s.startswith(prefix)


a1: Admit = SyncAdmit()
a2: Admit = AsyncAdmit()
a3: Admit = functools.partial(_adm, "x")
a4: Admit = functools.partial(_aadm, "x")
a5: Admit = lambda s: len(s) > 0  # noqa: E731
r1: Receipt = str.upper


class Bound:
    def keep(self, s: str) -> str:
        return s

    async def akeep(self, s: str) -> str:
        return s


r2: Receipt = Bound().keep
r3: Receipt = Bound().akeep


class SyncStore:
    def get(self, key: str) -> str:
        return key


class AsyncStore:
    async def get(self, key: str) -> str:
        return key


class StoreLike:
    """A multi-method seam: each method answers `T | Awaitable[T]`."""

    def get(self, key: str) -> "MaybeAwaitable[str]":
        return key


def use(store: "SyncStore | AsyncStore") -> Awaitable[str] | str:
    return store.get("k")


class StoreSeam(Protocol):
    """A multi-method seam whose methods answer `MaybeAwaitable`, met by a sync and an async class."""

    def get(self, key: str, /) -> MaybeAwaitable[str]: ...

    def put(self, key: str, value: str, /) -> MaybeAwaitable[None]: ...


class SyncStore2:
    def get(self, key: str, /) -> str:
        return key

    def put(self, key: str, value: str, /) -> None: ...


class AsyncStore2:
    async def get(self, key: str, /) -> str:
        return key

    async def put(self, key: str, value: str, /) -> None: ...


s1: StoreSeam = SyncStore2()
s2: StoreSeam = AsyncStore2()


def plain_awaiter[T](awaitable: Awaitable[T], /) -> T:
    raise NotImplementedError


aw: Awaiter = plain_awaiter


class Ev(DatumEvent):
    pass


class SyncL:
    def __call__(self, e: Ev) -> None: ...


class AsyncL:
    async def __call__(self, e: Ev) -> None: ...


def _l(tag: str, e: Ev) -> None: ...


listener(Ev, SyncL())
listener(Ev, AsyncL())
listener(Ev, functools.partial(_l, "t"))
listener(Ev, lambda e: None)
listener(DatumEvent, lambda e: None)  # a forwarding listener on the base
