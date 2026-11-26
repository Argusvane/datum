"""A large request body is parsed on a worker thread, never on the event loop.

The strict reader holds the GIL for the whole parse (a 1 MiB body takes tens of milliseconds), and every other request
on the worker waits for the loop meanwhile. A body larger than the inline limit is parsed through the runner, so a
flood of large bodies is bounded by the runner's slots and answered `server.busy` when they are full; a small body is
parsed where it is, the thread hop costing more than the parse. The wire order is unchanged: the address limit counts
the request before its body is read, and the parse still comes before the per-form throttle.
"""

import asyncio
import importlib
import json
from collections.abc import Callable
from typing import Any

import builder_fakes
import pdf_fakes
import pytest
import submissions_fakes
from datum_fakes import definition
from fastapi.testclient import TestClient

from datum_fastapi.routers import _intake

intake = importlib.import_module("datum_fastapi.routers._intake")  # a patched name, not an exported one
builder = importlib.import_module("datum_fastapi.routers.builder")
pdf = importlib.import_module("datum_fastapi.routers.pdf")

LARGE = "x" * (_intake.INLINE_PARSE_BYTES + 1024)


def _on_a_loop() -> bool:
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return False
    return True


class Recorder:
    """Wraps a parse function and records, per call, whether it ran on a thread with a running event loop."""

    def __init__(self) -> None:
        self.on_loop: list[bool] = []

    def wrap[**P, T](self, parse: Callable[P, T]) -> Callable[P, T]:
        def recorded(*args: P.args, **kwargs: P.kwargs) -> T:
            self.on_loop.append(_on_a_loop())
            return parse(*args, **kwargs)

        return recorded


@pytest.fixture
def recorder(monkeypatch: pytest.MonkeyPatch) -> Recorder:
    recording = Recorder()
    monkeypatch.setattr(intake, "parse_json_body", recording.wrap(intake.parse_json_body))
    monkeypatch.setattr(builder, "parse_json_body", recording.wrap(builder.parse_json_body))
    monkeypatch.setattr(pdf, "parse_pdf_request", recording.wrap(pdf.parse_pdf_request))
    return recording


def _submissions_client() -> tuple[TestClient, submissions_fakes.Parts]:
    datum, parts = submissions_fakes.make_datum()
    return TestClient(submissions_fakes.build_app(datum, authoring=[])), parts


def _large_envelope() -> dict[str, Any]:
    return submissions_fakes.envelope(values={"name": LARGE})


JSON = {"Content-Type": "application/json"}


BODIES: dict[str, Callable[[dict[str, Any]], dict[str, Any]]] = {
    "/api/submissions": lambda document: {"document": document, "submissionKey": "k" * 32},
    "/api/submissions/validate": lambda document: {"document": document, "scope": "journey"},
    "/api/submissions/test": lambda document: {"document": document},
    "/api/inspect": lambda document: {"op": "describe", "definition": document},
}


@pytest.mark.parametrize("path", BODIES)
def test_a_large_submission_or_authoring_body_is_parsed_off_the_loop(recorder: Recorder, path: str) -> None:
    client, _parts = _submissions_client()
    with client as running:
        running.post(path, content=json.dumps(BODIES[path](_large_envelope())).encode(), headers=JSON)
    assert recorder.on_loop == [False]


def test_a_small_body_is_parsed_where_it_is(recorder: Recorder) -> None:
    client, _parts = _submissions_client()
    small = submissions_fakes.body_of()
    assert len(small) <= _intake.INLINE_PARSE_BYTES
    with client as running:
        assert running.post("/api/submissions", content=small, headers=JSON).status_code == 200
    assert recorder.on_loop == [True]


def test_a_large_bad_body_is_still_400_before_the_throttle(recorder: Recorder) -> None:
    client, parts = _submissions_client()
    parts.throttle.deny = 30
    with client as running:
        reply = running.post("/api/submissions", content=b'{"document": "' + LARGE.encode(), headers=JSON)
    assert reply.status_code == 400
    assert parts.throttle.keys == []
    assert recorder.on_loop == [False]


def test_a_large_builder_write_is_parsed_off_the_loop(recorder: Recorder) -> None:
    datum, _parts = builder_fakes.make_datum()
    value = definition("fresh")
    value["description"] = LARGE
    with TestClient(builder_fakes.build_app(datum)) as running:
        running.post("/api/forms", content=json.dumps(value).encode(), headers=builder_fakes.WRITE)
    assert recorder.on_loop == [False]


def test_a_large_pdf_request_is_parsed_off_the_loop(recorder: Recorder) -> None:
    datum, _parts = pdf_fakes.make_datum()
    document = pdf_fakes.envelope(name=LARGE)
    with TestClient(pdf_fakes.build_app(datum)) as running:
        running.post("/api/pdf", content=json.dumps({"document": document}).encode(), headers=JSON)
    assert recorder.on_loop == [False]
