"""The timestamp protocols module: behaviour of its records, and that it imports nothing third-party."""

import ast
import asyncio
import dataclasses
import sys
from datetime import UTC, datetime
from pathlib import Path

import pytest

from datum_core.hooks import HookRefusedError
from datum_core.timestamp import protocols
from datum_core.timestamp.protocols import (
    HTTP_CHANNEL,
    Reading,
    TimestampRefusedError,
    TimestampRequestDraft,
    every_channel,
)

NOW = datetime(2026, 1, 1, tzinfo=UTC)


def draft() -> TimestampRequestDraft:
    return TimestampRequestDraft("http", "sha256", None, "1.2.3", ("1.2.3", "1.2.4"), 1.0, True)


def test_a_reading_needs_an_aware_instant() -> None:
    with pytest.raises(ValueError, match="timezone-aware"):
        Reading.available(datetime(2026, 1, 1))
    reading = Reading.available(NOW)
    assert reading.instant == NOW
    assert reading.reason is None
    assert reading.is_available


def test_an_unavailable_reading_carries_its_reason() -> None:
    reading = Reading.unavailable("no clock")
    assert reading.instant is None
    assert reading.reason == "no clock"
    assert not reading.is_available


def test_the_draft_changes_by_copy() -> None:
    original = draft()
    changed = original.with_policy("1.2.4").with_accuracy(2.5)
    assert changed.policy == "1.2.4"
    assert changed.accuracy == 2.5
    assert original.policy == "1.2.3"
    assert original.accuracy == 1.0
    assert changed is not original


def test_the_records_are_frozen_and_slotted() -> None:
    for record in (draft(), Reading.available(NOW)):
        with pytest.raises(dataclasses.FrozenInstanceError):
            setattr(record, "unknown", 1)  # noqa: B010
        assert not hasattr(record, "__dict__")
    with pytest.raises(dataclasses.FrozenInstanceError):
        draft().policy = "x"  # type: ignore[misc]


def test_the_refusal_error() -> None:
    error = TimestampRefusedError("unacceptedPolicy", "no such policy")
    assert error.failure == "unacceptedPolicy"
    assert error.message == "no such policy"
    assert str(error) == "no such policy"
    assert str(TimestampRefusedError("badAlg")) == "badAlg"
    assert isinstance(error, Exception)
    assert not isinstance(error, HookRefusedError)


def test_every_channel_applies_everywhere_and_passes_through() -> None:
    seen: list[TimestampRequestDraft] = []
    result = draft().with_accuracy(3)

    def hook(d: TimestampRequestDraft) -> TimestampRequestDraft | None:
        seen.append(d)
        return result

    wrapped = every_channel(hook)
    assert all(wrapped.applies_to(c) for c in ("http", "seal", "receipt"))
    original = draft()
    assert wrapped(original) is result
    assert seen == [original]
    assert seen[0] is original

    async def ahook(d: TimestampRequestDraft) -> TimestampRequestDraft | None:
        return d

    pending = every_channel(ahook)(original)
    assert asyncio.iscoroutine(pending)
    assert asyncio.run(pending) is original


def test_the_http_channel() -> None:
    assert HTTP_CHANNEL == "http"


def test_protocols_imports_only_the_standard_library_and_the_hooks() -> None:
    # hooks.py may import pydantic itself; this module must not.
    tree = ast.parse(Path(protocols.__file__ or "").read_text())
    roots: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            roots.update(a.name for a in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            roots.add(node.module)
    for module in roots:
        allowed = {"datum_core.hooks"}
        assert module in allowed or module.split(".")[0] in sys.stdlib_module_names, module
