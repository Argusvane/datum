"""`access_errors`: the opt-in 403 handler an application registers itself."""

from typing import Any

from datum_fakes import StubRepository, StubRuntime, StubSandbox, config, definition, refusing, runtime_of, sandbox_of
from fastapi import Depends, FastAPI, HTTPException
from fastapi.testclient import TestClient

from datum_core import DatumConfig
from datum_fastapi import Datum, access_errors, routers

PATH = "/api/forms/contact/definition"


def make(cfg: DatumConfig | None = None, **app_kwargs: Any) -> tuple[Datum, FastAPI]:
    datum = Datum(
        config=cfg or config(),
        runtime=runtime_of(StubRuntime()),
        sandbox=sandbox_of(StubSandbox()),
        form_repository=StubRepository(definition("contact")),
    )
    app = FastAPI(**app_kwargs)
    app.include_router(routers.forms(datum, dependencies=[Depends(refusing(403, "guard"))]))
    return datum, app


def test_without_the_handler_the_applications_403_reaches_the_wire_as_the_framework_writes_it() -> None:
    _, app = make()
    with TestClient(app) as client:
        reply = client.get(PATH)
    assert (reply.status_code, reply.json()) == (403, {"detail": "guard refused"})


def test_registered_in_the_constructor_the_403_is_access_denied_in_the_errors_format() -> None:
    datum, _ = make()
    app = FastAPI(exception_handlers=dict(access_errors(datum)))  # type: ignore[arg-type]
    app.include_router(routers.forms(datum, dependencies=[Depends(refusing(403, "guard"))]))
    with TestClient(app) as client:
        reply = client.get(PATH)
    assert reply.status_code == 403
    assert reply.headers["content-type"] == "application/json"
    assert reply.json() == {"errors": [{"code": "access.denied"}]}
    assert "guard" not in reply.text  # the application's own words stay out of the body


def test_registered_with_add_exception_handler_and_in_the_problem_format() -> None:
    cfg = config(web={"api": {"problem_details": True}})
    datum, app = make(cfg)
    for status, handler in access_errors(datum).items():
        app.add_exception_handler(status, handler)
    with TestClient(app) as client:
        reply = client.get(PATH)
    assert reply.status_code == 403
    assert reply.headers["content-type"] == "application/problem+json"
    assert (reply.json()["code"], reply.json()["status"]) == ("access.denied", 403)


def test_the_headers_the_application_put_on_its_exception_are_kept() -> None:
    datum, _ = make()
    app = FastAPI(exception_handlers=dict(access_errors(datum)))  # type: ignore[arg-type]

    def deny() -> None:
        raise HTTPException(403, "no", headers={"X-Why": "scope"})

    app.include_router(routers.forms(datum, dependencies=[Depends(deny)]))
    with TestClient(app) as client:
        assert client.get(PATH).headers["x-why"] == "scope"


def test_a_401_is_left_to_the_application() -> None:
    datum, _ = make()
    assert set(access_errors(datum)) == {403}
    app = FastAPI(exception_handlers=dict(access_errors(datum)))  # type: ignore[arg-type]
    app.include_router(routers.forms(datum, dependencies=[Depends(refusing(401, "who"))]))
    with TestClient(app) as client:
        reply = client.get(PATH)
    assert (reply.status_code, reply.json()) == (401, {"detail": "who refused"})


def test_including_the_routers_registers_no_handler() -> None:
    _, app = make()
    assert 403 not in app.exception_handlers
