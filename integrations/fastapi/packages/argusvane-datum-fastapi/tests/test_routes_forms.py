"""The three forms routes against the catalog rows and their wire side."""

import json
import re
from collections.abc import Iterator
from typing import Any

import pytest
from datum_fakes import (
    SECRET_MARKER,
    StubRepository,
    StubRuntime,
    StubSandbox,
    config,
    definition,
    refusing,
    runtime_of,
    sandbox_of,
)
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from datum_core.forms import DataSourceRequest, DefinitionDraft
from datum_core.hooks import HookRefusedError
from datum_core.stores.memory import MemoryTranslationCatalogStore
from datum_fastapi import Datum, routers
from datum_sandbox.protocol import DefinitionTooDeepError, ProgramUnavailableError

FORM = "contact"
CATALOG = {"fr": {"components": {"name": {"label": "Nom"}}}, "en": {"components": {"name": {"label": "Name"}}}}


class Countries:
    def __init__(self) -> None:
        self.asked: list[DataSourceRequest] = []

    def exists(self, source_id: str) -> bool:
        return source_id in {"countries", "broken"}

    def items(self, request: DataSourceRequest) -> list[dict[str, str]]:
        self.asked.append(request)
        if request.source_id == "broken":
            raise RuntimeError("the source is down")
        return [{"value": "ca", "label": "Canada"}]


def make_datum(**seams: Any) -> Datum:
    seams.setdefault("config", config())
    seams.setdefault("data_sources", [Countries()])
    seams.setdefault("form_repository", StubRepository(definition(FORM, secret=True)))
    seams.setdefault("runtime", runtime_of(StubRuntime()))
    seams.setdefault("sandbox", sandbox_of(StubSandbox()))
    translations = MemoryTranslationCatalogStore()
    translations.put(FORM, CATALOG)
    return Datum(
        translation_store=translations,
        **seams,
    )


def app_of(datum: Datum, **router_kwargs: Any) -> FastAPI:
    app = FastAPI()
    app.include_router(routers.forms(datum, **router_kwargs))
    return app


@pytest.fixture
def client() -> Iterator[TestClient]:
    with TestClient(app_of(make_datum())) as client:
        yield client


def code(reply: Any) -> str:
    return str(reply.json()["errors"][0]["code"])


# ---- getFormDefinition: 200 {ETag}, 304 {ETag}, 400 [bad_request], 403 [access.denied], 404 [form.notFound] --------
@pytest.mark.parametrize("key", [FORM, f"{FORM}@1", f"{FORM}%401"])
def test_the_definition_is_200_json_with_a_strong_etag_and_never_the_server_secret_rule(
    client: TestClient, key: str
) -> None:
    reply = client.get(f"/api/forms/{key}/definition")
    assert reply.status_code == 200
    assert reply.headers["content-type"].split(";")[0].endswith("json")
    assert re.fullmatch(r'"[0-9a-f]{64}"', reply.headers["etag"])
    assert "server-secret" not in reply.text
    assert SECRET_MARKER not in reply.text
    assert reply.json()["id"] == FORM


def test_a_version_that_is_not_current_is_404_form_not_found(client: TestClient) -> None:
    reply = client.get(f"/api/forms/{FORM}%402/definition")
    assert reply.status_code == 404
    assert code(reply) == "form.notFound"


def test_a_form_that_does_not_exist_is_404_form_not_found(client: TestClient) -> None:
    reply = client.get("/api/forms/datum-tck-no-such-form/definition")
    assert (reply.status_code, code(reply)) == (404, "form.notFound")
    assert reply.headers["content-type"].startswith("application/json")


def test_a_key_that_is_no_form_key_is_404_without_reaching_the_repository() -> None:
    class Exploding(StubRepository):
        def current(self, key: str) -> Any:
            raise AssertionError(key)

    with TestClient(app_of(make_datum(form_repository=Exploding()))) as client:
        assert client.get("/api/forms/a%20b/definition").status_code == 404


