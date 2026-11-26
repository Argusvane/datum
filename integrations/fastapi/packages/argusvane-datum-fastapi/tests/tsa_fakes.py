"""Fakes for the timestamp route tests: a test-PKI identity, recording seams, a Datum, an app and a DER writer.

The writer and reader here are the route tests' own (a few lines each), independent of `datum_core.timestamp` and of
the DER library it uses. The assumed API is spelled in the import lines: `routers.tsa`, `datum_fastapi.Datum` with the
TSA keywords, `Datum.async_timestamps`. Everything that signs uses the session `tsa_pki` fixture.
"""

import hashlib
import threading
from dataclasses import dataclass
from typing import Any

from datum_fakes import StubRepository, StubRuntime, StubSandbox, definition, merged, runtime_of, sandbox_of
from fastapi import FastAPI

from datum_core import DatumConfig
from datum_core.events import DatumEvent, DatumRuntimeReadyEvent
from datum_core.testing.tsa_pki import INSTANT, TsaIdentity
from datum_core.timestamp.protocols import Reading
from datum_fastapi import Datum, routers

POLICY = "1.3.6.1.4.1.99999.1"
OTHER_POLICY = "1.3.6.1.4.1.99999.2"
CLIENT_KEY = "dtsa_" + "Qk1uZ0pLd0d4cWFyTVpKbVhzbmFwdG9nZ1l3aHBqaXE"
QUERY_TYPE = "application/timestamp-query"
REPLY_TYPE = "application/timestamp-reply"
DIGEST = hashlib.sha256(b"hello").digest()


