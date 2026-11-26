"""Scenario application of the uvicorn lifecycle tests.

Environment: DATUM_EVENT_LOG=<file> (one line per lifecycle step), DATUM_TEST_FAIL_START=1 (a configuration the start
refuses), DATUM_TEST_NO_APP_LIFESPAN=1 (a FastAPI application with no lifespan of its own).
"""

import logging
import os
import sys
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import TYPE_CHECKING, Annotated, Any, cast

from fastapi import Depends, FastAPI, Header, Request, Security
from fastapi.security import APIKeyHeader

from datum_core import DatumConfig
from datum_core.events import DatumRuntimeReadyEvent, listener
from datum_core.forms import StoredDefinition
from datum_fastapi import Datum, routers
from datum_sandbox.protocol import Sandbox, Smoke
from datum_sandbox.wasi import EngineInfo, GuestRuntime

if TYPE_CHECKING:
    from datum_sandbox.json import JsonValue


def event(line: str) -> None:
    path = os.environ.get("DATUM_EVENT_LOG")
    if path:
        with Path(path).open("a", encoding="utf-8") as handle:
            handle.write(line + "\n")


handler = logging.StreamHandler(sys.stderr)
handler.setFormatter(logging.Formatter("%(levelname)s %(name)s %(message)s"))
logger = logging.getLogger("datum")
logger.addHandler(handler)
logger.setLevel(logging.INFO)
logger.propagate = False


class LoggingRuntime:
    pools = frozenset({"validation"})  # a validation-only engine: no PDF pool, so the PDF program never runs here

    def engine_info(self) -> EngineInfo:
        return EngineInfo(id="stub", release="1.0", mode="test")

    def close(self) -> None:
        event("datum stop")


class StubSandbox:
    def prove_abi(self) -> None:
        return None

    def smoke(self) -> Smoke:
        return Smoke(ok=True, elapsed=0.0, message="")

    def public_copy(self, definition: Any) -> Any:
        return dict(definition)


class Repository:
    def current(self, key: str) -> StoredDefinition | None:
        if key != "contact":
            return None
        form: dict[str, JsonValue] = {"id": "contact", "version": "1", "root": {"id": "form", "type": "form"}}
        return StoredDefinition(key=key, definition=form, sha256="0" * 64)


class LoggingDatum(Datum):
    async def __aenter__(self) -> "LoggingDatum":
        event("datum enter")
        await super().__aenter__()
        return self

    async def __aexit__(self, *exc: object) -> None:
        event("datum exit")
        await super().__aexit__(*exc)


def dep_a(request: Request, x_a: Annotated[str | None, Header()] = None) -> None:
    event("dep a")


_key_b = APIKeyHeader(name="x-b-key", auto_error=False)


def dep_b(request: Request, key: Annotated[str | None, Security(_key_b)] = None) -> None:
    event("dep b")


sections: dict[str, Any] = {"web": {"api": {"endpoints": {"definition": True}}}}
if os.environ.get("DATUM_TEST_FAIL_START") == "1":
    sections.update(builder={"enabled": True}, workers_expected=2)  # datum.E002 at the start

datum = LoggingDatum(
    config=DatumConfig.model_validate(sections),
    runtime=cast("GuestRuntime", LoggingRuntime()),
    sandbox=cast("Sandbox", StubSandbox()),
    form_repository=Repository(),
    listeners=[listener(DatumRuntimeReadyEvent, lambda _event: event("datum start"))],
)


@asynccontextmanager
async def app_lifespan(app: FastAPI) -> AsyncIterator[None]:
    event("app start")
    try:
        yield
    finally:
        event("app stop")


app = FastAPI() if os.environ.get("DATUM_TEST_NO_APP_LIFESPAN") == "1" else FastAPI(lifespan=app_lifespan)
forms = routers.forms(datum, dependencies=[Depends(dep_a)])
app.include_router(forms, dependencies=[Depends(dep_b)])  # include-time list b, router list a
app.include_router(forms, prefix="/alt", dependencies=[Depends(dep_b)])  # the same router a second time
for name in ("second", "third", "fourth"):
    app.include_router(
        routers.forms(datum, prefix=f"/{name}", dependencies=[Depends(dep_a)]), dependencies=[Depends(dep_b)]
    )
