"""The canonical JSON of the digest contract: array-index keys first (numeric order), then UTF-16 code-unit order.

Differs from RFC 8785 only for integer-like keys. Numbers are ECMAScript `Number::toString`; an integer beyond 2^53 is
written as the double; `-0` as `0`. Non-finite numbers, lone surrogates and non-string keys are refused with
`BadDocumentError`. Libraries and the reasons: see `datum_core.jcs`.
"""

import hashlib
import re
from collections.abc import Iterable

from datum_core.jcs import code_unit_order, render

__all__ = ["canonical_bytes", "canonical_digest"]

_INDEX = re.compile(r"(?:0|[1-9][0-9]*)\Z")
_MAX_INDEX = 4294967295  # 2^32 - 1 is not an array index


def _is_index(key: str) -> bool:
    return len(key) <= 10 and _INDEX.match(key) is not None and int(key) < _MAX_INDEX  # noqa: PLR2004


def _digest_order(keys: Iterable[str]) -> list[str]:
    listed = list(keys)
    indexes = sorted((key for key in listed if _is_index(key)), key=int)
    return indexes + code_unit_order(key for key in listed if not _is_index(key))


def canonical_bytes(value: object) -> bytes:
    """Canonical UTF-8 bytes of a parsed JSON value."""
    return render(value, _digest_order)


def canonical_digest(value: object) -> str:
    """SHA-256 (hex) over the canonical bytes: the digest the engine computes."""
    return hashlib.sha256(canonical_bytes(value)).hexdigest()
