"""The started guard's words after an application-caught failed start (it says the start failed)."""

import logging

import httpx2
import pytest
from datum_fakes import StubRepository, StubRuntime, StubSandbox, config, definition, runtime_of, sandbox_of
from fastapi import FastAPI

from datum_fastapi import Datum, routers
from datum_fastapi.lifespan import COMPOSITION_ERROR, START_FAILED_ERROR
from datum_sandbox.protocol import ProgramUnavailableError

PATH = "/api/forms/contact/definition"


class FailingSandbox(StubSandbox):
    def prove_abi(self) -> None:
        raise ProgramUnavailableError("the program's ABI is too old")


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


def datum_errors(caplog: pytest.LogCaptureFixture) -> list[logging.LogRecord]:
    return [r for r in caplog.records if r.levelno >= logging.ERROR and r.name.split(".")[0] == "datum"]


@pytest.mark.anyio
async def test_after_an_application_caught_failed_start_the_guard_says_the_start_failed(
    caplog: pytest.LogCaptureFixture,
) -> None:
    datum = Datum(
        config=config(),
        runtime=runtime_of(StubRuntime()),
        sandbox=sandbox_of(FailingSandbox()),
        form_repository=StubRepository(definition("contact")),
    )
    app = FastAPI()
    app.include_router(routers.forms(datum))
    with caplog.at_level(logging.ERROR):
        with pytest.raises(Exception, match="ABI"):
            async with datum:
                pass
        caplog.clear()  # the start's own report of the failure is not the guard's
        async with httpx2.AsyncClient(transport=httpx2.ASGITransport(app=app), base_url="http://testserver") as client:
            first = await client.get(PATH)
            second = await client.get(PATH)
    assert [first.status_code, second.status_code] == [503, 503]
    assert first.json()["errors"][0]["code"] == "server.unavailable"
    errors = datum_errors(caplog)
    assert len(errors) == 1  # once, not per request
    message = errors[0].getMessage()
    assert message == START_FAILED_ERROR
    assert "start failed" in message
    assert "never ran" not in message
    assert message != COMPOSITION_ERROR


@pytest.mark.anyio
async def test_a_request_before_any_start_still_gets_the_composition_error(caplog: pytest.LogCaptureFixture) -> None:
    datum = Datum(
        config=config(),
        runtime=runtime_of(StubRuntime()),
        sandbox=sandbox_of(StubSandbox()),
        form_repository=StubRepository(definition("contact")),
    )
    app = FastAPI()
    app.include_router(routers.forms(datum))
    with caplog.at_level(logging.ERROR):
        async with httpx2.AsyncClient(transport=httpx2.ASGITransport(app=app), base_url="http://testserver") as client:
            assert (await client.get(PATH)).status_code == 503
    assert [r.getMessage() for r in datum_errors(caplog)] == [COMPOSITION_ERROR]
