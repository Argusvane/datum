"""The throttle's vocabulary: the key a request is counted under, the two answers and the seams that give them.

Built on: `dataclasses` for the frozen records and `typing.Protocol` for the seams; `limits` has no key or answer
type of its own (its strategies answer a bare bool), and pydantic is for configuration, not per-request values.
"""

from dataclasses import dataclass, field
from typing import Protocol

from datum_core.config.models import ThrottleKind

__all__ = ["Allow", "AsyncSubmissionThrottle", "Deny", "SubmissionThrottle", "ThrottleKey"]


@dataclass(frozen=True, slots=True)
class ThrottleKey:
    """What a request is counted under. The address and the principal stay out of `repr`: a key is logged by accident.

    A caller supplies the part it knows (`ip`, `principal`, `channel`); the service completes `form_key` and `kind`,
    and counts `ip` as `counted_address` gives it (an IPv6 client by its /64).
    A key that reaches a throttle with no `kind` is counted as `submit`.
    """

    ip: str | None = field(default=None, repr=False)
    form_key: str | None = None
    principal: str | None = field(default=None, repr=False)
    kind: ThrottleKind | None = None
    channel: str | None = None


@dataclass(frozen=True, slots=True)
class Allow:
    """The request is within its limit."""


@dataclass(frozen=True, slots=True)
class Deny:
    """The request is over its limit; `retry_after` is whole seconds until the window resets, at least 1."""

    retry_after: int


class SubmissionThrottle(Protocol):
    """Counts one request and says whether it may go on. Synchronous: the service runs on a worker thread."""

    def check(self, key: ThrottleKey) -> Allow | Deny:
        """Count the request under the key and answer."""
        ...


class AsyncSubmissionThrottle(Protocol):
    """The awaitable twin of `SubmissionThrottle`, for a store that does I/O (a network counter)."""

    async def check(self, key: ThrottleKey) -> Allow | Deny:
        """Count the request under the key and answer."""
        ...
