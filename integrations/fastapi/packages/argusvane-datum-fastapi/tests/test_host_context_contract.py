"""The host context over HTTP: cases HCX-01 to HCX-04 against the contract form, plus the binding's own path.

The contract form is `datum-host-context` version 1 (`datum_core.testing.host_context.host_context_form`): `name`
required,
`admin_note` required and shown when `host.role = "admin"`. The TEST-ONLY provider
(`role_header_host_context`) answers `{"role": <X-Datum-Test-Role>}` for that form when the header is sent and no
context when it is not. The HCX rows run on the real engine (marker `runtime`, serial); the first rows here run on the
binding's fakes and show the header reaching the run's `hostContext` and nothing in the body doing so.
"""

import json
import uuid
from collections.abc import Callable, Iterator
from typing import Any

import pytest
from datum_fakes import StubRepository
from fastapi import FastAPI
from fastapi.testclient import TestClient
from submissions_fakes import Handler, Parts, build_app, config, make_datum

from datum_core.testing.host_context import (
    HOST_CONTEXT_FORM_ID,
    HOST_CONTEXT_ROLE_HEADER,
    host_context_form,
    role_header_host_context,
)
from datum_fastapi import Datum, routers
from datum_sandbox.wasi import GuestRuntimes

JSON = {"Content-Type": "application/json"}
ENGINE = "wasmtime"


def envelope(values: dict[str, Any], **extra: Any) -> dict[str, Any]:
    document: dict[str, Any] = {
        "versionContext": {"form": {"id": HOST_CONTEXT_FORM_ID, "version": "1"}, "client": {"runtimeVersion": "x"}},
        "submission": {"locale": "en", "values": values},
    }
    document.update(extra)
    return document


def forged() -> dict[str, Any]:
    """HCX-04's document: a forged `admin_note` answer and a forged host context in the envelope and its submission."""
    document = envelope({"name": "Ada", "admin_note": "forged"}, hostContext={"role": "admin"}, host={"role": "admin"})
    document["submission"]["hostContext"] = {"role": "admin"}
    return document


def check(document: dict[str, Any]) -> bytes:
    return json.dumps({"document": document, "scope": "journey"}).encode()


def delivery(document: dict[str, Any], key: str | None = None) -> bytes:
    return json.dumps({"document": document, "submissionKey": key or str(uuid.uuid4())}).encode()


def role(value: str | None) -> dict[str, str]:
    return JSON if value is None else {**JSON, HOST_CONTEXT_ROLE_HEADER: value}


# -- the binding's path, on the fakes ----------------------------------------------------------------------------------
@pytest.fixture
def faked() -> Iterator[tuple[TestClient, Parts]]:
    datum, parts = make_datum(
        config(), form_repository=StubRepository(host_context_form()), host_context=role_header_host_context
    )
    with TestClient(build_app(datum, authoring=[])) as client:
        yield client, parts


@pytest.mark.parametrize(
    ("path", "body"),
    [
        pytest.param("/api/submissions/validate", check, id="validate"),
        pytest.param("/api/submissions", delivery, id="submit"),
        pytest.param("/api/submissions/test", delivery, id="test"),
    ],
)
def test_the_header_reaches_the_run_as_host_context_and_its_absence_leaves_none(
    faked: tuple[TestClient, Parts], path: str, body: Callable[[dict[str, Any]], bytes]
) -> None:
    client, parts = faked
    assert client.post(path, content=body(envelope({"name": "Ada"})), headers=role("admin")).status_code == 200
    assert parts.sandbox.contexts[-1]["hostContext"] == {"role": "admin"}
    assert client.post(path, content=body(envelope({"name": "Ada"})), headers=role(None)).status_code == 200
    assert len(parts.sandbox.contexts) == 2
    assert "hostContext" not in parts.sandbox.contexts[-1]


def test_a_host_context_forged_in_the_document_never_reaches_the_run(faked: tuple[TestClient, Parts]) -> None:
    client, parts = faked
    assert client.post("/api/submissions/validate", content=check(forged()), headers=role("user")).status_code == 200
    assert parts.sandbox.contexts[-1]["hostContext"] == {"role": "user"}
    assert client.post("/api/submissions/validate", content=check(forged()), headers=role(None)).status_code == 200
    assert "hostContext" not in parts.sandbox.contexts[-1]


def test_a_provider_that_answers_what_json_cannot_carry_is_503_server_unavailable_never_a_verdict() -> None:
    datum, parts = make_datum(
        config(), form_repository=StubRepository(host_context_form()), host_context=lambda key, context: ["admin"]
    )
    with TestClient(build_app(datum)) as client:
        reply = client.post("/api/submissions/validate", content=check(envelope({"name": "Ada"})), headers=JSON)
    assert reply.status_code == 503
    assert reply.json()["errors"][0]["code"] == "server.unavailable"
    assert "retry-after" not in reply.headers
    assert parts.sandbox.contexts == []


