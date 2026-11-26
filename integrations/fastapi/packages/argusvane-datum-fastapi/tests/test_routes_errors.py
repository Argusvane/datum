"""The one mapping point. Application refusals untouched, translators first, 500 with a correlation id."""

import inspect
import logging
from typing import Any

import pytest
from datum_fakes import StubRepository, StubRuntime, StubSandbox, config, definition, runtime_of, sandbox_of
from fastapi import APIRouter, Depends, FastAPI, HTTPException, Request
from fastapi.testclient import TestClient

from datum_core import DatumConfig
from datum_core.forms import DefinitionDraft, StoredDefinition
from datum_core.hooks import HookRefusedError
from datum_core.http import HttpAnswer
from datum_fastapi import Datum, routers

NATIVE_TELEMETRY = "telemetry" in inspect.signature(FastAPI.__init__).parameters
FORM = "contact"
PATH = f"/api/forms/{FORM}/definition"


class Exploding(StubRepository):
    """A repository whose read fails with a message that must never reach the wire."""

    def current(self, key: str) -> StoredDefinition | None:
        raise RuntimeError("password=hunter2 in /srv/secrets.db")


def make(cfg: DatumConfig | None = None, **seams: Any) -> FastAPI:
    seams.setdefault("form_repository", Exploding())
    datum = Datum(
        config=cfg or config(),
        runtime=runtime_of(StubRuntime()),
        sandbox=sandbox_of(StubSandbox()),
        **seams,
    )
    # FastAPI's native telemetry (newer releases) opens a server span as soon as any process-wide tracer provider is
    # installed, and the correlation id then IS that trace id; this module reads the generated 12-hex id.
    quiet: dict[str, Any] = {"telemetry": {"tracing": False, "metrics": False}} if NATIVE_TELEMETRY else {}
    app = FastAPI(**quiet)
    app.include_router(routers.forms(datum))
    return app


def teapot(error: Exception) -> HttpAnswer | None:
    if isinstance(error, RuntimeError):
        return HttpAnswer(status=418, headers={"Content-Type": "application/json"}, body=b'{"teapot":true}')
    return None


def test_any_other_exception_before_the_response_starts_is_a_500_internal_with_no_detail() -> None:
    with TestClient(make(), raise_server_exceptions=False) as client:
        reply = client.get(PATH)
    assert reply.status_code == 500
    assert reply.json()["errors"][0]["code"] == "internal"
    assert "hunter2" not in reply.text
    assert "secrets.db" not in reply.text
    assert "Traceback" not in reply.text


def test_the_500_is_logged_with_the_correlation_id_and_the_client_sees_it_only_in_problem_mode(
    caplog: pytest.LogCaptureFixture,
) -> None:
    cfg = config(web={"api": {"problem_details": True}})
    with caplog.at_level(logging.ERROR), TestClient(make(cfg), raise_server_exceptions=False) as client:
        reply = client.get(PATH)
    assert reply.status_code == 500
    assert reply.headers["content-type"] == "application/problem+json"
    correlation = reply.json()["correlationId"]
    assert reply.json()["code"] == "internal"
    logged = [r for r in caplog.records if getattr(r, "datum_correlation_id", None) == correlation]
    assert len(logged) == 1
    assert logged[0].levelno == logging.ERROR
    assert logged[0].exc_info is not None
    assert isinstance(logged[0].exc_info[1], RuntimeError)
    assert "hunter2" not in logged[0].getMessage()  # the cause is in exc_info, not in the message text


def test_the_default_mode_never_shows_the_correlation_id_to_the_client(caplog: pytest.LogCaptureFixture) -> None:
    with caplog.at_level(logging.ERROR), TestClient(make(), raise_server_exceptions=False) as client:
        reply = client.get(PATH)
    ids = [getattr(r, "datum_correlation_id", None) for r in caplog.records]
    assert any(ids)
    assert not any(i in reply.text for i in ids if i)


def test_a_well_formed_request_id_header_becomes_the_correlation_id(caplog: pytest.LogCaptureFixture) -> None:
    cfg = config(web={"api": {"problem_details": True}})
    with caplog.at_level(logging.ERROR), TestClient(make(cfg), raise_server_exceptions=False) as client:
        reply = client.get(PATH, headers={"X-Request-ID": "req-123.abc"})
    assert reply.json()["correlationId"] == "req-123.abc"
    assert [r for r in caplog.records if getattr(r, "datum_correlation_id", None) == "req-123.abc"]


def test_a_request_id_outside_the_pattern_is_not_echoed() -> None:
    cfg = config(web={"api": {"problem_details": True}})
    with TestClient(make(cfg), raise_server_exceptions=False) as client:
        reply = client.get(PATH, headers={"X-Request-ID": "bad id with spaces"})
    assert reply.json()["correlationId"] != "bad id with spaces"
    assert len(reply.json()["correlationId"]) == 12


def test_the_correlation_header_name_comes_from_the_setting() -> None:
    cfg = config(web={"api": {"problem_details": True, "correlation_header": "X-Trace-Me"}})
    with TestClient(make(cfg), raise_server_exceptions=False) as client:
        reply = client.get(PATH, headers={"X-Trace-Me": "mine-1"})
    assert reply.json()["correlationId"] == "mine-1"


