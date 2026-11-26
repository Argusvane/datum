"""A mounted `datum.asgi_app()` answers like the included routers, except for `scope["root_path"]`.

Also: no `async with datum` means a 503 from the started guard, never an unprobed run; the exit drains.
"""

import asyncio
import json
import logging
import threading
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

import anyio
import httpx2
import pytest
from datum_fakes import (
    HEADERS,
    StubRepository,
    StubRuntime,
    StubSandbox,
    config,
    definition,
    runtime_of,
    sandbox_of,
)
from fastapi import APIRouter, FastAPI, Request
from fastapi.testclient import TestClient
from starlette.applications import Starlette
from starlette.middleware.body_limit import RequestBodyLimitMiddleware
from starlette.routing import Mount

from datum_fastapi import Datum, routers
from datum_fastapi.lifespan import COMPOSITION_ERROR

ASSETS = "/datum/assets"
DEFINITION = "/api/forms/contact/definition"
CAP = 1000
FILES = {
    "js": "datum-form.js",
    "css": "datum-form.css",
    "mjs": "pdfjs/pdf.worker.min.mjs",
    "wasm": "pdfjs/wasm/jbig2.wasm",
}


def make_datum(*, sandbox: StubSandbox | None = None, **sections: Any) -> Datum:
    return Datum(
        config=config(web={"assets": {"enabled": True}}, **sections),
        runtime=runtime_of(StubRuntime()),
        sandbox=sandbox_of(sandbox or StubSandbox()),
        form_repository=StubRepository(definition("contact", secret=True)),
    )


def echo_router() -> APIRouter:
    """A body-reading route of the test's own, standing in for the routes of later phases."""
    router = APIRouter()

    @router.post("/echo")
    async def echo(request: Request) -> dict[str, Any]:
        body = await request.body()
        return {"n": len(body), "root_path": request.scope.get("root_path"), "path": request.url.path}

    return router


def included_app(datum: Datum, *, cap: int | None = CAP) -> FastAPI:
    app = FastAPI()
    if cap:
        app.add_middleware(RequestBodyLimitMiddleware, max_body_size=cap)
    app.include_router(routers.forms(datum))
    app.include_router(routers.assets(datum))
    app.include_router(echo_router(), prefix="/api")
    return app


def mounted_app(datum: Datum, *, cap: int | None = CAP, sub_cap: int | None = None, path: str = "/m") -> Starlette:
    sub = datum.asgi_app()
    sub.include_router(echo_router(), prefix="/api")
    if sub_cap:
        sub.add_middleware(RequestBodyLimitMiddleware, max_body_size=sub_cap)

    @asynccontextmanager
    async def lifespan(app: Starlette) -> AsyncIterator[None]:
        async with datum:
            yield

    parent = Starlette(routes=[Mount(path, app=sub)], lifespan=lifespan)
    if cap:
        parent.add_middleware(RequestBodyLimitMiddleware, max_body_size=cap)
    return parent


def matrix(client: TestClient, prefix: str) -> dict[str, Any]:
    """The keys: one asset's answer, its conditionals, HEAD, traversal, media types, the caps, 405 and 404."""
    host = client.get(f"{prefix}{ASSETS}/host.json").json()
    base = f"{prefix}{ASSETS}/{host['buildId']}"
    out: dict[str, Any] = {}
    first = client.get(f"{base}/{FILES['js']}")
    out["a.js"] = (
        first.status_code,
        first.headers.get("content-type"),
        first.headers.get("etag"),
        first.headers.get("cache-control"),
    )
    etag = first.headers["etag"]
    out["inm"] = client.get(f"{base}/{FILES['js']}", headers={"If-None-Match": etag}).status_code
    out["inm_weak"] = client.get(f"{base}/{FILES['js']}", headers={"If-None-Match": "W/" + etag}).status_code
    out["inm_other"] = client.get(f"{base}/{FILES['js']}", headers={"If-None-Match": '"zz"'}).status_code
    head = client.head(f"{base}/{FILES['js']}")
    out["head"] = (head.status_code, head.headers.get("etag"), head.content)
    out["traversal"] = [client.get(f"{base}/{x}").status_code for x in ("..%2fmanifest.json", "%2e%2e/manifest.json")]
    for kind in ("css", "mjs", "wasm"):
        out[kind] = client.get(f"{base}/{FILES[kind]}").headers.get("content-type")
    definition_reply = client.get(f"{prefix}{DEFINITION}")
    out["definition"] = (definition_reply.status_code, definition_reply.headers.get("etag"))
    out["definition_304"] = client.get(
        f"{prefix}{DEFINITION}", headers={"If-None-Match": definition_reply.headers["etag"]}
    ).status_code
    out["small"] = client.post(f"{prefix}/api/echo", content=b"x" * 10).json()
    big = client.post(f"{prefix}/api/echo", content=b"x" * 5000)
    out["big"] = (big.status_code, big.headers.get("content-type"))
    method = client.post(f"{prefix}{DEFINITION}")
    out["405"] = (method.status_code, method.headers.get("allow"), method.text)
    out["404"] = client.get(f"{prefix}/nope").status_code
    return out


def without_root_path(result: dict[str, Any]) -> dict[str, Any]:
    result = dict(result)
    small = dict(result["small"])
    small.pop("root_path"), small.pop("path")
    result["small"] = small
    return result


