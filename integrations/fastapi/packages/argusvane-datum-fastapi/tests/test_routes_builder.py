"""`routers.builder`: `createForm`, `saveForm` and `saveFormTranslations`.

Privileged: `dependencies` is a required keyword and runs before the started guard and before any existence check, body
read or kernel run. `PUT /forms/{key}` answers, in this order: the application's own refusal, 404 for a form nobody
has, 415 and 413 from the body reader, 409 `form.outdated` from `If-Match`, 400 for a body that is not strict JSON, then
the service's answer. `POST /forms` takes no precondition. Every answer is `Cache-Control: no-store`.
"""

import inspect
import json
import logging
from collections.abc import AsyncIterator, Iterator
from typing import Any

import anyio
import httpx2
import pytest
from builder_fakes import (
    FORM,
    JSON_TYPE,
    MARKER,
    OTHER,
    PERSON,
    WRITE,
    Parts,
    body_of,
    build_app,
    config,
    digest_of,
    error_code,
    etag_of,
    finding,
    make_datum,
    operations_of,
    paths_of,
    verdict,
)
from catalog_support import endpoint, full_path
from datum_fakes import definition, refusing
from fastapi import Depends, FastAPI
from fastapi.routing import APIRoute
from fastapi.testclient import TestClient
from trace_log import TRACE

from datum_core.aio import AsyncBuilderService
from datum_core.canonical import canonical_bytes
from datum_core.events import FormDefinitionSavedEvent
from datum_core.hooks import HookFindings, HookProblem, HookRefusedError
from datum_core.loggers import CHECKS
from datum_core.stores import catalog_etag
from datum_core.stores.memory import MemoryTranslationCatalogStore
from datum_fastapi import DatumRoute, routers
from datum_sandbox.protocol import ProgramUnavailableError, SandboxError, SandboxFailure

NO_STORE = "no-store"
OPERATIONS = ("createForm", "saveForm", "saveFormTranslations")
STALE = '"' + "0" * 64 + '"'


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


@pytest.fixture
def parts() -> Parts:
    return Parts()


@pytest.fixture
def client(parts: Parts) -> Iterator[TestClient]:
    datum, _ = make_datum(parts=parts)
    with TestClient(build_app(datum)) as running:
        yield running


def current_etag(client: TestClient, key: str = FORM) -> str:
    reply = client.get(f"/api/forms/{key}/definition?public=false", headers=PERSON)
    assert reply.status_code == 200, reply.text
    return reply.headers["etag"]


def put(client: TestClient, value: Any, *, etag: str | None = "current", key: str = FORM, **headers: str) -> Any:
    sent = {**WRITE, **headers}
    if etag == "current":
        sent["If-Match"] = current_etag(client, key)
    elif etag is not None:
        sent["If-Match"] = etag
    content = value if isinstance(value, bytes) else body_of(value)
    return client.put(f"/api/forms/{key}", content=content, headers=sent)


def post(client: TestClient, value: Any, **headers: str) -> Any:
    content = value if isinstance(value, bytes) else body_of(value)
    return client.post("/api/forms", content=content, headers={**WRITE, **headers})


def async_client(app: Any) -> httpx2.AsyncClient:
    return httpx2.AsyncClient(transport=httpx2.ASGITransport(app=app), base_url="http://testserver")


# -- the privileged rule ----------------------------------------------------------------------------------------------
def test_the_factory_requires_dependencies_as_a_keyword_without_a_default() -> None:
    parameter = inspect.signature(routers.builder).parameters["dependencies"]
    assert parameter.kind is inspect.Parameter.KEYWORD_ONLY
    assert parameter.default is inspect.Parameter.empty


def test_a_call_without_dependencies_is_a_type_error_and_an_empty_list_is_the_explicit_opt_out() -> None:
    datum, _ = make_datum()
    factory: Any = routers.builder
    with pytest.raises(TypeError):
        factory(datum)
    with pytest.raises(TypeError):
        factory(datum, [])
    assert routers.builder(datum, dependencies=[]) is not None


def test_the_public_forms_factory_stays_public() -> None:
    parameter = inspect.signature(routers.forms).parameters["dependencies"]
    assert parameter.default is not inspect.Parameter.empty


# -- the catalog rows -------------------------------------------------------------------------------------------------
@pytest.mark.parametrize("operation_id", OPERATIONS)
def test_each_route_is_the_catalog_row_by_method_path_and_tag(operation_id: str) -> None:
    datum, _ = make_datum()
    routes = operations_of(routers.builder(datum, dependencies=[]))
    row = endpoint(operation_id)
    route = routes[operation_id]
    assert route.path == full_path(row)
    assert route.methods == {row["method"]}
    assert route.tags == ["datum-ui"]
    assert route.include_in_schema is True


def test_the_builder_serves_exactly_the_three_operations_and_the_hidden_author_copy() -> None:
    datum, _ = make_datum()
    api_routes = [route for route in routers.builder(datum, dependencies=[]).routes if isinstance(route, APIRoute)]
    visible = {route.operation_id for route in api_routes if route.include_in_schema}
    hidden = [(route.path, sorted(route.methods or ())) for route in api_routes if not route.include_in_schema]
    assert visible == set(OPERATIONS)
    assert hidden == [("/api/forms/{key}/definition", ["GET"])]


def test_a_builder_router_with_the_switch_off_adds_no_route_and_names_it_in_a_w001(
    caplog: pytest.LogCaptureFixture,
) -> None:
    datum, _ = make_datum(config(builder={"enabled": False}))
    router = routers.builder(datum, dependencies=[])
    assert list(router.routes) == []
    with caplog.at_level(logging.WARNING, logger=CHECKS), TestClient(build_app(datum)):
        pass
    notices = [r.getMessage() for r in caplog.records if getattr(r, "datum_check_id", None) == "datum.W001"]
    assert any("builder" in text for text in notices)
    assert any("datum.builder.enabled" in r.getMessage() for r in caplog.records)


def test_datum_enabled_false_adds_no_builder_route_even_with_the_builder_on() -> None:
    datum, _ = make_datum(config(enabled=False))
    assert list(routers.builder(datum, dependencies=[]).routes) == []


