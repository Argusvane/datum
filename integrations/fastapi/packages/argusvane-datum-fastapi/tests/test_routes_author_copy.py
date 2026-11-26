"""The author's copy: `GET /api/forms/{key}/definition?public=false` (the contract's path), served by `routers.builder`.

The unredacted copy is reachable only through the privileged builder factory, through a
route class whose `matches()` accepts the `public=false` query; the public forms route's matcher yields that query, so
the order the two routers are included in never matters. The public copy is never served for a `public=false` spelling:
once the builder claims the query the application's dependencies run first (401 or 403 before anything is read), and
without the builder (or with its switch off) the query is the application's own 404.
"""

from typing import Any

import pytest
from builder_fakes import (
    FORM,
    MARKER,
    OTHER,
    PERSON,
    Parts,
    build_app,
    config,
    etag_of,
    make_datum,
)
from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.routing import Match
from trace_log import TRACE

from datum_fastapi import routers

PATH = f"/api/forms/{FORM}/definition"
CLAIMED = [
    "public=false",
    "public=FALSE",
    "public=False",
    "public=false&public=false",
    "public=true&public=false",
    "public=false&public=true",
    "public=%66alse",
    "public=fa%6cse",
    "public=%46ALSE",
    "locale=fr&public=false",
    "public=false&locale=fr",
]
OPEN = ["", "public=true", "public=0", "locale=fr", "other=false", "public%5B%5D=false"]
DOUBTFUL = ["public=", "public=no", "public=falsey", "public=false%20", "public=%20false", "Public=false"]
NOT_FOUND = {"detail": "Not Found"}


def secret_parts() -> Parts:
    return Parts(secret=True)


def get(client: TestClient, query: str, **headers: str) -> Any:
    url = PATH + (f"?{query}" if query else "")
    return client.get(url, headers=headers)


def app_with(parts: Parts, *, builder_first: bool = False, builder: bool = True, switch: bool = True) -> FastAPI:
    datum, _ = make_datum(config(builder={"enabled": switch}), parts=parts)
    return build_app(datum, builder=builder, builder_first=builder_first)


# -- once claimed -----------------------------------------------------------------------------------------------------
@pytest.mark.parametrize("builder_first", [False, True], ids=["forms first", "builder first"])
@pytest.mark.parametrize("query", CLAIMED)
def test_a_public_false_query_gets_the_applications_refusal_before_anything_is_read(
    query: str, builder_first: bool
) -> None:
    parts = secret_parts()
    with TestClient(app_with(parts, builder_first=builder_first)) as client:
        visitor = get(client, query)
        other = get(client, query, **OTHER)
    assert (visitor.status_code, visitor.json()) == (401, {"detail": "sign in"})
    assert (other.status_code, other.json()) == (403, {"detail": "not you"})
    assert TRACE == ["persona", "persona"]
    assert MARKER not in visitor.text + other.text
    assert parts.sandbox.public_copies == 0  # the public handler never ran


@pytest.mark.parametrize("builder_first", [False, True], ids=["forms first", "builder first"])
@pytest.mark.parametrize("query", CLAIMED)
def test_the_person_gets_the_author_copy_with_its_etag_and_no_store_and_the_public_handler_never_runs(
    query: str, builder_first: bool
) -> None:
    parts = secret_parts()
    with TestClient(app_with(parts, builder_first=builder_first)) as client:
        reply = get(client, query, **PERSON)
    assert reply.status_code == 200
    assert MARKER in reply.text
    assert reply.headers["etag"] == etag_of(parts.stored().definition)
    assert reply.headers["cache-control"] == "no-store"
    assert reply.headers["content-type"].startswith("application/json")
    assert parts.sandbox.public_copies == 0


def test_the_include_order_changes_neither_answer_for_any_spelling() -> None:
    results: dict[bool, dict[str, tuple[int, str]]] = {}
    for builder_first in (False, True):
        parts = secret_parts()
        results[builder_first] = {}
        with TestClient(app_with(parts, builder_first=builder_first)) as client:
            for query in (*CLAIMED, *OPEN, *DOUBTFUL):
                for who in ({}, OTHER, PERSON):
                    reply = get(client, query, **who)
                    results[builder_first][f"{query}|{sorted(who.items())}"] = (reply.status_code, reply.text)
    assert results[False] == results[True]


