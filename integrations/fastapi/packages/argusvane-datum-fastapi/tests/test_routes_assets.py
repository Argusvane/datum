"""The asset routes: a real route over a dictionary, never StaticFiles; host.json, the glue; AST-01..05."""

import dataclasses
import json
import re
from collections.abc import Iterator
from importlib import resources
from pathlib import Path
from typing import Any

import pytest
from datum_fakes import StubRepository, StubRuntime, StubSandbox, config, runtime_of, sandbox_of
from fastapi import FastAPI
from fastapi.routing import APIRoute
from fastapi.testclient import TestClient
from starlette.routing import Mount

from datum_core.http.assets import AssetCatalog
from datum_fastapi import Datum, routers

PREFIX = "/datum/assets"
GLUE = Path(__file__).resolve().parents[4] / "shared" / "glue" / "datum-host.js"
UI_FILES = json.loads(resources.files("datum_assets_ui").joinpath("assets", "files.json").read_text("utf-8"))["files"]


def make_datum(*, builder: bool = False, cache_period: int | None = None, **seams: Any) -> Datum:
    assets: dict[str, Any] = {"enabled": True}
    if cache_period is not None:
        assets["cache_period"] = cache_period
    sections: dict[str, Any] = {"web": {"assets": assets}}
    if builder:
        sections["builder"] = {"enabled": True}
    return Datum(
        config=config(definition_route=False, **sections),
        runtime=runtime_of(StubRuntime()),
        sandbox=sandbox_of(StubSandbox()),
        form_repository=StubRepository(),
        **seams,
    )


def app_of(datum: Datum) -> FastAPI:
    app = FastAPI()
    app.include_router(routers.assets(datum))
    return app


@pytest.fixture
def build_id() -> str:
    return AssetCatalog.installed(builder_enabled=False).build_id


@pytest.fixture
def client() -> Iterator[TestClient]:
    with TestClient(app_of(make_datum())) as client:
        yield client


def sha_of(path: str) -> str:
    return str(UI_FILES[path])


# ---- host.json and the glue (AST-01, AST-03) -----------------------------------------------------------------------
def test_host_json_names_the_build_the_assets_and_the_api(client: TestClient, build_id: str) -> None:
    reply = client.get(f"{PREFIX}/host.json")
    assert reply.status_code == 200
    assert reply.headers["content-type"].split(";")[0].endswith("json")
    assert reply.headers["cache-control"] == "no-cache"
    assert reply.json() == {
        "buildId": build_id,
        "assetsBase": f"{PREFIX}/{build_id}",
        "apiBase": "/api",
        "csrf": {"headerName": "X-XSRF-TOKEN", "cookieName": "XSRF-TOKEN", "metaName": "_csrf"},
        "bindings": {
            "default": "datum",
            "routes": {},
            "catalog": [
                {"id": "datum", "label": "Datum", "pdfTheme": "datum-pdf"},
            ],
        },
    }


def test_host_json_publishes_the_bindings_table_the_page_glue_reads(tmp_path: Path) -> None:
    theme = tmp_path / "ledger.json"
    theme.write_text(json.dumps({"id": "ledger", "version": "1.0.0", "target": "pdf"}), encoding="utf-8")
    datum = Datum(
        config=config(
            definition_route=False,
            web={"assets": {"enabled": True}},
            bindings={
                "routes": {"benefits": "ledger-binding"},
                "catalog": {"ledger-binding": {"label": "Ledger", "pdf_theme": "ledger"}},
                "pdf_themes": {"ledger": str(theme)},
            },
        ),
        runtime=runtime_of(StubRuntime()),
        sandbox=sandbox_of(StubSandbox()),
        form_repository=StubRepository(),
    )
    with TestClient(app_of(datum)) as client:
        table = client.get(f"{PREFIX}/host.json").json()["bindings"]
    assert table["default"] == "datum"
    assert table["routes"] == {"benefits": "ledger-binding"}
    assert {"id": "ledger-binding", "label": "Ledger", "pdfTheme": "ledger"} in table["catalog"]


def test_host_json_carries_the_csrf_names_from_the_settings() -> None:
    csrf = {"header_name": "X-CSRF", "cookie_name": "csrf", "meta_name": "token"}
    datum = Datum(
        config=config(definition_route=False, web={"assets": {"enabled": True}, "csrf": csrf}),
        runtime=runtime_of(StubRuntime()),
        sandbox=sandbox_of(StubSandbox()),
        form_repository=StubRepository(),
    )
    with TestClient(app_of(datum)) as client:
        assert client.get(f"{PREFIX}/host.json").json()["csrf"] == {
            "headerName": "X-CSRF",
            "cookieName": "csrf",
            "metaName": "token",
        }