def test_with_the_switch_off_the_save_routes_answer_the_applications_404() -> None:
    datum, _ = make_datum(config(builder={"enabled": False}))
    with TestClient(build_app(datum)) as running:
        assert running.put(f"/api/forms/{FORM}", content=b"{}", headers=WRITE).json() == {"detail": "Not Found"}
        assert running.post("/api/forms", content=b"{}", headers=WRITE).status_code == 404
        # the public translations route owns that path for GET, so Starlette answers a PUT 405 with its Allow header
        reply = running.put(f"/api/forms/{FORM}/translations", content=b"{}", headers=WRITE)
        assert reply.status_code == 405
        assert reply.headers["allow"] == "GET"


def test_the_prefix_keyword_moves_the_base() -> None:
    datum, _ = make_datum()
    moved = paths_of(routers.builder(datum, prefix="/v2/api", dependencies=[]))
    assert moved == {
        "/v2/api/forms",
        "/v2/api/forms/{key}",
        "/v2/api/forms/{key}/translations",
        "/v2/api/forms/{key}/definition",
    }


def test_every_builder_route_uses_the_datum_route_class() -> None:
    datum, _ = make_datum()
    assert all(isinstance(route, DatumRoute) for route in routers.builder(datum, dependencies=[]).routes)


# -- the application's security comes first ---------------------------------------------------------------------------
ROUTES = [
    pytest.param("PUT", f"/api/forms/{FORM}", id="saveForm"),
    pytest.param("POST", "/api/forms", id="createForm"),
    pytest.param("PUT", f"/api/forms/{FORM}/translations", id="saveFormTranslations"),
    pytest.param("GET", f"/api/forms/{FORM}/definition?public=false", id="author copy"),
]


@pytest.mark.parametrize(("method", "path"), ROUTES)
@pytest.mark.parametrize(("headers", "status"), [({}, 401), (OTHER, 403)], ids=["visitor", "other person"])
def test_the_applications_dependencies_refuse_before_anything_is_read_or_run(
    method: str, path: str, headers: dict[str, str], status: int, parts: Parts
) -> None:
    datum, _ = make_datum(parts=parts)
    with TestClient(build_app(datum)) as running:
        reply = running.request(
            method, path, content=b"not even json", headers={**headers, "Content-Type": "text/plain"}
        )
    assert reply.status_code == status
    assert reply.json() == {"detail": "sign in" if status == 401 else "not you"}
    assert TRACE == ["persona"]
    assert parts.sandbox.checks == []
    assert parts.events == []
    assert MARKER not in reply.text


@pytest.mark.anyio
@pytest.mark.parametrize(("method", "path"), ROUTES)
async def test_the_applications_dependencies_run_before_the_started_guard_so_a_visitor_never_learns_the_state(
    method: str, path: str, parts: Parts
) -> None:
    datum, _ = make_datum(parts=parts)
    async with async_client(build_app(datum)) as http:  # no lifespan: the started guard would answer 503
        visitor = await http.request(method, path, content=b"{}")
        person = await http.request(method, path, content=b"{}", headers=WRITE)
    assert visitor.status_code == 401
    assert (person.status_code, error_code(person)) == (503, "server.unavailable")
    assert "retry-after" not in person.headers
    assert TRACE == ["persona", "persona"]


@pytest.mark.parametrize(("method", "path"), ROUTES)
def test_an_include_time_dependency_runs_before_the_builders_own_list(method: str, path: str, parts: Parts) -> None:
    datum, _ = make_datum(parts=parts)
    app = FastAPI()
    app.include_router(routers.forms(datum))
    app.include_router(routers.builder(datum, dependencies=[]), dependencies=[Depends(refusing(401, "outer"))])
    with TestClient(app) as running:
        reply = running.request(method, path, content=b"{}", headers=WRITE)
    assert reply.status_code == 401
    assert reply.json() == {"detail": "outer refused"}
    assert TRACE == ["outer"]


UNKNOWN_ROUTES = [
    pytest.param("PUT", "/api/forms/nope", id="unknown key"),
    pytest.param("PUT", "/api/forms/a@b", id="not a form key"),
    pytest.param("PUT", "/api/forms/nope/translations", id="unknown translations"),
    pytest.param("GET", "/api/forms/nope/definition?public=false", id="unknown author copy"),
    pytest.param("POST", "/api/forms", id="create"),
]


@pytest.mark.anyio
@pytest.mark.parametrize("lifespan", [True, False], ids=["lifespan on", "lifespan off"])
@pytest.mark.parametrize(("method", "path"), UNKNOWN_ROUTES)
async def test_a_visitor_gets_the_applications_refusal_before_a_404_a_415_or_a_413(
    method: str, path: str, lifespan: bool
) -> None:
    datum, _ = make_datum(config(builder={"max_definition_size": "1KiB"}))
    app = build_app(datum)
    if lifespan:
        async with datum, async_client(app) as http:
            reply = await http.request(method, path, content=b"x" * 5000, headers={"Content-Type": "text/plain"})
    else:
        async with async_client(app) as http:
            reply = await http.request(method, path, content=b"x" * 5000, headers={"Content-Type": "text/plain"})
    assert reply.status_code == 401
    assert reply.json() == {"detail": "sign in"}
    assert TRACE == ["persona"]


def test_a_guard_on_the_builder_does_not_guard_the_public_definition_route(parts: Parts) -> None:
    datum, _ = make_datum(parts=parts)
    with TestClient(build_app(datum)) as running:
        assert running.get(f"/api/forms/{FORM}/definition").status_code == 200
        assert running.get(f"/api/forms/{FORM}/translations").status_code == 200


def test_dependencies_may_be_empty_to_open_the_routes_on_purpose(parts: Parts) -> None:
    datum, _ = make_datum(parts=parts)
    with TestClient(build_app(datum, dependencies=[])) as running:
        reply = running.put(f"/api/forms/{FORM}", content=body_of(definition(FORM, "2")), headers=JSON_TYPE)
    assert reply.status_code == 200


# -- PUT /forms/{key}: the order --------------------------------------------------------------------------------------
@pytest.mark.parametrize("held", [{"If-Match": "*"}, {"If-Match": STALE}, {}])
def test_a_form_nobody_has_is_404_before_the_content_type_the_size_or_the_precondition_is_judged(
    client: TestClient, parts: Parts, held: dict[str, str]
) -> None:
    for sent in (
        {"Content-Type": "text/plain"},
        {"Content-Type": "application/json"},
    ):
        reply = client.put(
            "/api/forms/nope", content=body_of(definition("nope", "2")), headers={**PERSON, **sent, **held}
        )
        assert (reply.status_code, error_code(reply)) == (404, "form.notFound"), sent
        assert "etag" not in reply.headers
        assert reply.headers["cache-control"] == NO_STORE
        assert "nope" not in reply.text
    assert parts.sandbox.checks == []