def test_if_none_match_earns_a_304_with_the_same_etag_and_an_empty_body(client: TestClient) -> None:
    first = client.get(f"/api/forms/{FORM}/definition")
    again = client.get(f"/api/forms/{FORM}/definition", headers={"If-None-Match": first.headers["etag"]})
    assert again.status_code == 304
    assert again.headers["etag"] == first.headers["etag"]
    assert again.content == b""


def test_a_stale_if_none_match_is_a_200(client: TestClient) -> None:
    assert client.get(f"/api/forms/{FORM}/definition", headers={"If-None-Match": '"stale"'}).status_code == 200


def test_the_cache_control_is_the_forms_cache_definition_setting() -> None:
    cfg = config(forms={"cache": {"definition": "private, max-age=60"}})
    with TestClient(app_of(make_datum(config=cfg))) as client:
        first = client.get(f"/api/forms/{FORM}/definition")
        assert first.headers["cache-control"] == "private, max-age=60"
        again = client.get(f"/api/forms/{FORM}/definition", headers={"If-None-Match": first.headers["etag"]})
        assert again.headers["cache-control"] == "private, max-age=60"


def test_the_default_cache_control_is_no_store(client: TestClient) -> None:
    assert client.get(f"/api/forms/{FORM}/definition").headers["cache-control"] == "no-store"


def test_the_public_route_has_no_public_parameter_so_the_authors_copy_is_never_served(client: TestClient) -> None:
    """`public` is not a parameter; asking for it gets the public copy, byte for byte.

    The spellings of `public=false` are the one exception: the public route yields them, so
    without the builder router they are the application's 404 (`test_routes_author_copy.py`).
    """
    plain = client.get(f"/api/forms/{FORM}/definition")
    for value in ("0", "true", "maybe"):
        reply = client.get(f"/api/forms/{FORM}/definition", params={"public": value})
        assert reply.status_code == 200, value
        assert reply.content == plain.content, value
        assert "server-secret" not in reply.text


def test_an_application_dependency_that_refuses_with_403_reaches_the_wire_untouched() -> None:
    app = app_of(make_datum(), dependencies=[Depends(refusing(403, "guard"))])
    with TestClient(app) as client:
        reply = client.get(f"/api/forms/{FORM}/definition")
    assert (reply.status_code, reply.json()) == (403, {"detail": "guard refused"})


def test_an_application_dependency_that_refuses_with_401_reaches_the_wire_untouched() -> None:
    app = app_of(make_datum(), dependencies=[Depends(refusing(401, "guard"))])
    with TestClient(app) as client:
        reply = client.get("/api/forms/x/translations")
    assert (reply.status_code, reply.json()) == (401, {"detail": "guard refused"})


@pytest.mark.parametrize(
    ("refusal", "status"),
    [
        (HookRefusedError.forbidden("not.yours", "Not for you."), 403),
        (HookRefusedError.conflict("busy.now", "Come back later."), 409),
        (HookRefusedError.invalid("bad.shape", "Wrong shape."), 422),
    ],
)
def test_a_customizer_refusal_answers_by_its_kind_with_the_hooks_code(refusal: HookRefusedError, status: int) -> None:
    def refuse(draft: DefinitionDraft) -> None:
        raise refusal

    class Refusing:
        def __call__(self, draft: DefinitionDraft) -> None:
            refuse(draft)

        def cache_key(self, request: Any) -> str | None:
            return None

    with TestClient(app_of(make_datum(definition_customizers=[Refusing()]))) as client:
        reply = client.get(f"/api/forms/{FORM}/definition")
    assert reply.status_code == status
    assert reply.json()["errors"][0]["code"] == refusal.problems[0].code


# ---- getFormTranslations: 200 {ETag}, 304 {ETag}, 403, 404 [form.notFound] -----------------------------------------
def test_the_translations_are_200_with_the_stores_etag(client: TestClient) -> None:
    reply = client.get(f"/api/forms/{FORM}/translations")
    assert reply.status_code == 200
    assert reply.json() == CATALOG
    assert re.fullmatch(r'"[0-9a-f]{64}"', reply.headers["etag"])