def test_problem_mode_answers_rfc_9457_for_a_404_too() -> None:
    cfg = config(web={"api": {"problem_details": True}})
    app = make(cfg, form_repository=StubRepository())
    with TestClient(app) as client:
        reply = client.get(PATH)
    assert reply.status_code == 404
    assert reply.headers["content-type"] == "application/problem+json"
    body = reply.json()
    assert (body["type"], body["status"], body["code"]) == ("about:blank", 404, "form.notFound")


def test_error_translators_are_asked_first_in_list_order_and_the_first_answer_wins() -> None:
    asked: list[str] = []

    def never_answers(error: Exception) -> HttpAnswer | None:
        asked.append("first")
        return None

    def answers(error: Exception) -> HttpAnswer | None:
        asked.append("second")
        return teapot(error)

    def not_reached(error: Exception) -> HttpAnswer | None:
        asked.append("third")
        return HttpAnswer(status=451, headers={}, body=b"")

    with TestClient(
        make(error_translators=[never_answers, answers, not_reached]), raise_server_exceptions=False
    ) as client:
        reply = client.get(PATH)
    assert (reply.status_code, reply.json()) == (418, {"teapot": True})
    assert asked == ["first", "second"]


def test_error_translators_are_asked_before_datums_own_mapping_of_a_hook_refusal() -> None:
    def to_451(error: Exception) -> HttpAnswer | None:
        if isinstance(error, HookRefusedError):
            return HttpAnswer(status=451, headers={"Content-Type": "application/json"}, body=b'{"errors":[]}')
        return None

    class Refusing:
        def __call__(self, draft: DefinitionDraft) -> None:
            raise HookRefusedError.forbidden("no", "No.")

        def cache_key(self, request: Any) -> str | None:
            return None

    app = make(
        form_repository=StubRepository(definition(FORM)),
        error_translators=[to_451],
        definition_customizers=[Refusing()],
    )
    with TestClient(app) as client:
        assert client.get(PATH).status_code == 451


def test_with_no_translator_answering_the_500_still_applies() -> None:
    with TestClient(make(error_translators=[lambda error: None]), raise_server_exceptions=False) as client:
        assert client.get(PATH).status_code == 500


def test_a_customizer_that_changes_the_id_is_a_500_internal() -> None:
    class Renaming:
        def __call__(self, draft: DefinitionDraft) -> None:
            draft.definition["id"] = "other"

        def cache_key(self, request: Any) -> str | None:
            return None

    app = make(form_repository=StubRepository(definition(FORM)), definition_customizers=[Renaming()])
    with TestClient(app, raise_server_exceptions=False) as client:
        reply = client.get(PATH)
    assert (reply.status_code, reply.json()["errors"][0]["code"]) == (500, "internal")


def test_the_principal_and_locale_the_application_supplies_reach_the_customizer() -> None:
    seen: list[tuple[object, str]] = []

    class Spy:
        def __call__(self, draft: DefinitionDraft) -> None:
            seen.append((draft.request.principal, draft.request.locale))

        def cache_key(self, request: Any) -> str | None:
            return None

    def principal(request: Request) -> str | None:
        return request.headers.get("x-user")

    app = make(form_repository=StubRepository(definition(FORM)), definition_customizers=[Spy()], principal=principal)
    with TestClient(app) as client:
        client.get(PATH, headers={"x-user": "ana", "Accept-Language": "fr;q=0.4, de;q=0.9"})
        client.get(PATH)
    assert seen[0] == ("ana", "de")  # the first language by quality
    assert seen[1][0] is None  # an anonymous request is accepted: the principal is optional
    assert seen[1][1]  # never None or empty: the process locale


def test_a_locale_callable_the_application_supplies_decides_the_locale() -> None:
    seen: list[str] = []

    class Spy:
        def __call__(self, draft: DefinitionDraft) -> None:
            seen.append(draft.request.locale)

        def cache_key(self, request: Any) -> str | None:
            return None

    def mexican(request: Request) -> str:
        return "es-MX"

    app = make(form_repository=StubRepository(definition(FORM)), definition_customizers=[Spy()], locale=mexican)
    with TestClient(app) as client:
        client.get(PATH, headers={"Accept-Language": "fr"})
    assert seen == ["es-MX"]


def test_a_401_dependency_on_another_route_passes_through_while_the_optional_principal_route_answers() -> None:
    datum = Datum(
        config=config(),
        runtime=runtime_of(StubRuntime()),
        sandbox=sandbox_of(StubSandbox()),
        form_repository=StubRepository(definition(FORM)),
        principal=lambda: None,
    )
    app = FastAPI()
    app.include_router(routers.forms(datum))
    other = APIRouter()

    def deny() -> None:
        raise HTTPException(401, "who are you")

    @other.get("/private", dependencies=[Depends(deny)])
    def private() -> dict[str, bool]:
        return {"ok": True}

    app.include_router(other)
    with TestClient(app) as client:
        assert client.get(PATH).status_code == 200
        assert client.get("/private").status_code == 401
