"""No key, hash, digest, input or rule text reaches a log record, whichever path a submission fails on."""

import contextlib
import logging
from collections.abc import Callable
from typing import Any

import pytest
from submissions_support import (
    RecordingIdempotency,
    Repository,
    Rig,
    SourceProvider,
    bus,
    definition,
    envelope,
    started,
)

from datum_core.canonical import canonical_digest
from datum_core.forms import DataSourceRequest, StoredDefinition
from datum_core.submissions import RememberedReceipt
from datum_sandbox.json import JsonValue
from datum_sandbox.protocol import SandboxResult

SECRET = "ZZSECRETZZ"
FOREIGN = "f" * 64


class BrokenRepository:
    """A repository whose lookup fails with the secret in its words."""

    def current(self, key: str) -> StoredDefinition | None:
        raise OSError(SECRET)


class BlindStore(RecordingIdempotency):
    def find(self, form_key: str, version: str, submission_key: str) -> RememberedReceipt | None:
        raise OSError(SECRET)


class ForgetfulStore(RecordingIdempotency):
    def record(
        self, form_key: str, version: str, submission_key: str, remembered: RememberedReceipt
    ) -> RememberedReceipt:
        raise OSError(SECRET)


class BrokenSource(SourceProvider):
    def items(self, request: DataSourceRequest) -> list[dict[str, JsonValue]]:
        raise RuntimeError(SECRET)


def contributor_raising(context: Any) -> None:
    raise RuntimeError(f"password={SECRET}")


def digest_mismatch(rig: Rig) -> None:
    rig.sandbox.verdict = SandboxResult({"errors": [], "values": {}, "digest": FOREIGN}, 0.01)


def nothing(rig: Rig) -> None:
    return None


# Each row: id, a factory of the seams, the arrangement of the rig, and the submitted values.
PATHS: list[tuple[str, Callable[[], dict[str, Any]], Callable[[Rig], None], dict[str, Any] | None]] = [
    ("a contributor", lambda: {"context_contributors": [contributor_raising]}, nothing, None),
    ("the repository", lambda: {"form_repository": BrokenRepository()}, nothing, None),
    ("the store's find", lambda: {"idempotency_store": BlindStore([])}, nothing, None),
    ("the store's record", lambda: {"idempotency_store": ForgetfulStore([])}, nothing, None),
    ("a foreign digest", dict, digest_mismatch, None),
    ("the default handler", lambda: {"handler": None}, nothing, {"name": SECRET}),
    (
        "a data source",
        lambda: {"form_repository": Repository([], definition(sourced=True)), "data_sources": [BrokenSource([])]},
        nothing,
        None,
    ),
]


@pytest.mark.parametrize(("seams", "arrange", "values"), [row[1:] for row in PATHS], ids=[row[0] for row in PATHS])
def test_no_log_record_carries_a_secret_a_digest_a_traceback_or_the_input(
    seams: Callable[[], dict[str, Any]],
    arrange: Callable[[Rig], None],
    values: dict[str, Any] | None,
    caplog: pytest.LogCaptureFixture,
) -> None:
    document = envelope(values=values)
    with started(**seams()) as rig:
        arrange(rig)
        caplog.set_level(logging.DEBUG, logger="datum")
        with contextlib.suppress(Exception):  # a path may raise; the records are what is held
            rig.submit(document, bus())
    assert caplog.records, "the path logged nothing, so the test holds nothing"
    digest = canonical_digest(document)
    for record in caplog.records:
        extras = [str(value) for name, value in vars(record).items() if name.startswith("datum_")]
        text = [record.getMessage(), *extras]
        assert not any(SECRET in part for part in text), record
        assert not any(FOREIGN in part or digest in part for part in text), record
        assert record.exc_info is None, record
