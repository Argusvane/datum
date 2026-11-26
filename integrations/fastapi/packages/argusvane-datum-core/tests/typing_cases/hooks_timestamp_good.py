"""Timestamp hook, store, event and Datum shapes the type checkers must accept (mypy --strict and pyright strict)."""

import functools
from collections.abc import Mapping, Sequence
from datetime import UTC, datetime
from typing import Literal

from datum_core import Datum
from datum_core.events import DatumEvent, TimestampIssuedEvent, TimestampRefusedEvent, listener
from datum_core.hooks import HookRefusedError
from datum_core.timestamp import (
    Reading,
    TimestampChannel,
    Timestamper,
    TimestampGrant,
    TimestampRefusedError,
    TimestampRequestCustomizer,
    TimestampRequestDraft,
    TimestampRequestHook,
    TransportReply,
    TsaClientRecord,
    TsaClientStore,
    TsaKeyMaterial,
    TsaLog,
    TsaLogEntry,
    TsaSerialAllocator,
    TsaTimeSource,
    TsaTransport,
    every_channel,
)


# -- customizers: a plain hook, an async hook, a class with applies_to, a partial, a lambda --------------------------
def choose(draft: TimestampRequestDraft) -> TimestampRequestDraft:
    return draft.with_policy(draft.accepted_policies[0]).with_accuracy(0.5)


async def choose_async(draft: TimestampRequestDraft) -> TimestampRequestDraft | None:
    return None


def refuse(draft: TimestampRequestDraft) -> None:
    if draft.client is None:
        raise HookRefusedError.forbidden("tsa.client", "A client is needed.")
    raise TimestampRefusedError("badRequest", "Not this one.")


def tag(prefix: str, draft: TimestampRequestDraft) -> None:
    assert prefix


class SealsOnly:
    def __call__(self, draft: TimestampRequestDraft) -> TimestampRequestDraft | None:
        return draft if draft.channel == "seal" else None

    def applies_to(self, channel: Literal["http", "seal", "receipt"]) -> bool:
        return channel == "seal"


plain: TimestampRequestHook = choose
plain_async: TimestampRequestHook = choose_async
plain_partial: TimestampRequestHook = functools.partial(tag, "p")
plain_lambda: TimestampRequestHook = lambda draft: None  # noqa: E731
full: TimestampRequestCustomizer = SealsOnly()
wrapped: TimestampRequestCustomizer = every_channel(choose)
wrapped_async: TimestampRequestCustomizer = every_channel(choose_async)


# -- time, key, serials, log, clients, transport ----------------------------------------------------------------------
class Clock:
    def read(self) -> Reading:
        return Reading.available(datetime.now(UTC))


class AsyncClock:
    async def read(self) -> Reading:
        return Reading.unavailable("down")


class Key:
    @property
    def signature_algorithm(self) -> Literal["rsa-sha256", "ecdsa-sha256"]:
        return "ecdsa-sha256"

    @property
    def chain_der(self) -> tuple[bytes, ...]:
        return (b"",)

    def sign(self, data: bytes) -> bytes:
        return data


class Serials:
    def allocate(self) -> int:
        return 1


class Log:
    def append(self, entry: TsaLogEntry) -> None: ...

    def recent(self, limit: int) -> tuple[TsaLogEntry, ...]:
        return ()


class Clients:
    def find(self, key_hash: str) -> TsaClientRecord | None:
        return TsaClientRecord(key_hash[:8])

    def record_use(self, client_id: str, at: datetime) -> None: ...


class Wire:
    def post(
        self, url: str, body: bytes, *, content_type: str, accept: str, headers: Mapping[str, str], timeout: float
    ) -> TransportReply:
        return TransportReply(200, accept, body)


class Mine:
    def request(
        self,
        imprint: bytes,
        algorithm: str,
        *,
        policy: str | None = None,
        cert_req: bool = True,
        channel: TimestampChannel = "seal",
    ) -> TimestampGrant:
        return TimestampGrant(imprint, imprint, datetime.now(UTC), 1)


source: TsaTimeSource = Clock()
async_source: TsaTimeSource = AsyncClock()
key: TsaKeyMaterial = Key()
serials: TsaSerialAllocator = Serials()
log: TsaLog = Log()
clients: TsaClientStore = Clients()
transport: TsaTransport = Wire()
timestamper: Timestamper = Mine()

customizers: Sequence[TimestampRequestHook | TimestampRequestCustomizer] = [
    plain,
    plain_async,
    plain_partial,
    plain_lambda,
    full,
    wrapped,
    refuse,
]

datum = Datum(
    timestamp_request_customizers=customizers,
    tsa_time_source=source,
    tsa_key_material=key,
    tsa_serial_allocator=serials,
    tsa_log=log,
    tsa_client_store=clients,
    tsa_transport=transport,
)
authority = datum.timestamp_authority
if authority is not None:
    wire_grant: TimestampGrant = authority.request(b"", "sha256")  # the authority is a Timestamper
    as_timestamper: Timestamper = authority


# -- events ------------------------------------------------------------------------------------------------------------
def on_issued(event: TimestampIssuedEvent) -> None:
    serial: int = event.serial
    when: datetime = event.gen_time
    algorithm: str = event.imprint_algorithm
    client: str | None = event.client
    _ = (serial, when, algorithm, client)


async def on_refused(event: TimestampRefusedEvent) -> None:
    reason: str = event.reason
    name: str = event.fail_info
    assert reason or name


def on_anything(event: DatumEvent) -> None: ...


listener(TimestampIssuedEvent, on_issued)
listener(TimestampRefusedEvent, on_refused)
listener(TimestampIssuedEvent, on_anything)  # a listener typed for the base accepts the subclass event
listener(TimestampRefusedEvent, lambda event: None)