# -- HCX-01 to HCX-04 on the real engine -------------------------------------------------------------------------------
class Rig:
    def __init__(self, client: TestClient, handler: Handler) -> None:
        self.client = client
        self.handler = handler

    def validate(self, document: dict[str, Any], header: str | None) -> Any:
        return self.client.post("/api/submissions/validate", content=check(document), headers=role(header))

    def submit(self, document: dict[str, Any], header: str | None, key: str | None = None) -> Any:
        return self.client.post("/api/submissions", content=delivery(document, key), headers=role(header))


@pytest.fixture(scope="module")
def real(tmp_path_factory: pytest.TempPathFactory) -> Iterator[Rig]:
    if ENGINE not in GuestRuntimes.discover().ids():
        pytest.skip(f"the {ENGINE} engine is not installed (argusvane-datum-sandbox-wasmtime registers it)")
    handler = Handler()
    work = tmp_path_factory.mktemp("hcx")
    datum = Datum(
        config=config(runtime={"work_dir": str(work), "warm_up_runs": 0}),
        form_repository=StubRepository(host_context_form()),
        host_context=role_header_host_context,
        handler=handler,
    )
    app = FastAPI()
    app.include_router(routers.submissions(datum))
    app.include_router(routers.authoring(datum, dependencies=[]))
    with TestClient(app) as client:
        yield Rig(client, handler)


ONLY_NAME = {"name": "Ada"}


@pytest.mark.runtime
def test_hcx_01_an_admin_without_the_note_is_refused_with_admin_note_required(real: Rig) -> None:
    checked = real.validate(envelope(ONLY_NAME), "admin")
    assert checked.status_code == 200
    assert checked.json()["accepted"] is False
    assert {"field": "admin_note", "code": "required"} in checked.json()["errors"]
    submitted = real.submit(envelope(ONLY_NAME), "admin")
    assert submitted.status_code == 422
    assert {"field": "admin_note", "code": "required"} in submitted.json()["errors"]


@pytest.mark.runtime
def test_hcx_02_another_role_is_accepted(real: Rig) -> None:
    checked = real.validate(envelope(ONLY_NAME), "user")
    assert (checked.status_code, checked.json()["accepted"], checked.json()["errors"]) == (200, True, [])
    assert real.submit(envelope(ONLY_NAME), "user").status_code == 200


@pytest.mark.runtime
def test_hcx_03_no_context_is_the_lenient_reading_and_is_accepted(real: Rig) -> None:
    checked = real.validate(envelope(ONLY_NAME), None)
    assert (checked.status_code, checked.json()["accepted"]) == (200, True)
    assert real.submit(envelope(ONLY_NAME), None).status_code == 200
    dry = real.client.post("/api/submissions/test", content=delivery(envelope(ONLY_NAME)), headers=role(None))
    assert dry.status_code == 200, dry.text
    assert dry.json()["outcome"] == "accepted", dry.text
    assert "accepted" not in dry.json()
    assert dry.json()["visibilitySkipped"] == ["admin_note"], dry.text


@pytest.mark.runtime
def test_hcx_04_a_forged_context_and_answer_change_nothing_and_the_note_is_not_kept(real: Rig) -> None:
    checked = real.validate(forged(), "user")
    assert (checked.status_code, checked.json()["accepted"], checked.json()["errors"]) == (200, True, [])
    before = len(real.handler.calls)
    submitted = real.submit(forged(), "user")
    assert submitted.status_code == 200, submitted.text
    kept = real.handler.calls[before].values
    assert "admin_note" not in kept
    assert kept["name"] == "Ada"
    dry = real.client.post("/api/submissions/test", content=delivery(forged()), headers=role("user"))
    assert dry.status_code == 200, dry.text
    assert dry.json()["outcome"] == "accepted", dry.text
    assert isinstance(dry.json()["values"], dict), dry.text
    assert "admin_note" not in dry.json()["values"], dry.text


@pytest.mark.runtime
def test_a_retry_of_an_accepted_attempt_keeps_its_first_verdict_whatever_the_role_says_now(real: Rig) -> None:
    key = str(uuid.uuid4())
    first = real.submit(envelope(ONLY_NAME), "user", key)
    again = real.submit(envelope(ONLY_NAME), "admin", key)
    assert (first.status_code, again.status_code) == (200, 200)
    assert again.json()["handled"] is True
    assert again.json()["id"] == first.json()["id"]