@pytest.mark.parametrize("key", ["not a key", "a" * 129, "x%00y", "with@at"])
def test_a_key_that_is_no_form_key_is_404_form_not_found(client: TestClient, key: str) -> None:
    reply = client.put(f"/api/forms/{key}", content=b"{}", headers=WRITE)
    assert (reply.status_code, error_code(reply)) == (404, "form.notFound")


def test_the_wrong_content_type_is_415_before_the_precondition_and_the_parse(client: TestClient, parts: Parts) -> None:
    reply = client.put(
        f"/api/forms/{FORM}", content=b"not json", headers={**PERSON, "If-Match": STALE, "Content-Type": "text/plain"}
    )
    assert (reply.status_code, error_code(reply)) == (415, "unsupported_media_type")
    assert reply.headers["cache-control"] == NO_STORE
    assert parts.sandbox.checks == []


def test_a_body_over_the_cap_by_content_length_is_413_before_the_precondition(parts: Parts) -> None:
    datum, _ = make_datum(config(builder={"max_definition_size": "1KiB"}), parts=parts)
    with TestClient(build_app(datum)) as running:
        reply = running.put(f"/api/forms/{FORM}", content=b"{" + b"x" * 5000, headers={**WRITE, "If-Match": STALE})
    assert (reply.status_code, error_code(reply)) == (413, "bad_document")
    assert reply.headers["cache-control"] == NO_STORE
    assert parts.sandbox.checks == []


@pytest.mark.anyio
async def test_a_chunked_body_over_the_cap_is_413_without_a_content_length(parts: Parts) -> None:
    datum, _ = make_datum(config(builder={"max_definition_size": "1KiB"}), parts=parts)

    async def chunks() -> AsyncIterator[bytes]:
        for _ in range(20):
            yield b"x" * 200

    async with datum, async_client(build_app(datum)) as http:
        reply = await http.put(f"/api/forms/{FORM}", content=chunks(), headers={**WRITE, "If-Match": STALE})
    assert (reply.status_code, error_code(reply)) == (413, "bad_document")
    assert parts.sandbox.checks == []


def test_the_cap_is_the_builders_and_not_the_submissions(parts: Parts) -> None:
    datum, _ = make_datum(config(web={"api": {"max_body_size": "1KiB"}}), parts=parts)
    big = definition(FORM, "2")
    big["notes"] = "x" * 5000
    with TestClient(build_app(datum)) as running:
        reply = running.put(f"/api/forms/{FORM}", content=body_of(big), headers=WRITE)
    assert reply.status_code == 200


def test_a_stale_if_match_is_409_before_the_body_is_parsed(client: TestClient, parts: Parts) -> None:
    reply = put(client, b"this is not json {", etag=STALE)
    assert (reply.status_code, error_code(reply)) == (409, "form.outdated")
    assert reply.headers["etag"] == etag_of(parts.stored().definition)
    assert reply.headers["cache-control"] == NO_STORE
    assert parts.sandbox.checks == []


def test_a_body_that_is_not_json_is_400_bad_document_after_the_precondition_held(
    client: TestClient, parts: Parts
) -> None:
    for sent in (
        b"{",
        b"",
        b"[1,",
        b"not json",
        b'{"a":1}{"b":2}',
        b'{"a":NaN}',
        b'{"a":"\\ud800"}',
        b"\xef\xbb\xbf{}",
        b"\xff\xfe",
    ):
        reply = put(client, sent)
        assert (reply.status_code, error_code(reply)) == (400, "bad_document"), sent
        assert reply.headers["cache-control"] == NO_STORE
    deep = b'{"a":' + b"[" * 300 + b"]" * 300 + b"}"
    assert put(client, deep).status_code == 400
    assert parts.sandbox.checks == []
    assert parts.events == []


def test_an_absent_if_match_with_a_body_that_is_not_json_is_400_too(client: TestClient) -> None:
    reply = put(client, b"{", etag=None)
    assert (reply.status_code, error_code(reply)) == (400, "bad_document")


def test_the_service_answers_after_all_of_that_422_for_the_hosts_reading_of_the_shape(
    client: TestClient, parts: Parts
) -> None:
    reply = put(client, definition("other", "2"))
    assert reply.status_code == 422
    assert "definition.id.mismatch" in [item["code"] for item in reply.json()["errors"]]
    assert "definition.id.mismatch" in [item["code"] for item in reply.json()["kernel"]]
    assert reply.headers["cache-control"] == NO_STORE
    assert parts.sandbox.checks == []


def test_the_kernels_refusal_is_422_with_its_code_and_where_and_nothing_is_stored(
    client: TestClient, parts: Parts
) -> None:
    parts.sandbox.answer = verdict(problems=[finding("pattern.risky", "rules:tckfx:visibleWhen", "A risky pattern.")])
    before = etag_of(parts.stored().definition)
    reply = put(client, definition(FORM, "2"))
    assert reply.status_code == 422
    assert reply.json()["kernel"][0] == {"code": "pattern.risky", "where": "rules:tckfx:visibleWhen"}
    assert error_code(reply) == "pattern.risky"
    assert current_etag(client) == before
    assert parts.events == []


def test_a_kernel_run_that_failed_is_503_unavailable_and_the_form_is_not_saved(
    client: TestClient, parts: Parts
) -> None:
    parts.sandbox.error = SandboxError(SandboxFailure.THREW, "program threw")
    reply = put(client, definition(FORM, "2"))
    assert (reply.status_code, error_code(reply)) == (503, "server.unavailable")
    assert "retry-after" not in reply.headers
    assert "program threw" not in reply.text


def test_a_kernel_that_cannot_answer_is_503_unavailable_with_no_retry_after(client: TestClient, parts: Parts) -> None:
    parts.sandbox.error = ProgramUnavailableError("down")
    reply = put(client, definition(FORM, "2"))
    assert (reply.status_code, error_code(reply)) == (503, "server.unavailable")
    assert "retry-after" not in reply.headers
    assert reply.headers["cache-control"] == NO_STORE