def test_the_two_matchers_partition_the_queries_so_exactly_one_route_takes_a_request() -> None:
    datum, _ = make_datum()
    public = next(r for r in routers.forms(datum).routes if getattr(r, "path", "") == "/api/forms/{key}/definition")
    author = next(
        r
        for r in routers.builder(datum, dependencies=[]).routes
        if getattr(r, "path", "") == "/api/forms/{key}/definition"
    )
    for query in (*CLAIMED, *OPEN, *DOUBTFUL):
        scope = {
            "type": "http",
            "method": "GET",
            "path": PATH,
            "root_path": "",
            "query_string": query.encode(),
            "headers": [],
        }
        matches = [route.matches(scope)[0] is Match.FULL for route in (public, author)]
        assert matches.count(True) == 1, (query, matches)
    for query in CLAIMED:
        scope = {
            "type": "http",
            "method": "GET",
            "path": PATH,
            "root_path": "",
            "query_string": query.encode(),
            "headers": [],
        }
        assert author.matches(scope)[0] is Match.FULL, query
        assert public.matches(scope)[0] is not Match.FULL, query


@pytest.mark.parametrize("query", CLAIMED)
def test_an_unknown_form_is_404_for_the_person_and_still_401_for_a_visitor(query: str) -> None:
    parts = secret_parts()
    with TestClient(app_with(parts)) as client:
        visitor = client.get(f"/api/forms/nope/definition?{query}")
        person = client.get(f"/api/forms/nope/definition?{query}", headers=PERSON)
    assert visitor.status_code == 401
    assert (person.status_code, person.json()["errors"][0]["code"]) == (404, "form.notFound")
    assert person.headers["cache-control"] == "no-store"
    assert "nope" not in person.text


# -- the spellings in doubt never leak --------------------------------------------------------------------------------
@pytest.mark.parametrize("builder_first", [False, True], ids=["forms first", "builder first"])
@pytest.mark.parametrize("query", [*CLAIMED, *OPEN, *DOUBTFUL])
def test_whatever_the_spelling_a_visitor_never_sees_the_unredacted_copy(query: str, builder_first: bool) -> None:
    parts = secret_parts()
    with TestClient(app_with(parts, builder_first=builder_first)) as client:
        reply = get(client, query)
    assert MARKER not in reply.text
    assert reply.status_code in {200, 401}


@pytest.mark.parametrize("query", OPEN)
def test_a_query_that_is_not_public_false_is_the_public_route_and_runs_no_persona(query: str) -> None:
    parts = secret_parts()
    with TestClient(app_with(parts)) as client:
        reply = get(client, query)
    assert reply.status_code == 200
    assert MARKER not in reply.text
    assert TRACE == []
    assert parts.sandbox.public_copies == 1


# -- without the builder ----------------------------------------------------------------------------------------------
@pytest.mark.parametrize("variant", ["no router", "switch off"])
@pytest.mark.parametrize("query", CLAIMED)
def test_without_the_builder_a_public_false_query_is_the_applications_404_never_the_public_copy(
    query: str, variant: str
) -> None:
    parts = secret_parts()
    app = app_with(parts, builder=False) if variant == "no router" else app_with(parts, switch=False)
    with TestClient(app) as client:
        for who in ({}, OTHER, PERSON):
            reply = get(client, query, **who)
            assert (reply.status_code, reply.json()) == (404, NOT_FOUND), (query, who)
    assert parts.sandbox.public_copies == 0
    assert TRACE == []


@pytest.mark.parametrize("variant", ["no router", "switch off"])
@pytest.mark.parametrize("query", OPEN)
def test_without_the_builder_the_public_route_serves_only_the_public_copy(query: str, variant: str) -> None:
    parts = secret_parts()
    app = app_with(parts, builder=False) if variant == "no router" else app_with(parts, switch=False)
    with TestClient(app) as client:
        reply = get(client, query, **PERSON)
    assert reply.status_code == 200
    assert MARKER not in reply.text
    assert parts.sandbox.public_copies == 1


def test_the_claim_exists_only_when_the_builder_router_was_built_with_the_switch_on() -> None:
    datum, _ = make_datum(config(builder={"enabled": False}))
    assert list(routers.builder(datum, dependencies=[]).routes) == []
    datum_on, _ = make_datum()
    assert any(
        getattr(r, "path", "") == "/api/forms/{key}/definition"
        for r in routers.builder(datum_on, dependencies=[]).routes
    )


# -- nothing global ---------------------------------------------------------------------------------------------------
def test_the_claim_adds_no_middleware_no_handler_and_no_app_state() -> None:
    datum, _ = make_datum()
    app = FastAPI()
    handlers, middleware, state = dict(app.exception_handlers), list(app.user_middleware), dict(vars(app.state))
    app.include_router(routers.forms(datum))
    app.include_router(routers.builder(datum, dependencies=[]))
    assert app.exception_handlers == handlers
    assert app.user_middleware == middleware
    assert dict(vars(app.state)) == state
    with TestClient(app):
        assert app.user_middleware == middleware
        assert dict(vars(app.state)) == state


