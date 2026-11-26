"""Builder files and the switch (suite rows AST-04 and AST-05), through the routes.

The builder's files are withheld until `datum.builder.enabled`: a file in `builder-files.json` is 404 with the switch
off, whether or not `routers.builder` was included, and is served (immutable, strong ETag) with it on. The traversal
corpus holds for builder files too, case-folded and for HEAD. This holds the routes to the catalog.
"""

import json
import logging
from collections.abc import Iterator
from importlib import resources
from typing import Any

import pytest
from builder_fakes import Parts, build_app, config, make_datum
from fastapi.testclient import TestClient

from datum_core.http.assets import AssetCatalog
from datum_core.loggers import CHECKS
from datum_fastapi import routers

PREFIX = "/datum/assets"
ASSETS = resources.files("datum_assets_ui").joinpath("assets")
BUILDER_FILES: list[str] = json.loads(ASSETS.joinpath("builder-files.json").read_text("utf-8"))["files"]
UI_FILES: dict[str, str] = json.loads(ASSETS.joinpath("files.json").read_text("utf-8"))["files"]
SAMPLE = ["datum-builder.js", "datum-builder.css", "builder-fonts/geist-variable.woff2"]
LOOSE_FILES = ["datum-form.js", "datum-wasm.js"]


def app_for(*, switch: bool, router: bool = True, **assets: Any) -> tuple[TestClient, Parts]:
    parts = Parts()
    datum, _ = make_datum(config(builder={"enabled": switch}, web={"assets": {"enabled": True, **assets}}), parts=parts)
    return TestClient(build_app(datum, builder=router, assets=True)), parts


@pytest.fixture
def build_id() -> str:
    return AssetCatalog.installed(builder_enabled=False).build_id


@pytest.fixture
def off() -> Iterator[TestClient]:
    client, _ = app_for(switch=False)
    with client:
        yield client


@pytest.fixture
def on() -> Iterator[TestClient]:
    client, _ = app_for(switch=True)
    with client:
        yield client


def url(build_id: str, name: str) -> str:
    return f"{PREFIX}/{build_id}/{name}"


# -- the list is the builder's ----------------------------------------------------------------------------------------
def test_the_builder_file_list_is_not_empty_and_none_of_it_is_a_form_file() -> None:
    assert BUILDER_FILES
    assert not [name for name in BUILDER_FILES if name in LOOSE_FILES]
    assert set(LOOSE_FILES) <= set(UI_FILES)
    assert "datum-builder.js" in BUILDER_FILES


@pytest.mark.parametrize("name", BUILDER_FILES)
def test_every_builder_file_is_404_with_the_switch_off_even_when_the_router_is_included(
    off: TestClient, build_id: str, name: str
) -> None:
    assert off.get(url(build_id, name)).status_code == 404
    assert off.head(url(build_id, name)).status_code == 404


@pytest.mark.parametrize("name", BUILDER_FILES)
def test_every_builder_file_is_served_with_the_switch_on_immutable_with_its_manifest_etag(
    on: TestClient, build_id: str, name: str
) -> None:
    reply = on.get(url(build_id, name))
    assert reply.status_code == 200, name
    assert reply.headers["cache-control"] == "public, max-age=31536000, immutable"
    assert reply.headers["etag"].startswith('"')
    assert on.head(url(build_id, name)).status_code == 200
    assert on.head(url(build_id, name)).content == b""


@pytest.mark.parametrize("name", LOOSE_FILES)
def test_the_form_files_are_served_with_the_switch_off_and_on(
    off: TestClient, on: TestClient, build_id: str, name: str
) -> None:
    assert off.get(url(build_id, name)).status_code == 200
    assert on.get(url(build_id, name)).status_code == 200


def test_the_builder_router_without_the_assets_router_serves_no_file() -> None:
    parts = Parts()
    datum, _ = make_datum(config(web={"assets": {"enabled": True}}), parts=parts)
    with TestClient(build_app(datum, assets=False)) as client:
        build_id = AssetCatalog.installed(builder_enabled=True).build_id
        assert client.get(url(build_id, "datum-builder.js")).status_code == 404