# -- PUT /forms/{key}: the save ---------------------------------------------------------------------------------------
def test_a_save_is_200_with_the_etag_the_sha256_and_the_body_the_page_reads(client: TestClient, parts: Parts) -> None:
    sent = definition(FORM, "2")
    reply = put(client, sent)
    assert reply.status_code == 200
    document = reply.json()
    assert document["sha256"] == digest_of(sent)
    assert reply.headers["etag"] == f'"{document["sha256"]}"'
    assert reply.headers["cache-control"] == NO_STORE
    assert (document["key"], document["version"]) == (FORM, "2")
    assert document["catalog"] == {}
    assert document["warnings"] == []
    assert document["kernelWarnings"] == []
    assert "x-datum-removed-locales" not in reply.headers
    assert [type(e).__name__ for e in parts.events] == ["FormDefinitionSavedEvent"]


def test_the_saved_etag_is_the_next_author_copy_etag_and_the_next_if_match(client: TestClient) -> None:
    first = put(client, definition(FORM, "2"))
    assert current_etag(client) == first.headers["etag"]
    second = put(client, definition(FORM, "3"), etag=first.headers["etag"])
    assert second.status_code == 200
    assert second.headers["etag"] != first.headers["etag"]
    stale = put(client, definition(FORM, "4"), etag=first.headers["etag"])
    assert stale.status_code == 409
    assert stale.headers["etag"] == second.headers["etag"]


def test_the_author_copy_etag_is_the_sha256_of_the_canonical_bytes_the_save_stored(client: TestClient) -> None:
    sent = definition(FORM, "2", secret=True)
    reply = put(client, sent)
    author = client.get(f"/api/forms/{FORM}/definition?public=false", headers=PERSON)
    assert author.content == canonical_bytes(sent)
    assert author.headers["etag"] == reply.headers["etag"]
    assert MARKER in author.text
    assert MARKER not in client.get(f"/api/forms/{FORM}/definition").text


def test_kernel_warnings_and_hook_warnings_come_back_in_the_200(parts: Parts) -> None:
    def warn(candidate: Any) -> HookFindings:
        return HookFindings(warnings=(HookProblem("title", "title.short", "The title is short."),))

    datum, _ = make_datum(parts=parts, builder_save_validators=[warn])
    parts.sandbox.answer = verdict(structure_warnings=[finding("component.type.unknown", "root > content > name")])
    with TestClient(build_app(datum)) as running:
        reply = put(running, definition(FORM, "2"))
    assert reply.status_code == 200
    assert reply.json()["warnings"] == ["The title is short."]
    assert [(w["code"], w["where"]) for w in reply.json()["kernelWarnings"]] == [
        ("component.type.unknown", "root > content > name")
    ]


def test_a_hook_that_declines_is_its_kind_with_the_errors_body(parts: Parts) -> None:
    refusal = HookRefusedError.forbidden("save.notYours", "Not yours to change.")

    def customize(draft: Any) -> None:
        raise refusal

    datum, _ = make_datum(parts=parts, builder_save_customizers=[customize])
    with TestClient(build_app(datum)) as running:
        reply = put(running, definition(FORM, "2"))
    assert (reply.status_code, error_code(reply)) == (403, "save.notYours")
    assert reply.headers["cache-control"] == NO_STORE


def test_a_hook_that_raises_is_500_internal_with_the_correlation_id_logged_and_nothing_stored(
    parts: Parts, caplog: pytest.LogCaptureFixture
) -> None:
    def customize(draft: Any) -> None:
        raise RuntimeError(f"the hook failed {MARKER}")

    datum, _ = make_datum(parts=parts, builder_save_customizers=[customize])
    with TestClient(build_app(datum), raise_server_exceptions=False) as running, caplog.at_level(logging.ERROR):
        reply = put(running, definition(FORM, "2"))
        assert (reply.status_code, error_code(reply)) == (500, "internal")
        assert MARKER not in reply.text
        assert current_etag(running) == etag_of(parts.stored().definition)
    assert parts.stored().definition["version"] == "1"
    assert parts.events == []


def test_a_customizer_that_changes_the_id_is_500_internal(parts: Parts) -> None:
    def customize(draft: Any) -> None:
        draft.definition["id"] = "other"

    datum, _ = make_datum(parts=parts, builder_save_customizers=[customize])
    with TestClient(build_app(datum), raise_server_exceptions=False) as running:
        reply = put(running, definition(FORM, "2"))
    assert (reply.status_code, error_code(reply)) == (500, "internal")
    assert parts.stored().definition["version"] == "1"


@pytest.mark.parametrize("create", [False, True])
def test_the_principal_the_application_gave_reaches_the_hooks(parts: Parts, create: bool) -> None:
    seen: list[object] = []
    judged: list[object] = []

    def customize(draft: Any) -> None:
        seen.append(draft.principal)

    def validate(candidate: Any) -> HookFindings:
        judged.append(candidate.principal)
        return HookFindings()

    datum, _ = make_datum(parts=parts, builder_save_customizers=[customize], builder_save_validators=[validate])
    with TestClient(build_app(datum)) as running:
        if create:
            assert post(running, definition("fresh", "1")).status_code == 201
        else:
            assert put(running, definition(FORM, "2")).status_code == 200
    assert seen == ["person"]
    assert judged == ["person"]


def test_the_principal_the_application_gave_reaches_the_translations_save(
    parts: Parts, monkeypatch: pytest.MonkeyPatch
) -> None:
    seen: list[object] = []
    datum, _ = make_datum(parts=parts)
    inner = AsyncBuilderService.save_translations  # `async_builder` is a per-access property: patch the class

    async def spy(self: AsyncBuilderService, *args: Any, **kwargs: Any) -> Any:
        seen.append(kwargs.get("principal"))
        return await inner(self, *args, **kwargs)

    monkeypatch.setattr(AsyncBuilderService, "save_translations", spy)
    with TestClient(build_app(datum)) as running:
        assert put_catalog(running, {"fr": {"form": {"title": "un"}}}).status_code == 200
    assert seen == ["person"]