def test_the_author_copy_route_is_absent_from_the_openapi_document_and_the_public_one_has_no_public_parameter() -> None:
    parts = secret_parts()
    with TestClient(app_with(parts)) as client:
        document = client.get("/openapi.json").json()
    operation = document["paths"][PATH.replace(FORM, "{key}")]
    assert list(operation) == ["get"]
    assert operation["get"]["operationId"] == "getFormDefinition"
    names = [p["name"] for p in operation["get"]["parameters"]]
    assert "key" in names
    assert "public" not in names
    assert "public=" not in str(document)


def test_a_head_or_other_method_on_the_claimed_query_never_reaches_the_public_copy() -> None:
    parts = secret_parts()
    with TestClient(app_with(parts)) as client:
        for method in ("HEAD", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"):
            reply = client.request(method, PATH + "?public=false", headers=PERSON)
            assert MARKER not in reply.text, method
            assert reply.status_code != 200, method
    assert parts.sandbox.public_copies == 0


def test_a_claimed_non_get_method_is_the_405_of_the_author_route() -> None:
    with TestClient(app_with(secret_parts())) as client:
        for method in ("POST", "PUT", "DELETE", "PATCH"):
            reply = client.request(method, PATH + "?public=false", headers=PERSON)
            assert reply.status_code == 405, method


# -- Cache-Control: no-store on every answer of the author's copy ----------------------------------------------------
@pytest.mark.parametrize("validator", ["current", "*"])
def test_a_matching_if_none_match_is_304_with_the_etag_and_no_store(validator: str) -> None:
    with TestClient(app_with(Parts())) as client:
        etag = get(client, "public=false", **PERSON).headers["etag"]
        reply = get(client, "public=false", **PERSON, **{"If-None-Match": etag if validator == "current" else "*"})
    assert reply.status_code == 304
    assert reply.headers["etag"] == etag
    assert reply.headers["cache-control"] == "no-store"


def test_a_stale_if_match_is_409_with_the_current_etag_no_store_and_no_hash() -> None:
    stale = '"' + "0" * 64 + '"'
    with TestClient(app_with(Parts())) as client:
        etag = get(client, "public=false", **PERSON).headers["etag"]
        reply = get(client, "public=false", **PERSON, **{"If-Match": stale})
    assert reply.status_code == 409
    assert reply.json()["errors"][0]["code"] == "form.outdated"
    assert reply.headers["etag"] == etag
    assert reply.headers["cache-control"] == "no-store"
    assert etag.strip('"') not in reply.text


# -- nested routers ---------------------------------------------------------------------------------------------------
def nested_app(parts: Parts, *, builder_first: bool) -> FastAPI:
    """Both routers included into a parent `APIRouter(prefix="/v1")`, which the application includes once."""
    from builder_fakes import persona  # noqa: PLC0415
    from fastapi import APIRouter, Depends  # noqa: PLC0415

    datum, _ = make_datum(config(builder={"enabled": True}), parts=parts)
    parent = APIRouter(prefix="/v1")
    children = [routers.forms(datum), routers.builder(datum, dependencies=[Depends(persona)])]
    for child in reversed(children) if builder_first else children:
        parent.include_router(child)
    app = FastAPI()
    app.include_router(parent)
    return app


@pytest.mark.parametrize("builder_first", [False, True], ids=["forms first", "builder first"])
@pytest.mark.parametrize("query", CLAIMED)
def test_a_nested_prefix_keeps_the_claim_in_either_include_order(query: str, builder_first: bool) -> None:
    parts = secret_parts()
    with TestClient(nested_app(parts, builder_first=builder_first)) as client:
        url = f"/v1{PATH}?{query}"
        visitor = client.get(url)
        person = client.get(url, headers=PERSON)
    assert (visitor.status_code, visitor.json()) == (401, {"detail": "sign in"})
    assert person.status_code == 200
    assert MARKER in person.text
    assert person.headers["cache-control"] == "no-store"
    assert parts.sandbox.public_copies == 0


@pytest.mark.parametrize("builder_first", [False, True], ids=["forms first", "builder first"])
def test_a_nested_prefix_leaves_the_public_copy_to_the_public_route(builder_first: bool) -> None:
    parts = secret_parts()
    with TestClient(nested_app(parts, builder_first=builder_first)) as client:
        reply = client.get(f"/v1{PATH}")
    assert reply.status_code == 200
    assert MARKER not in reply.text