def test_including_the_builder_router_with_the_switch_off_adds_no_route_and_a_w001(
    caplog: pytest.LogCaptureFixture,
) -> None:
    parts = Parts()
    datum, _ = make_datum(config(builder={"enabled": False}), parts=parts)
    assert list(routers.builder(datum, dependencies=[]).routes) == []
    with caplog.at_level(logging.WARNING, logger=CHECKS):
        client, _ = app_for(switch=False)
        with client:
            pass
    w001 = [r for r in caplog.records if getattr(r, "datum_check_id", None) == "datum.W001"]
    assert w001
    assert any("builder" in r.getMessage() for r in w001)


# -- the traversal corpus, for builder files --------------------------------------------------------------------------
@pytest.mark.parametrize("name", SAMPLE)
@pytest.mark.parametrize(
    "tail",
    [
        "..%2fbuilder-files.json",
        "%2e%2e/builder-files.json",
        "%2e%2e%2fbuilder-files.json",
        "/etc/passwd",
        "..%5cbuilder-files.json",
        "{name}%00.png",
        "{name}%00",
        "builder-fonts/%2e%2e/{name}",
        "builder-fonts%2f..%2f{name}",
        "{name}/",
        "{name}/extra",
        "{name}.map",
        "{name}%20",
        "%20{name}",
    ],
)
@pytest.mark.parametrize("switch", ["on", "off"])
def test_a_traversal_spelling_of_a_builder_file_is_404_with_the_switch_on_or_off(
    request: pytest.FixtureRequest, build_id: str, name: str, tail: str, switch: str
) -> None:
    client: TestClient = request.getfixturevalue(switch)
    reply = client.get(url(build_id, tail.replace("{name}", name)))
    assert reply.status_code == 404, (tail, reply.status_code)
    assert "javascript" not in reply.headers.get("content-type", ""), tail
    assert client.head(url(build_id, tail.replace("{name}", name))).status_code == 404


@pytest.mark.parametrize("name", SAMPLE)
def test_case_folding_finds_no_builder_file_in_either_state(
    off: TestClient, on: TestClient, build_id: str, name: str
) -> None:
    for client in (off, on):
        for send in (client.get, client.head):
            assert send(url(build_id, name.upper())).status_code == 404
            assert send(url(build_id, name.title())).status_code == 404
            assert send(url(build_id.upper(), name)).status_code == 404


def test_another_releases_build_id_finds_no_builder_file(on: TestClient) -> None:
    for build in ("nope", "000000000000", "0" * 64):
        assert on.get(url(build, "datum-builder.js")).status_code == 404


def test_the_builder_files_directory_and_the_unlisted_list_file_are_404(on: TestClient, build_id: str) -> None:
    for name in ("builder-fonts", "builder-fonts/", "files.json"):
        assert on.get(url(build_id, name)).status_code == 404, name


def test_an_overlong_builder_path_is_404(on: TestClient, build_id: str) -> None:
    assert on.get(url(build_id, "builder-fonts/" + "a" * 5000 + ".woff2")).status_code == 404


def test_head_of_a_missing_builder_file_is_404(on: TestClient, build_id: str) -> None:
    assert on.head(url(build_id, "datum-builder-nope.js")).status_code == 404
    assert on.head(url(build_id, "builder-fonts/nope.woff2")).status_code == 404


# -- the application's own withholding goes on top --------------------------------------------------------------------
def test_a_withheld_assets_callable_withholds_a_builder_file_even_with_the_switch_on(build_id: str) -> None:
    parts = Parts()
    datum, _ = make_datum(
        config(builder={"enabled": True}, web={"assets": {"enabled": True}}),
        parts=parts,
        withheld_assets=[lambda path: path.startswith("builder-fonts/")],
    )
    with TestClient(build_app(datum, assets=True)) as client:
        assert client.get(url(build_id, "builder-fonts/geist-variable.woff2")).status_code == 404
        assert client.get(url(build_id, "datum-builder.js")).status_code == 200


def test_omit_features_does_not_unwithhold_a_builder_file_with_the_switch_off(build_id: str) -> None:
    client, _ = app_for(switch=False, omit_features=["pdf"])
    with client:
        assert client.get(url(build_id, "datum-builder.js")).status_code == 404


# -- the assets are not API -------------------------------------------------------------------------------------------
def test_builder_files_are_absent_from_the_openapi_document(on: TestClient) -> None:
    document = on.get("/openapi.json").json()
    assert not [path for path in document["paths"] if path.startswith(PREFIX)]
    assert "datum-builder" not in json.dumps(document)