def test_included_and_mounted_answer_alike_except_for_root_path() -> None:
    with TestClient(included_app(make_datum())) as inc, TestClient(mounted_app(make_datum())) as mnt:
        included, mounted = matrix(inc, ""), matrix(mnt, "/m")
    assert included["small"] == {"n": 10, "root_path": "", "path": "/api/echo"}
    assert mounted["small"] == {"n": 10, "root_path": "/m", "path": "/m/api/echo"}
    assert without_root_path(included) == without_root_path(mounted)


def test_the_matrix_itself_holds_the_answers_the_contract_names() -> None:
    with TestClient(included_app(make_datum())) as client:
        result = matrix(client, "")
    status, content_type, etag, cache = result["a.js"]
    assert status == 200
    assert content_type.startswith("text/javascript")
    assert etag.startswith('"')
    assert len(etag) == 66
    assert cache.endswith("immutable")
    assert (result["inm"], result["inm_weak"], result["inm_other"]) == (304, 304, 200)
    assert result["head"] == (200, etag, b"")
    assert result["traversal"] == [404, 404]
    assert result["css"].startswith("text/css")
    assert result["mjs"].startswith("text/javascript")
    assert result["wasm"] == "application/wasm"
    assert result["definition"][0] == 200
    assert result["definition_304"] == 304
    assert result["big"] == (413, "text/plain; charset=utf-8")  # the application's own cap, as Starlette answers it
    assert result["405"][:2] == (405, "GET")
    assert result["404"] == 404


def test_with_a_root_path_in_the_full_path_the_two_modes_still_answer_alike() -> None:
    with (
        TestClient(included_app(make_datum()), root_path="/proxy") as inc,
        TestClient(mounted_app(make_datum()), root_path="/proxy") as mnt,
    ):
        included, mounted = matrix(inc, "/proxy"), matrix(mnt, "/proxy/m")
    assert included["small"]["root_path"] == "/proxy"
    assert mounted["small"]["root_path"] == "/proxy/m"
    assert without_root_path(included) == without_root_path(mounted)


def test_a_cap_on_the_mounted_sub_application_alone_still_refuses_a_big_body() -> None:
    with TestClient(mounted_app(make_datum(), cap=None, sub_cap=CAP)) as client:
        assert client.post("/m/api/echo", content=b"x" * 5000).status_code == 413


def test_a_sub_application_cap_under_the_parents_cap_wins() -> None:
    with TestClient(mounted_app(make_datum(), cap=100_000, sub_cap=CAP)) as client:
        assert client.post("/m/api/echo", content=b"x" * 5000).status_code == 413
        assert client.post("/m/api/echo", content=b"x" * 10).json()["n"] == 10


def test_a_mounted_app_without_async_with_datum_answers_503_from_the_guard_and_never_runs_unprobed(
    caplog: pytest.LogCaptureFixture,
) -> None:
    sandbox = StubSandbox()
    datum = make_datum(sandbox=sandbox)
    parent = Starlette(routes=[Mount("/m", app=datum.asgi_app())])
    with caplog.at_level(logging.ERROR), TestClient(parent) as client:
        replies = [client.get(f"/m{DEFINITION}", headers=HEADERS) for _ in range(3)]
    assert [r.status_code for r in replies] == [503] * 3
    assert json.loads(replies[0].content)["errors"][0]["code"] == "server.unavailable"
    errors = [r for r in caplog.records if r.levelno >= logging.ERROR and r.name.split(".")[0] == "datum"]
    assert len(errors) == 1
    assert errors[0].getMessage() == COMPOSITION_ERROR
    report = datum.health()
    assert report.components["runtime"].status == "down"
    assert report.components["runtime"].details["reason"] == "lifespan not run"
    assert sandbox.abi_proofs == 0
    assert sandbox.public_copies == 0


def test_with_async_with_datum_the_probe_ran_and_health_is_up() -> None:
    sandbox = StubSandbox()
    datum = make_datum(sandbox=sandbox)
    with TestClient(mounted_app(datum)) as client:
        assert client.get(f"/m{DEFINITION}").status_code == 200
        assert datum.health().components["runtime"].status == "up"
    assert sandbox.abi_proofs == 1


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


@pytest.mark.anyio
@pytest.mark.parametrize("mode", ["included", "mounted"])
async def test_the_lifespan_exit_drains_a_request_in_flight_within_the_grace(mode: str) -> None:
    gate = threading.Event()
    sandbox = StubSandbox(gate=gate)
    datum = make_datum(sandbox=sandbox, runtime={"shutdown_grace": 3})
    if mode == "included":
        app: Any = included_app(datum, cap=None)
        context = app.router.lifespan_context(app)
        path = DEFINITION
    else:
        app = datum.asgi_app()
        context = datum
        path = DEFINITION
    async with httpx2.AsyncClient(transport=httpx2.ASGITransport(app=app), base_url="http://testserver") as client:
        began = 0.0
        async with context:
            pending = asyncio.create_task(client.get(path))
            await anyio.to_thread.run_sync(sandbox.entered.wait, 5)
            asyncio.get_running_loop().call_later(0.3, gate.set)  # the work ends while the exit is draining
            began = time.monotonic()
        waited = time.monotonic() - began
        reply = await pending
    assert reply.status_code == 200  # the effect completed, the answer was written
    assert 0.2 <= waited < 3.0  # the exit waited for it, within the grace
