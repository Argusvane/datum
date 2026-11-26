"""The facade shows the real types: a wrong use through `datum_core.timestamp` is an error, a right one is not."""

from collections.abc import Sequence
from datetime import UTC, datetime

from datum_core.timestamp import (
    Reading,
    TimestampRequestCustomizer,
    TimestampRequestDraft,
    TimestampRequestHook,
    TsaSerialAllocator,
    TsaTimeSource,
    every_channel,
)
from datum_core.timestamp.protocols import Reading as DirectReading


class Clock:
    def read(self) -> Reading:
        return Reading.available(datetime.now(UTC))


class Serials:
    def allocate(self) -> int:
        return 1


source: TsaTimeSource = Clock()
serials: TsaSerialAllocator = Serials()
same: type[DirectReading] = Reading
wrapped = every_channel(lambda draft: draft.with_accuracy(0.5))


def check(draft: TimestampRequestDraft) -> float:
    return draft.accuracy


def plain(draft: TimestampRequestDraft) -> TimestampRequestDraft | None:
    return draft


async def plain_async(draft: TimestampRequestDraft) -> TimestampRequestDraft | None:
    return draft


hooks: Sequence[TimestampRequestHook | TimestampRequestCustomizer] = [
    every_channel(plain),
    every_channel(plain_async),
    plain,
    plain_async,
]
