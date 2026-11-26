"""The UI example is proven in process: seeding, the builder page, the author's copy and the guarded save.

Imports `examples/ui/app.py` with the README's environment under the TestClient lifespan and asserts `/builder`, the
author's definition with its ETag, and the `PUT` with that ETag (200) and with a stale one (409).
"""

import importlib.util
import json
import sys
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

pytestmark = pytest.mark.runtime

EXAMPLE = Path(__file__).resolve().parents[4] / "examples" / "ui"
FORM = "datum-security-suite"
DEFINITION = f"/api/forms/{FORM}/definition"


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    if importlib.util.find_spec("datum_sandbox_wasmtime") is None:
        pytest.skip("no engine is installed (argusvane-datum-sandbox-wasmtime)")
    monkeypatch.setenv("DATUM_BUILDER__ENABLED", "true")
    monkeypatch.setenv("DATUM_WEB__ASSETS__ENABLED", "true")
    monkeypatch.setenv("DATUM_WEB__API__ENDPOINTS__DEFINITION", "true")
    spec = importlib.util.spec_from_file_location("datum_example_ui_app", EXAMPLE / "app.py")
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    try:
        spec.loader.exec_module(module)
        with TestClient(module.app) as test_client:
            yield test_client
    finally:
        sys.modules.pop(spec.name, None)


def test_builder_page_names_the_seeded_form(client: TestClient) -> None:
    response = client.get("/builder")
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert FORM in response.text


def test_save_needs_the_current_etag(client: TestClient) -> None:
    read = client.get(DEFINITION, params={"public": "false"})
    assert read.status_code == 200
    etag = read.headers["etag"]
    headers = {"If-Match": etag, "Content-Type": "application/json"}
    edited = {**read.json(), "title": "Edited by the test"}
    saved = client.put(f"/api/forms/{FORM}", content=json.dumps(edited), headers=headers)
    assert saved.status_code == 200
    stale = client.put(f"/api/forms/{FORM}", content=json.dumps(edited), headers=headers)
    assert stale.status_code == 409