def test_a_root_path_reaches_host_json(build_id: str) -> None:
    with TestClient(app_of(make_datum()), root_path="/proxy") as client:
        body = client.get(f"/proxy{PREFIX}/host.json").json()
    assert body["assetsBase"] == f"/proxy{PREFIX}/{build_id}"
    assert body["apiBase"] == "/proxy/api"


def test_the_glue_is_the_shared_build_byte_for_byte_and_is_not_cached(client: TestClient) -> None:
    reply = client.get(f"{PREFIX}/datum-host.js")
    assert reply.status_code == 200
    assert reply.headers["content-type"].split(";")[0] == "text/javascript"
    assert reply.headers["cache-control"] == "no-cache"
    assert reply.content == GLUE.read_bytes()
    assert b"DatumHost" in reply.content


def test_host_json_and_the_glue_answer_head(client: TestClient) -> None:
    for name in ("host.json", "datum-host.js"):
        reply = client.head(f"{PREFIX}/{name}")
        assert reply.status_code == 200, name
        assert reply.content == b""


# ---- the immutable files (AST-02) ----------------------------------------------------------------------------------
def test_a_bundle_is_served_immutable_under_the_build_id_with_a_strong_etag_from_the_manifest(
    client: TestClient, build_id: str
) -> None:
    reply = client.get(f"{PREFIX}/{build_id}/datum-form.js")
    assert reply.status_code == 200
    assert reply.headers["content-type"].split(";")[0] == "text/javascript"
    assert reply.headers["etag"] == f'"{sha_of("datum-form.js")}"'
    assert reply.headers["cache-control"] == "public, max-age=31536000, immutable"
    path = resources.files("datum_assets_ui").joinpath("assets", "datum-form.js")
    assert reply.content == path.read_bytes()
    assert client.get(f"{PREFIX}/{build_id}/datum-wasm.js").status_code == 200


def test_the_cache_period_setting_sets_max_age(build_id: str) -> None:
    with TestClient(app_of(make_datum(cache_period=60))) as client:
        assert (
            client.get(f"{PREFIX}/{build_id}/datum-form.js").headers["cache-control"] == "public, max-age=60, immutable"
        )


def test_a_matching_if_none_match_is_a_304_from_the_shared_helper(client: TestClient, build_id: str) -> None:
    url = f"{PREFIX}/{build_id}/datum-form.js"
    etag = client.get(url).headers["etag"]
    for header in (etag, f"W/{etag}", f'"other", {etag}', "*"):
        reply = client.get(url, headers={"If-None-Match": header})
        assert reply.status_code == 304, header
        assert reply.headers["etag"] == etag
        assert reply.content == b""
    assert client.get(url, headers={"If-None-Match": '"other"'}).status_code == 200


def test_head_answers_the_get_headers_with_no_body(client: TestClient, build_id: str) -> None:
    url = f"{PREFIX}/{build_id}/datum-form.js"
    got, head = client.get(url), client.head(url)
    assert head.status_code == 200
    assert head.content == b""
    assert head.headers["etag"] == got.headers["etag"]
    assert head.headers["content-length"] == got.headers["content-length"]
    assert head.headers["cache-control"] == got.headers["cache-control"]


def test_the_etag_is_also_the_if_range_validator(client: TestClient, build_id: str) -> None:
    url = f"{PREFIX}/{build_id}/datum-form.js"
    etag = client.get(url).headers["etag"]
    partial = client.get(url, headers={"Range": "bytes=0-3", "If-Range": etag})
    assert partial.status_code == 206
    assert len(partial.content) == 4
    whole = client.get(url, headers={"Range": "bytes=0-3", "If-Range": '"not-the-etag"'})
    assert whole.status_code == 200


def test_a_method_other_than_get_or_head_is_starlettes_405_with_allow(client: TestClient, build_id: str) -> None:
    reply = client.post(f"{PREFIX}/{build_id}/datum-form.js")
    assert reply.status_code == 405
    assert {m.strip() for m in reply.headers["allow"].split(",")} == {"GET", "HEAD"}


# ---- not found: the traversal corpus, one test each (AST-04, AST-05) -----------------------------------------------
def not_found(client: TestClient, build_id: str, tail: str, *, build: str | None = None) -> None:
    reply = client.get(f"{PREFIX}/{build or build_id}/{tail}")
    assert reply.status_code == 404, (tail, reply.status_code)
    assert "javascript" not in reply.headers.get("content-type", ""), tail


def test_dot_dot_percent_2f_is_not_found(client: TestClient, build_id: str) -> None:
    not_found(client, build_id, "..%2fmanifest.json")


def test_percent_2e_percent_2e_slash_is_not_found(client: TestClient, build_id: str) -> None:
    not_found(client, build_id, "%2e%2e/manifest.json")


def test_percent_2e_percent_2e_percent_2f_is_not_found(client: TestClient, build_id: str) -> None:
    not_found(client, build_id, "%2e%2e%2fmanifest.json")


