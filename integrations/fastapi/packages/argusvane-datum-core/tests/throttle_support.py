"""Builders for the throttle tests: settings from the configuration tree, keys, and a storage that spies on its keys."""

from datetime import UTC, datetime
from typing import Any

from datum_core import DatumConfig
from datum_core.config.models import Throttle, ThrottleKind
from datum_core.throttle import BoundedMemoryStorage, ThrottleKey

START = datetime(2026, 10, 20, 12, 0, 0, tzinfo=UTC)


def settings(**throttle: Any) -> Throttle:
    """`datum.web.throttle` with the given fields over the defaults (limit 60 per 60 s, by ip and form)."""
    return DatumConfig.model_validate({"web": {"throttle": throttle}}).web.throttle


def key(
    kind: ThrottleKind = ThrottleKind.SUBMIT,
    *,
    ip: str | None = "203.0.113.7",
    form_key: str | None = "contact",
    principal: str | None = None,
    channel: str | None = "http",
) -> ThrottleKey:
    return ThrottleKey(ip=ip, form_key=form_key, principal=principal, kind=kind, channel=channel)


class SpyStorage(BoundedMemoryStorage):
    """The bounded storage, remembering every key `incr` was given."""

    def __init__(self, max_keys: int = 10_000) -> None:
        super().__init__(max_keys)
        self.seen: list[str] = []

    def incr(self, key: str, expiry: int, amount: int = 1) -> int:
        self.seen.append(key)
        return super().incr(key, expiry, amount)