def test_a_read_only_repository_is_501_forms_read_only(parts: Parts) -> None:
    class Files:
        def current(self, key: str) -> Any:
            return parts.repository.current(key)

    datum, _ = make_datum(parts=parts, form_repository=Files())
    with TestClient(build_app(datum)) as running:
        reply = running.put(
            f"/api/forms/{FORM}",
            content=body_of(definition(FORM, "2")),
            headers={**WRITE, "If-Match": current_etag(running)},
        )
    assert (reply.status_code, error_code(reply)) == (501, "forms.readOnly")
    assert reply.headers["cache-control"] == NO_STORE


# -- If-Match at the route ----------------------------------------------------------------------------
def test_an_absent_if_match_saves_as_sent(client: TestClient, parts: Parts) -> None:
    reply = put(client, definition(FORM, "2"), etag=None)
    assert reply.status_code == 200
    assert parts.stored().definition["version"] == "2"


def test_star_passes_for_a_form_that_exists(client: TestClient) -> None:
    assert put(client, definition(FORM, "2"), etag="*").status_code == 200


@pytest.mark.parametrize("value", ["", "  ", "W/CURRENT", "unquoted", '"a" "b"', STALE, "*x", "W/"])
def test_a_present_if_match_that_is_empty_weak_unparseable_or_stale_is_409_with_the_current_etag(
    client: TestClient, parts: Parts, value: str
) -> None:
    current = current_etag(client)
    sent = f"W/{current}" if value == "W/CURRENT" else value
    reply = put(client, definition(FORM, "2"), etag=sent)
    assert (reply.status_code, error_code(reply)) == (409, "form.outdated")
    assert reply.headers["etag"] == current
    assert digest_of(parts.stored().definition) not in reply.text
    assert parts.stored().definition["version"] == "1"


@pytest.mark.anyio
async def test_combined_if_match_lines_are_one_list(parts: Parts) -> None:
    datum, _ = make_datum(parts=parts)
    app = build_app(datum)
    async with datum, async_client(app) as http:
        current = (await http.get(f"/api/forms/{FORM}/definition?public=false", headers=PERSON)).headers["etag"]
        lines = [("If-Match", STALE), ("If-Match", current), *WRITE.items()]
        ok = await http.put(f"/api/forms/{FORM}", content=body_of(definition(FORM, "2")), headers=lines)
        stale = await http.put(
            f"/api/forms/{FORM}",
            content=body_of(definition(FORM, "3")),
            headers=[("If-Match", STALE), ("If-Match", STALE), *WRITE.items()],
        )
    assert ok.status_code == 200
    assert stale.status_code == 409


@pytest.mark.parametrize(
    "extra",
    [
        {"If-None-Match": "*"},
        {"If-None-Match": "CURRENT"},
        {"If-Modified-Since": "Wed, 21 Oct 2099 07:28:00 GMT"},
        {"If-Unmodified-Since": "Wed, 21 Oct 1999 07:28:00 GMT"},
    ],
    ids=["none-match star", "none-match tag", "modified since", "unmodified since"],
)
def test_no_other_conditional_header_changes_a_write_and_none_makes_it_a_412_or_a_304(
    client: TestClient, extra: dict[str, str]
) -> None:
    sent = {key: current_etag(client) if value == "CURRENT" else value for key, value in extra.items()}
    reply = put(client, definition(FORM, "2"), etag=None, **sent)
    assert reply.status_code == 200


def test_no_write_is_ever_a_412(client: TestClient) -> None:
    statuses = {
        put(client, definition(FORM, "2"), etag=STALE, **{"If-None-Match": current_etag(client)}).status_code,
        put(client, b"{", etag=STALE).status_code,
        put(client, definition("other", "2")).status_code,
    }
    assert 412 not in statuses
    assert 304 not in statuses


def test_no_translations_write_is_ever_a_412_or_a_304(client: TestClient) -> None:
    current = client.get(f"/api/forms/{FORM}/translations").headers["etag"]
    for conditional in (current, "*"):
        reply = client.put(
            f"/api/forms/{FORM}/translations",
            content=body_of({"fr": {"form": {"title": "un"}}}),
            headers={**WRITE, "If-None-Match": conditional},
        )
        assert reply.status_code == 200
    stale = client.put(
        f"/api/forms/{FORM}/translations",
        content=body_of({"fr": {"form": {"title": "deux"}}}),
        headers={**WRITE, "If-Match": STALE, "If-None-Match": "*"},
    )
    assert stale.status_code == 409


# -- the language changes ---------------------------------------------------------------------------------------------
def test_the_locale_changes_header_moves_the_catalog_and_the_removed_locales_come_back_in_a_header(
    client: TestClient,
) -> None:
    catalog = {
        "fr": {"components": {"name": {"label": "Nom"}}},
        "de": {"components": {"name": {"label": "Name"}}},
    }
    kept = {"fr": {"components": {"name": {"label": "Nom"}}}}
    saved = client.put(f"/api/forms/{FORM}/translations", content=body_of({"catalog": catalog}), headers=WRITE)
    assert saved.status_code == 200
    changes = json.dumps({"removed": ["de"], "renamed": []})
    reply = put(client, definition(FORM, "2"), **{"X-Datum-Locale-Changes": changes})
    assert reply.status_code == 200
    assert [part.strip() for part in reply.headers["x-datum-removed-locales"].split(",")] == ["de"]
    assert reply.json()["catalog"] == kept
    assert client.get(f"/api/forms/{FORM}/translations").json() == kept


@pytest.mark.parametrize("value", ["not json", "[]", '{"removed":"de"}', '{"removed":["not a locale"]}', "x" * 9000])
def test_a_locale_changes_header_that_is_not_valid_is_400_bad_document_after_the_shape(
    client: TestClient, parts: Parts, value: str
) -> None:
    reply = put(client, definition(FORM, "2"), **{"X-Datum-Locale-Changes": value})
    assert (reply.status_code, error_code(reply)) == (400, "bad_document")
    assert parts.stored().definition["version"] == "1"
    assert parts.sandbox.checks == []


@pytest.mark.parametrize("value", ["not json", "[]", '{"removed":"de"}'])
def test_a_create_judges_a_malformed_locale_changes_header_as_400_bad_document(
    client: TestClient, parts: Parts, value: str
) -> None:
    reply = post(client, definition("fresh", "1"), **{"X-Datum-Locale-Changes": value})
    assert (reply.status_code, error_code(reply)) == (400, "bad_document")
    assert parts.repository.current("fresh") is None
    assert parts.sandbox.checks == []


