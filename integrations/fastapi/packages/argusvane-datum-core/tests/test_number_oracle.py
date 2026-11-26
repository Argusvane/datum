"""The formatter against the 341,012-case oracle (bit patterns and the engine's text), streamed in batches."""

import gzip
import json
import struct
from collections.abc import Iterator
from pathlib import Path

import pytest

from datum_core.canonical import canonical_bytes
from datum_core.jcs import format_number
from datum_sandbox.json import read

ORACLE = Path(__file__).resolve().parents[3].parent / "shared" / "fixtures" / "number-oracle.json.gz"
BATCH = 10_000
EXPECTED = 341_012


def _batches() -> Iterator[list[list[str]]]:
    with gzip.open(ORACLE, "rb") as handle:
        rows = json.loads(handle.read())
    for start in range(0, len(rows), BATCH):
        yield rows[start : start + BATCH]


@pytest.mark.timeout(600)
def test_every_case_agrees() -> None:
    seen = 0
    mismatches: list[tuple[str, str, str]] = []
    for batch in _batches():
        for bits, expected in batch:
            value = struct.unpack(">d", bytes.fromhex(bits))[0]
            got = format_number(value)
            if got != expected:
                mismatches.append((bits, expected, got))
            if value != 0:
                # the whole path: text through the reader and the canonical writer
                again = canonical_bytes(read(expected.encode(), max_depth=256)).decode()
                if again != expected:
                    mismatches.append((bits, expected, again))
        seen += len(batch)
    assert not mismatches, mismatches[:5]
    assert seen == EXPECTED
