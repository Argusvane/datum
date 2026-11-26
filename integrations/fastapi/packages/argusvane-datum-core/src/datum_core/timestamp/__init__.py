"""The RFC 3161 timestamp authority and client: a lazy facade over the submodules.

`argusvane-datum-core[timestamp]` brings asn1crypto and cryptography, so importing this package pulls neither: a name is
imported from its submodule on first use (PEP 562). The names appear under `TYPE_CHECKING` so the type checkers see
the real types. `_der` is private and not listed. The store seams come from `datum_core.stores.tsa`, where they live
below this package in the layering.
"""

import importlib
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from datum_core.stores.tsa import TsaClientRecord, TsaClientStore, TsaLog, TsaLogEntry, TsaSerialAllocator
    from datum_core.timestamp.authority import TimestampAnswer, TimestampAuthority
    from datum_core.timestamp.certificate import SelfSignedTsaCertificate, TsaCertificateRules
    from datum_core.timestamp.client import TimestampClient, TimestampClientError, TimestampClientGrant
    from datum_core.timestamp.keys import KeyFileTsaKeyMaterial
    from datum_core.timestamp.protocols import (
        HTTP_CHANNEL,
        Reading,
        TimestampChannel,
        Timestamper,
        TimestampFailure,
        TimestampGrant,
        TimestampRefusedError,
        TimestampRequestCustomizer,
        TimestampRequestDraft,
        TimestampRequestHook,
        TransportReply,
        TsaKeyMaterial,
        TsaTimeSource,
        TsaTransport,
        every_channel,
    )
    from datum_core.timestamp.query import TimestampQuery
    from datum_core.timestamp.receipt import ReceiptStatement
    from datum_core.timestamp.refusal import TimestampRefusal
    from datum_core.timestamp.token import TimestampToken
    from datum_core.timestamp.transport import HttpTsaTransport, ReplyTooLargeError

    # Each submodule adds its names here; tests/test_timestamp_facade.py fails until it does.

_SOURCES: dict[str, str] = {
    "TimestampQuery": "query",
    "TimestampRefusal": "refusal",
    "TimestampToken": "token",
    "TimestampAuthority": "authority",
    "TimestampAnswer": "authority",
    "KeyFileTsaKeyMaterial": "keys",
    "TsaCertificateRules": "certificate",
    "SelfSignedTsaCertificate": "certificate",
    "TimestampClient": "client",
    "TimestampClientError": "client",
    "TimestampClientGrant": "client",
    "HttpTsaTransport": "transport",
    "ReplyTooLargeError": "transport",
    "ReceiptStatement": "receipt",
    **dict.fromkeys(
        (
            "HTTP_CHANNEL",
            "Reading",
            "TimestampChannel",
            "TimestampFailure",
            "TimestampGrant",
            "TimestampRefusedError",
            "TimestampRequestCustomizer",
            "TimestampRequestDraft",
            "TimestampRequestHook",
            "Timestamper",
            "TransportReply",
            "TsaKeyMaterial",
            "TsaTimeSource",
            "TsaTransport",
            "every_channel",
        ),
        "protocols",
    ),
    **dict.fromkeys(
        ("TsaClientRecord", "TsaClientStore", "TsaLog", "TsaLogEntry", "TsaSerialAllocator"), "datum_core.stores.tsa"
    ),
}

__all__ = [
    "HTTP_CHANNEL",
    "HttpTsaTransport",
    "KeyFileTsaKeyMaterial",
    "Reading",
    "ReceiptStatement",
    "ReplyTooLargeError",
    "SelfSignedTsaCertificate",
    "TimestampAnswer",
    "TimestampAuthority",
    "TimestampChannel",
    "TimestampClient",
    "TimestampClientError",
    "TimestampClientGrant",
    "TimestampFailure",
    "TimestampGrant",
    "TimestampQuery",
    "TimestampRefusal",
    "TimestampRefusedError",
    "TimestampRequestCustomizer",
    "TimestampRequestDraft",
    "TimestampRequestHook",
    "TimestampToken",
    "Timestamper",
    "TransportReply",
    "TsaCertificateRules",
    "TsaClientRecord",
    "TsaClientStore",
    "TsaKeyMaterial",
    "TsaLog",
    "TsaLogEntry",
    "TsaSerialAllocator",
    "TsaTimeSource",
    "TsaTransport",
    "every_channel",
]


def __getattr__(name: str) -> Any:  # noqa: ANN401 - the real types come from the TYPE_CHECKING imports
    """Import `name` from its submodule on first use and keep it on the package."""
    module = _SOURCES.get(name)
    if module is None:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    value = getattr(importlib.import_module(module if "." in module else f"{__name__}.{module}"), name)
    globals()[name] = value
    return value


def __dir__() -> list[str]:
    """List the public names with the module's own."""
    return sorted({*globals(), *__all__})