def test_a_create_judges_the_shape_before_the_locale_changes_header(client: TestClient) -> None:
    reply = post(client, definition("not a key", "1"), **{"X-Datum-Locale-Changes": "not json"})
    assert reply.status_code == 422


def test_a_create_with_a_valid_locale_changes_header_is_201_and_moves_nothing(client: TestClient, parts: Parts) -> None:
    reply = post(client, definition("fresh", "1"), **{"X-Datum-Locale-Changes": '{"removed":["de"]}'})
    assert reply.status_code == 201
    assert "x-datum-removed-locales" not in reply.headers
    assert parts.stored("fresh").definition == definition("fresh", "1")


def test_the_shape_is_judged_before_the_locale_changes_header(client: TestClient) -> None:
    reply = put(client, definition("other", "2"), **{"X-Datum-Locale-Changes": "not json"})
    assert reply.status_code == 422


def test_the_locale_changes_header_is_ignored_on_the_translations_route(client: TestClient) -> None:
    reply = client.put(
        f"/api/forms/{FORM}/translations",
        content=body_of({"catalog": {"fr": {"form": {"title": "un"}}}}),
        headers={**WRITE, "X-Datum-Locale-Changes": "not json"},
    )
    assert reply.status_code == 200


# -- POST /forms ------------------------------------------------------------------------------------------------------
def test_a_create_is_201_with_the_etag_and_the_location_of_the_author_copy(client: TestClient, parts: Parts) -> None:
    sent = definition("fresh", "1")
    reply = post(client, sent)
    assert reply.status_code == 201
    assert reply.headers["etag"] == etag_of(sent) == f'"{reply.json()["sha256"]}"'
    assert reply.headers["location"] == "/api/forms/fresh/definition?public=false"
    assert reply.headers["cache-control"] == NO_STORE
    assert parts.stored("fresh").definition == sent
    assert current_etag(client, "fresh") == reply.headers["etag"]
    follow = client.get(reply.headers["location"], headers=PERSON)
    assert follow.status_code == 200


def test_a_create_takes_no_precondition_and_a_stray_if_match_changes_nothing(client: TestClient) -> None:
    for number, value in enumerate((STALE, "*", "", "W/x")):
        reply = post(client, definition(f"fresh-{number}", "1"), **{"If-Match": value})
        assert reply.status_code == 201, value


def test_a_create_of_an_id_that_exists_is_409_form_exists_with_no_etag_and_no_hash(
    client: TestClient, parts: Parts
) -> None:
    reply = post(client, definition(FORM, "7"))
    assert (reply.status_code, error_code(reply)) == (409, "form.exists")
    assert "etag" not in reply.headers
    assert digest_of(parts.stored().definition) not in reply.text
    assert reply.headers["cache-control"] == NO_STORE
    assert parts.stored().definition["version"] == "1"


def test_a_create_has_no_existence_step_and_the_same_body_rules(client: TestClient, parts: Parts) -> None:
    assert post(client, b"{").status_code == 400
    assert client.post("/api/forms", content=b"{}", headers={**PERSON, "Content-Type": "text/plain"}).status_code == 415
    bad = definition("not a key", "1")
    assert post(client, bad).status_code == 422
    assert "definition.id.invalid" in [item["code"] for item in post(client, bad).json()["errors"]]
    assert parts.sandbox.checks == []


def test_a_create_over_the_cap_is_413(parts: Parts) -> None:
    datum, _ = make_datum(config(builder={"max_definition_size": "1KiB"}), parts=parts)
    big = definition("fresh", "1")
    big["notes"] = "x" * 5000
    with TestClient(build_app(datum)) as running:
        reply = running.post("/api/forms", content=body_of(big), headers=WRITE)
    assert (reply.status_code, error_code(reply)) == (413, "bad_document")


def test_a_create_over_a_read_only_repository_is_501(parts: Parts) -> None:
    class Files:
        def current(self, key: str) -> Any:
            return parts.repository.current(key)

    datum, _ = make_datum(parts=parts, form_repository=Files())
    with TestClient(build_app(datum)) as running:
        reply = running.post("/api/forms", content=body_of(definition("fresh", "1")), headers=WRITE)
    assert (reply.status_code, error_code(reply)) == (501, "forms.readOnly")


# -- PUT /forms/{key}/translations ------------------------------------------------------------------------------------
def catalog_etag_now(client: TestClient) -> str:
    return str(client.get(f"/api/forms/{FORM}/translations").headers["etag"])


def put_catalog(
    client: TestClient, value: Any, *, etag: str | None = "current", key: str = FORM, **headers: str
) -> Any:
    sent = {**WRITE, **headers}
    if etag == "current":
        sent["If-Match"] = str(client.get(f"/api/forms/{key}/translations").headers["etag"])
    elif etag is not None:
        sent["If-Match"] = etag
    content = value if isinstance(value, bytes) else body_of(value)
    return client.put(f"/api/forms/{key}/translations", content=content, headers=sent)


NAME_FR = {"fr": {"components": {"name": {"label": "Nom"}}}}


def test_a_catalog_is_saved_with_the_etag_of_the_catalog_and_read_back_by_the_public_route(client: TestClient) -> None:
    first_etag = catalog_etag_now(client)  # the ETag of {} for a form with no catalog
    reply = put_catalog(client, {"catalog": NAME_FR}, etag=first_etag)
    assert reply.status_code == 200
    assert reply.json()["catalog"] == NAME_FR
    assert reply.headers["cache-control"] == NO_STORE
    read = client.get(f"/api/forms/{FORM}/translations")
    assert read.json() == NAME_FR
    assert read.headers["etag"] == reply.headers["etag"] != first_etag


def test_the_bare_catalog_is_accepted_as_well_as_the_wrapped_one(client: TestClient) -> None:
    assert put_catalog(client, {"fr": {"form": {"title": "A"}}}).status_code == 200
    assert put_catalog(client, {"catalog": {"fr": {"form": {"title": "B"}}}}).status_code == 200
    assert client.get(f"/api/forms/{FORM}/translations").json() == {"fr": {"form": {"title": "B"}}}


def test_a_bare_catalog_whose_only_locale_is_named_catalog_is_not_taken_for_a_wrapper(client: TestClient) -> None:
    bare = {"catalog": {"form": {"title": "B"}}}
    assert put_catalog(client, bare).status_code == 200
    assert client.get(f"/api/forms/{FORM}/translations").json() == bare


