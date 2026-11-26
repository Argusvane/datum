"""`IdempotencyStore`: the two calls every idempotency store keeps, over a receipt type the store never looks into.

The store sits below `datum_core.submissions` in the layer contract, so it cannot name `SubmissionReceipt`; it is
generic over the receipt and `datum_core.submissions` fixes the type (`SubmissionIdempotencyStore`). Built on:
`typing.Protocol` is the standard structural seam; nothing in the standard library or pydantic is a store protocol.
"""

from typing import Protocol

__all__ = ["IdempotencyStore"]


class IdempotencyStore[R](Protocol):
    """Ask before the handler, tell after it, hold no lock between; keyed by (form, version, submission key)."""

    def find(self, form_key: str, version: str, submission_key: str) -> R | None:
        """Return the receipt recorded for the key, or None. Never claims the key."""
        ...

    def record(self, form_key: str, version: str, submission_key: str, remembered: R) -> R:
        """Record `remembered` if the key has nothing and return what stands: the first writer's."""
        ...