def test_a_double_slash_absolute_path_is_not_found(client: TestClient, build_id: str) -> None:
    not_found(client, build_id, "/etc/passwd")


def test_a_backslash_is_not_found(client: TestClient, build_id: str) -> None:
    not_found(client, build_id, "..%5cmanifest.json")


def test_a_nul_byte_is_not_found(client: TestClient, build_id: str) -> None:
    not_found(client, build_id, "datum-form.js%00.png")


def test_another_releases_build_id_is_not_found(client: TestClient) -> None:
    reply = client.get(f"{PREFIX}/nope/datum-form.js")
    assert reply.status_code == 404
    assert client.get(f"{PREFIX}/000000000000/datum-form.js").status_code == 404


def test_an_overlong_path_is_not_found(client: TestClient, build_id: str) -> None:
    not_found(client, build_id, "a" * 5000 + ".js")


def test_case_folding_finds_nothing(client: TestClient, build_id: str) -> None:
    not_found(client, build_id, "DATUM-FORM.JS")
    assert client.get(f"{PREFIX}/{build_id.upper()}/datum-form.js").status_code == 404


def test_a_file_on_disk_that_the_list_does_not_name_is_not_found(client: TestClient, build_id: str) -> None:
    not_found(client, build_id, "files.json")


def test_a_directory_is_not_found(client: TestClient, build_id: str) -> None:
    not_found(client, build_id, "builder-fonts")
    not_found(client, build_id, "builder-fonts/")


def test_head_of_a_missing_file_is_404(client: TestClient, build_id: str) -> None:
    assert client.head(f"{PREFIX}/{build_id}/nope.js").status_code == 404


# ---- builder files follow the switch (AST-04) ----------------------------------------------------------------------
BUILDER_FILES = ("datum-builder.js", "builder-fonts/geist-variable.woff2")


@pytest.mark.parametrize("name", BUILDER_FILES)
def test_a_builder_file_is_404_with_the_builder_off(client: TestClient, build_id: str, name: str) -> None:
    assert client.get(f"{PREFIX}/{build_id}/{name}").status_code == 404
    assert client.get(f"{PREFIX}/{build_id}/DATUM-BUILDER.JS").status_code == 404


@pytest.mark.parametrize("name", BUILDER_FILES)
def test_a_builder_file_is_served_with_the_builder_on(build_id: str, name: str) -> None:
    with TestClient(app_of(make_datum(builder=True))) as client:
        assert client.get(f"{PREFIX}/{build_id}/{name}").status_code == 200


def test_a_withheld_assets_callable_withholds_on_top_of_the_builds_own_list(build_id: str) -> None:
    datum = make_datum(withheld_assets=[lambda path: path.endswith(".css")])
    with TestClient(app_of(datum)) as client:
        assert client.get(f"{PREFIX}/{build_id}/datum-form.css").status_code == 404
        assert client.get(f"{PREFIX}/{build_id}/datum-form.js").status_code == 200


# ---- shape ---------------------------------------------------------------------------------------------------------
def test_the_asset_routes_are_real_routes_hidden_from_the_schema() -> None:
    router = routers.assets(make_datum())
    assert router.routes
    assert not any(isinstance(route, Mount) for route in router.routes)
    assert all(isinstance(route, APIRoute) for route in router.routes)
    assert all(route.include_in_schema is False for route in router.routes if isinstance(route, APIRoute))
    methods = {m for route in router.routes if isinstance(route, APIRoute) for m in route.methods or ()}
    assert methods == {"GET", "HEAD"}


def test_the_asset_routes_are_absent_from_the_openapi_document(build_id: str) -> None:
    with TestClient(app_of(make_datum())) as client:
        document = client.get("/openapi.json").json()
    assert not [path for path in document["paths"] if path.startswith(PREFIX)]
    assert re.search(r"host\.json|datum-host\.js", json.dumps(document)) is None


def test_the_assets_prefix_is_the_factorys_keyword() -> None:
    app = FastAPI()
    app.include_router(routers.assets(make_datum(), prefix="/static/datum"))
    with TestClient(app) as client:
        assert client.get("/static/datum/host.json").status_code == 200
        assert client.get(f"{PREFIX}/host.json").status_code == 404


def test_a_catalogued_file_removed_under_the_running_process_answers_500_internal(
    build_id: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    original = AssetCatalog.find

    def find(self: AssetCatalog, build: str, path: str) -> Any:
        found = original(self, build, path)
        return None if found is None else dataclasses.replace(found, path=tmp_path / "removed.js")

    monkeypatch.setattr(AssetCatalog, "find", find)
    with TestClient(app_of(make_datum()), raise_server_exceptions=False) as client:
        reply = client.get(f"{PREFIX}/{build_id}/datum-form.js")
    assert reply.status_code == 500
    assert reply.headers["content-type"].split(";")[0] != "text/plain"
    assert reply.json()["errors"][0]["code"] == "internal"