def test_a_refused_catalog_names_the_offence_as_a_json_pointer_in_the_items(client: TestClient) -> None:
    reply = put_catalog(client, {"fr": {"components": {"name": {"messages": {"required": 7}}}}})
    assert (reply.status_code, error_code(reply)) == (422, "catalog.invalid")
    assert "/fr/components/name/messages/required" in reply.text


@pytest.mark.parametrize("held", [{"If-Match": "*"}, {"If-Match": STALE}, {}])
def test_a_form_nobody_has_is_404_for_its_translations_before_the_body_is_read(
    client: TestClient, parts: Parts, held: dict[str, str]
) -> None:
    for sent in ({"Content-Type": "text/plain"}, {"Content-Type": "application/json"}):
        reply = client.put(
            "/api/forms/nope/translations",
            content=body_of({"fr": {"form": {"title": "x"}}}),
            headers={**PERSON, **sent, **held},
        )
        assert (reply.status_code, error_code(reply)) == (404, "form.notFound"), sent
        assert "etag" not in reply.headers
        assert reply.headers["cache-control"] == NO_STORE
    assert parts.sandbox.checks == []


def test_the_translations_order_is_415_413_409_400_then_the_catalog(client: TestClient) -> None:
    current = catalog_etag_now(client)
    assert (
        client.put(
            f"/api/forms/{FORM}/translations", content=b"{}", headers={**PERSON, "Content-Type": "text/plain"}
        ).status_code
        == 415
    )
    assert put_catalog(client, b"{", etag=STALE).status_code == 409
    assert put_catalog(client, b"{", etag=current).status_code == 400
    assert put_catalog(client, b"{", etag=None).status_code == 400
    invalid = put_catalog(client, {"catalog": {"1bad": {"fr": "x"}}}, etag=current)
    assert (invalid.status_code, error_code(invalid)) == (422, "catalog.invalid")


def test_a_stale_catalog_etag_is_409_with_the_current_catalog_etag(client: TestClient) -> None:
    first = put_catalog(client, {"fr": {"form": {"title": "un"}}})
    stale = put_catalog(client, {"fr": {"form": {"title": "deux"}}}, etag='"' + "1" * 64 + '"')
    assert (stale.status_code, error_code(stale)) == (409, "form.outdated")
    assert stale.headers["etag"] == first.headers["etag"]
    assert stale.headers["cache-control"] == NO_STORE
    held = first.headers["etag"]
    assert held not in stale.text
    assert held.strip('"') not in stale.text


def test_an_absent_catalog_etag_and_star_are_the_unconditional_save(client: TestClient) -> None:
    assert put_catalog(client, {"fr": {"form": {"title": "un"}}}, etag=None).status_code == 200
    assert put_catalog(client, {"fr": {"form": {"title": "deux"}}}, etag="*").status_code == 200


def test_a_definition_hash_is_not_a_catalog_etag(client: TestClient) -> None:
    reply = put_catalog(client, {"fr": {"form": {"title": "un"}}}, etag=current_etag(client))
    assert (reply.status_code, error_code(reply)) == (409, "form.outdated")


def test_a_full_translation_store_is_503_unavailable(parts: Parts) -> None:
    store = MemoryTranslationCatalogStore(1)
    assert store.write("other", {"fr": {"form": {"title": "un"}}}, expected_etag=catalog_etag({})) is not None
    datum, _ = make_datum(parts=parts, translation_store=store)
    with TestClient(build_app(datum)) as running:
        reply = put_catalog(running, {"fr": {"form": {"title": "deux"}}})
    assert (reply.status_code, error_code(reply)) == (503, "server.unavailable")
    assert "retry-after" not in reply.headers


def test_the_translations_route_has_no_hook_and_no_kernel_run(parts: Parts) -> None:
    calls: list[str] = []

    def customize(draft: Any) -> None:
        calls.append("customizer")

    datum, _ = make_datum(parts=parts, builder_save_customizers=[customize])
    with TestClient(build_app(datum)) as running:
        assert put_catalog(running, {"fr": {"form": {"title": "un"}}}).status_code == 200
    assert calls == []
    assert parts.sandbox.checks == []
    assert parts.events == []


# -- concurrency ------------------------------------------------------------------------------------------------------
@pytest.mark.anyio
async def test_eight_concurrent_puts_on_one_hash_give_one_200_and_seven_409_with_the_winners_etag() -> None:
    parts = Parts()
    datum, _ = make_datum(config(runtime={"worker_threads": 16}), parts=parts)
    app = build_app(datum)
    async with datum, async_client(app) as http:
        for round_ in range(5):
            current = (await http.get(f"/api/forms/{FORM}/definition?public=false", headers=PERSON)).headers["etag"]
            gate = anyio.Event()
            replies: list[httpx2.Response] = []

            async def one(
                number: int,
                current: str = current,
                gate: anyio.Event = gate,
                round_: int = round_,
                replies: list[httpx2.Response] = replies,
            ) -> None:
                await gate.wait()
                replies.append(
                    await http.put(
                        f"/api/forms/{FORM}",
                        content=body_of(definition(FORM, f"r{round_}-{number}")),
                        headers={**WRITE, "If-Match": current},
                    )
                )

            async with anyio.create_task_group() as group:
                for number in range(8):
                    group.start_soon(one, number)
                await anyio.sleep(0.05)
                gate.set()
            statuses = sorted(reply.status_code for reply in replies)
            assert statuses == [200] + [409] * 7, f"round {round_}: {statuses}"
            winner = next(reply for reply in replies if reply.status_code == 200)
            assert {reply.headers["etag"] for reply in replies if reply.status_code == 409} == {winner.headers["etag"]}
            after = (await http.get(f"/api/forms/{FORM}/definition?public=false", headers=PERSON)).headers["etag"]
            assert after == winner.headers["etag"]
    assert len(parts.events) == 5


async def _race(http: httpx2.AsyncClient, send: Any) -> list[httpx2.Response]:
    gate = anyio.Event()
    replies: list[httpx2.Response] = []

    async def one(number: int) -> None:
        await gate.wait()
        replies.append(await send(number))

    async with anyio.create_task_group() as group:
        for number in range(8):
            group.start_soon(one, number)
        await anyio.sleep(0.05)
        gate.set()
    return replies