def test_the_translations_earn_a_304_for_a_matching_if_none_match(client: TestClient) -> None:
    first = client.get(f"/api/forms/{FORM}/translations")
    again = client.get(f"/api/forms/{FORM}/translations", headers={"If-None-Match": first.headers["etag"]})
    assert again.status_code == 304
    assert again.headers["etag"] == first.headers["etag"]
    assert again.content == b""


def test_the_translations_of_a_form_that_does_not_exist_are_404_form_not_found(client: TestClient) -> None:
    reply = client.get("/api/forms/missing/translations")
    assert (reply.status_code, code(reply)) == (404, "form.notFound")


# ---- getDataSourceItems: 200, 403, 404 [data_source.notFound], 503 [... data_source.unavailable] {Retry-After} -------
def test_a_data_source_answers_its_items(client: TestClient) -> None:
    reply = client.get("/api/data-sources/countries", params={"locale": "fr", "form": FORM})
    assert reply.status_code == 200
    assert reply.json() == {"items": [{"value": "ca", "label": "Canada"}]}


def test_the_provider_is_asked_with_the_id_the_form_the_locale_and_the_rest_of_the_query() -> None:
    countries = Countries()
    datum = make_datum(data_sources=[countries])
    with TestClient(app_of(datum)) as client:
        client.get("/api/data-sources/countries", params={"locale": "fr", "form": FORM, "region": "north"})
        client.get("/api/data-sources/countries", headers={"Accept-Language": "de;q=0.9, en;q=0.5"})
    (first, second) = countries.asked
    assert (first.source_id, first.form_key, first.locale) == ("countries", FORM, "fr")
    assert dict(first.query) == {"region": "north"}  # `locale` and `form` are the route's own, not passed on twice
    assert (second.form_key, second.locale, dict(second.query)) == (None, "de", {})  # the negotiated locale


def test_an_unknown_data_source_is_404_data_source_not_found(client: TestClient) -> None:
    reply = client.get("/api/data-sources/nope")
    assert (reply.status_code, code(reply)) == (404, "data_source.notFound")


def test_a_data_source_that_fails_is_503_data_source_unavailable_with_no_retry_after(client: TestClient) -> None:
    reply = client.get("/api/data-sources/broken")
    assert reply.status_code == 503
    assert code(reply) == "data_source.unavailable"
    assert "retry-after" not in reply.headers
    assert "down" not in reply.text  # the source's own words never reach the wire


def test_data_sources_follow_their_own_switch() -> None:
    only_definition = config(definition_route=False, web={"api": {"endpoints": {"definition": True}}})
    assert only_definition.web.api.endpoints.data_sources is False
    with TestClient(app_of(make_datum(config=only_definition))) as client:
        assert client.get(f"/api/forms/{FORM}/definition").status_code == 200
        assert client.get("/api/data-sources/countries").status_code == 404


def test_the_json_error_body_is_the_documented_shape(client: TestClient) -> None:
    body = json.loads(client.get("/api/forms/missing/definition").content)
    assert set(body) == {"errors"}
    assert set(body["errors"][0]) <= {"field", "code", "message"}


# ---- wire rows: the sandbox outcomes the definition route maps ---------------------------------------------------
class RaisingSandbox(StubSandbox):
    def __init__(self, error: Exception) -> None:
        super().__init__()
        self.error = error

    def public_copy(self, definition: Any) -> Any:
        raise self.error


def test_secret_rules_while_the_runtime_is_down_answer_503_with_no_retry_after() -> None:
    sandbox = RaisingSandbox(ProgramUnavailableError("down"))
    datum = make_datum(sandbox=sandbox_of(sandbox))
    with TestClient(app_of(datum)) as client:
        reply = client.get(f"/api/forms/{FORM}/definition")
    assert (reply.status_code, code(reply)) == (503, "server.unavailable")
    assert "retry-after" not in reply.headers


def test_a_definition_nested_too_deep_answers_422_definition_too_deep() -> None:
    sandbox = RaisingSandbox(DefinitionTooDeepError(256, "too deep"))
    datum = make_datum(sandbox=sandbox_of(sandbox))
    with TestClient(app_of(datum)) as client:
        reply = client.get(f"/api/forms/{FORM}/definition")
    assert (reply.status_code, code(reply)) == (422, "definition.tooDeep")