def key_hash(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


# -- DER, written and read here ----------------------------------------------------------------------------------------
def tlv(tag: int, body: bytes) -> bytes:
    size = len(body)
    if size < 0x80:
        head = bytes([size])
    else:
        length = size.to_bytes((size.bit_length() + 7) // 8, "big")
        head = bytes([0x80 | len(length)]) + length
    return bytes([tag]) + head + body


def der_int(value: int) -> bytes:
    return tlv(0x02, value.to_bytes(max(1, (value.bit_length() + 8) // 8), "big", signed=True))


def query_der(
    digest: bytes = DIGEST,
    *,
    oid: bytes = bytes.fromhex("0609608648016503040201"),
    nonce: int | None = None,
    cert_req: bool = True,
    policy: bytes | None = None,
) -> bytes:
    """A TimeStampReq; `oid` is the hash algorithm's whole OID TLV (SHA-256 by default)."""
    parts = [der_int(1), tlv(0x30, tlv(0x30, oid + b"\x05\x00") + tlv(0x04, digest))]
    if policy is not None:
        parts.append(policy)
    if nonce is not None:
        parts.append(der_int(nonce))
    if cert_req:
        parts.append(b"\x01\x01\xff")
    return tlv(0x30, b"".join(parts))


def der_oid(dotted: str) -> bytes:
    arcs = [int(part) for part in dotted.split(".")]
    body = bytearray([arcs[0] * 40 + arcs[1]])
    for arc in arcs[2:]:
        rest = arc >> 7
        chunk = [arc & 0x7F]
        while rest:
            chunk.append(0x80 | (rest & 0x7F))
            rest >>= 7
        body.extend(reversed(chunk))
    return tlv(0x06, bytes(body))


SHA1_OID = bytes.fromhex("06052b0e03021a")


@dataclass(frozen=True)
class Reply:
    status: int
    texts: tuple[str, ...]
    fail_bits: frozenset[int]
    token: bytes | None


def _read(data: bytes, at: int) -> tuple[int, bytes, int]:
    tag = data[at]
    first = data[at + 1]
    start = at + 2
    if first < 0x80:
        size = first
    else:
        count = first & 0x7F
        size = int.from_bytes(data[start : start + count], "big")
        start += count
    return tag, data[start : start + size], start + size


def children(content: bytes) -> list[tuple[int, bytes, bytes]]:
    found: list[tuple[int, bytes, bytes]] = []
    at = 0
    while at < len(content):
        tag, body, end = _read(content, at)
        found.append((tag, body, content[at:end]))
        at = end
    return found


def parse_reply(der: bytes) -> Reply:
    _, content, _ = _read(der, 0)
    top = children(content)
    info = children(top[0][1])
    status = int.from_bytes(info[0][1], "big", signed=True)
    texts: tuple[str, ...] = ()
    bits: frozenset[int] = frozenset()
    for tag, body, _ in info[1:]:
        if tag == 0x30:
            texts = tuple(item[1].decode() for item in children(body))
        elif tag == 0x03:
            octets = body[1:]
            bits = frozenset(i for i in range(len(octets) * 8 - body[0]) if octets[i // 8] & (0x80 >> (i % 8)))
    return Reply(status, texts, bits, top[1][2] if len(top) > 1 else None)


def contains_digest_and_nonce(reply: bytes, digest: bytes, nonce: int) -> bool:
    return digest in reply and der_int(nonce) in reply


# -- seams -------------------------------------------------------------------------------------------------------------
class IdentityKey:
    def __init__(self, identity: TsaIdentity) -> None:
        self.identity = identity
        self.signs = 0
        self._lock = threading.Lock()

    @property
    def signature_algorithm(self) -> Any:
        return self.identity.algorithm

    @property
    def chain_der(self) -> tuple[bytes, ...]:
        return self.identity.chain_der

    def sign(self, data: bytes) -> bytes:
        with self._lock:
            self.signs += 1
        return self.identity.sign(data)


class CountingSerials:
    def __init__(self) -> None:
        self.allocations = 0
        self._lock = threading.Lock()

    def allocate(self) -> int:
        with self._lock:
            self.allocations += 1
            return self.allocations


class Clock:
    def __init__(self) -> None:
        self.reason: str | None = None
        self.reads = 0

    def read(self) -> Reading:
        self.reads += 1
        return Reading.unavailable(self.reason) if self.reason else Reading.available(INSTANT)


class ListLog:
    def __init__(self) -> None:
        self.entries: list[Any] = []

    def append(self, entry: Any) -> None:
        self.entries.append(entry)

    def recent(self, limit: int) -> tuple[Any, ...]:
        return tuple(reversed(self.entries))[:limit]


class Parts:
    """The recording seams of one TSA `Datum`, kept together for the assertions."""

    def __init__(self, identity: TsaIdentity) -> None:
        self.key = IdentityKey(identity)
        self.serials = CountingSerials()
        self.clock = Clock()
        self.log = ListLog()
        self.events: list[DatumEvent] = []

    def record(self, event: DatumEvent) -> None:
        if not isinstance(event, DatumRuntimeReadyEvent):
            self.events.append(event)

    def seams(self) -> dict[str, Any]:
        return {
            "tsa_key_material": self.key,
            "tsa_serial_allocator": self.serials,
            "tsa_time_source": self.clock,
            "tsa_log": self.log,
            "listeners": [(DatumEvent, self.record)],
            "now": lambda: INSTANT,
        }


def tsa_sections(**tsa: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "enabled": True,
        "access": "open",
        "policy": POLICY,
        "accepted_policies": [OTHER_POLICY],
        "allow_memory_stores": True,
    }
    base.update(tsa)
    return {"tsa": base}


def config(*, tsa: dict[str, Any] | None = None, **more: Any) -> DatumConfig:
    return DatumConfig.model_validate(merged(tsa_sections(**(tsa or {})), more))


def make_datum(
    identity: TsaIdentity, cfg: DatumConfig | None = None, parts: Parts | None = None, **seams: Any
) -> tuple[Datum, Parts]:
    parts = parts or Parts(identity)
    options: dict[str, Any] = {
        "config": cfg or config(),
        "runtime": runtime_of(StubRuntime()),
        "sandbox": sandbox_of(StubSandbox()),
        "form_repository": StubRepository(definition("contact")),
        **parts.seams(),
    }
    options.update(seams)
    return Datum(**options), parts


def build_app(datum: Datum, *, prefix: str | None = None, **app_kwargs: Any) -> FastAPI:
    app = FastAPI(**app_kwargs)
    app.include_router(routers.tsa(datum) if prefix is None else routers.tsa(datum, prefix=prefix))
    return app


def operations_of(router: Any) -> dict[str, Any]:
    return {route.operation_id: route for route in router.routes if getattr(route, "operation_id", None)}


def events_of(parts: Parts) -> list[str]:
    return [type(event).__name__ for event in parts.events]
