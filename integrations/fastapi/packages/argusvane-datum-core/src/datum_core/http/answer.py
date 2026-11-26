"""`HttpAnswer`: what the core hands a binding to write. Services answer outcomes; this layer maps them."""

from collections.abc import Mapping
from dataclasses import dataclass, field
from types import MappingProxyType


@dataclass(frozen=True, slots=True)
class HttpAnswer:
    """A status, headers and a body. Frozen; the headers are copied into a read-only mapping."""

    status: int
    headers: Mapping[str, str] = field(default_factory=dict)
    body: bytes = b""

    def __post_init__(self) -> None:
        """Freeze the headers so an answer built once cannot change under a caller."""
        object.__setattr__(self, "headers", MappingProxyType(dict(self.headers)))