@pytest.mark.anyio
@pytest.mark.parametrize("sent", ["absent", "star", "hash"])
@pytest.mark.parametrize("write", ["saveForm", "saveFormTranslations"])
async def test_eight_racers_on_a_write_follow_the_one_rule_for_absent_star_and_a_present_hash(
    write: str, sent: str
) -> None:
    """Absent and `*` are the unconditional save (eight 200s); a present hash is a compare-and-set."""
    translations = write == "saveFormTranslations"
    recorded: list[str] = []

    class RecordingStore(MemoryTranslationCatalogStore):
        def write(self, key: str, catalog: Any, *, expected_etag: str) -> Any:
            result = super().write(key, catalog, expected_etag=expected_etag)
            if result is not None:
                recorded.append(result.etag)
            return result

    parts = Parts()
    seams: dict[str, Any] = {"translation_store": RecordingStore()} if translations else {}
    datum, _ = make_datum(config(runtime={"worker_threads": 16}), parts=parts, **seams)
    reading = f"/api/forms/{FORM}/translations" if translations else f"/api/forms/{FORM}/definition?public=false"
    async with datum, async_client(build_app(datum)) as http:
        for round_ in range(3):
            current = (await http.get(reading, headers=PERSON)).headers["etag"]
            held = {"hash": {"If-Match": current}, "star": {"If-Match": "*"}, "absent": {}}[sent]
            saved_before = len(parts.events)
            recorded.clear()

            async def send(number: int, held: dict[str, str] = held, round_: int = round_) -> httpx2.Response:
                if translations:
                    content = body_of({"fr": {"form": {"title": f"r{round_}-{number}"}}})
                    return await http.put(f"/api/forms/{FORM}/translations", content=content, headers={**WRITE, **held})
                content = body_of(definition(FORM, f"r{round_}-{number}"))
                return await http.put(f"/api/forms/{FORM}", content=content, headers={**WRITE, **held})

            replies = await _race(http, send)
            statuses = sorted(reply.status_code for reply in replies)
            winners = [reply for reply in replies if reply.status_code == 200]
            final = (await http.get(reading, headers=PERSON)).headers["etag"]
            if sent == "hash":
                assert statuses == [200] + [409] * 7, f"round {round_}: {statuses}"
                assert {r.headers["etag"] for r in replies if r.status_code == 409} == {winners[0].headers["etag"]}
                assert final == winners[0].headers["etag"]
                continue
            assert statuses == [200] * 8, f"round {round_}: {statuses}"
            won = {reply.headers["etag"] for reply in winners}
            if translations:
                assert len(recorded) == 8, f"round {round_}: {recorded}"
                assert set(recorded) == won
                assert final == recorded[-1]
                continue
            saved = [e for e in parts.events[saved_before:] if isinstance(e, FormDefinitionSavedEvent)]
            assert len(saved) == 8, f"round {round_}: {len(saved)}"
            assert {f'"{event.sha256}"' for event in saved} == won
            # publication may be out of store order; `previous_sha256` orders them into one chain with no gap
            by_previous = {event.previous_sha256: event for event in saved}
            assert len(by_previous) == 8
            link: str | None = current.strip('"')
            chain = []
            while link in by_previous:
                chain.append(by_previous[link])
                link = by_previous[link].sha256
            assert len(chain) == 8, f"round {round_}: the saves are not one chain"
            assert final == f'"{chain[-1].sha256}"'


# -- problem details and the group document ---------------------------------------------------------------------------
def test_the_builders_refusals_follow_the_problem_details_mode(parts: Parts) -> None:
    datum, _ = make_datum(config(web={"api": {"problem_details": True}}), parts=parts)
    with TestClient(build_app(datum)) as running:
        stale = put(running, definition(FORM, "2"), etag=STALE)
        refused = put(running, definition("other", "2"))
        missing = running.put("/api/forms/nope", content=b"{}", headers=WRITE)
    for reply, status, code in (
        (stale, 409, "form.outdated"),
        (refused, 422, "definition.id.mismatch"),
        (missing, 404, "form.notFound"),
    ):
        assert reply.status_code == status
        assert reply.headers["content-type"].startswith("application/problem+json")
        assert reply.json()["code"] == code
        assert reply.headers["cache-control"] == NO_STORE
    assert stale.headers["etag"]
    assert "kernel" in refused.json()


def test_the_group_document_holds_the_three_operations_only_and_hides_the_author_copy(parts: Parts) -> None:
    datum, _ = make_datum(config(web={"openapi": {"group_documents": True}}), parts=parts)
    with TestClient(build_app(datum)) as running:
        assert running.get("/api/openapi/builder.json").status_code == 401  # privileged like the routes it describes
        reply = running.get("/api/openapi/builder.json", headers=PERSON)
        assert reply.status_code == 200
        document = reply.json()
        assert set(document["paths"]) == {"/api/forms", "/api/forms/{key}", "/api/forms/{key}/translations"}
        assert {op["operationId"] for item in document["paths"].values() for op in item.values()} == set(OPERATIONS)
        assert "/api/openapi/builder.json" not in running.get("/openapi.json").json()["paths"]


def test_the_application_document_carries_the_if_match_parameter_on_the_two_writes_and_the_headers(
    parts: Parts,
) -> None:
    datum, _ = make_datum(parts=parts)
    with TestClient(build_app(datum)) as running:
        document = running.get("/openapi.json").json()
    save = document["paths"]["/api/forms/{key}"]["put"]
    create = document["paths"]["/api/forms"]["post"]
    translations = document["paths"]["/api/forms/{key}/translations"]["put"]
    assert "If-Match" in [p["name"] for p in save["parameters"] if p["in"] == "header"]
    assert "If-Match" in [p["name"] for p in translations["parameters"] if p["in"] == "header"]
    assert "If-Match" not in [p["name"] for p in create.get("parameters", [])]
    assert {"ETag", "X-Datum-Removed-Locales"} <= set(save["responses"]["200"]["headers"])
    assert {"ETag", "Location"} <= set(create["responses"]["201"]["headers"])
    assert "ETag" in save["responses"]["409"]["headers"]
    for operation in (save, create, translations):
        assert "default" in operation["responses"]
        assert operation["requestBody"]["required"] is True
        assert "application/json" in operation["requestBody"]["content"]
