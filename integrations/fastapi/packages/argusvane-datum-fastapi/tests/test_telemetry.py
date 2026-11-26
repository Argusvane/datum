"""The UPGRADE CANARY: exactly one SERVER span in three configurations, with `datum.submission` below it.

FastAPI's native telemetry alone, the ASGI instrumentation alone (FastAPI's
own switched off), and both. Each runs against the real submissions route and against a plain `def` endpoint (a sync
endpoint, whose spans FastAPI's wrapper parents through the copied context). The assertions: one server span a request,
one trace, the Datum spans descendants of THE server span (never a fixed name).

FastAPI's native `telemetry=` argument arrived after 0.133.0: on the floor the two configurations that need it skip with
that reason; the ASGI-instrumentation configuration runs on both legs.
"""

import inspect
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from opentelemetry import trace
from opentelemetry.instrumentation.asgi import OpenTelemetryMiddleware
from otel_support import Telemetry, telemetry
from submissions_fakes import Parts, body_of, config, make_datum

from datum_fastapi import Datum, routers

NATIVE = "telemetry" in inspect.signature(FastAPI.__init__).parameters
NO_NATIVE = "FastAPI's native telemetry= argument arrived after 0.133.0 (the floor): the configuration is skipped"
JSON = {"Content-Type": "application/json"}
TRACER = trace.get_tracer("datum", "0")


def make_app(mode: str) -> tuple[FastAPI, Datum, Parts]:
    datum, parts = make_datum(config())
    kwargs: dict[str, Any] = {}
    if mode == "asgi" and NATIVE:
        kwargs["telemetry"] = {"tracing": False, "metrics": False}
    app = FastAPI(**kwargs)
    app.include_router(routers.submissions(datum))

    @app.post("/sync")
    def sync_endpoint() -> dict[str, int]:
        with TRACER.start_as_current_span("datum.submission"), TRACER.start_as_current_span("datum.sandbox.run"):
            pass
        return {"ok": 1}

    if mode in {"asgi", "both"}:
        app.add_middleware(OpenTelemetryMiddleware)
    return app, datum, parts


CONFIGURATIONS = [
    pytest.param("native", marks=pytest.mark.skipif(not NATIVE, reason=NO_NATIVE), id="native only"),
    pytest.param("asgi", id="ASGI instrumentation only"),
    pytest.param("both", marks=pytest.mark.skipif(not NATIVE, reason=NO_NATIVE), id="both"),
]


def request(mode: str, path: str) -> Telemetry:
    otel = telemetry()
    app, _, _ = make_app(mode)
    with TestClient(app) as client:
        otel.exporter.clear()
        reply = client.post(path, content=body_of() if path == "/api/submissions" else b"{}", headers=JSON)
        assert reply.status_code == 200
    return otel


@pytest.mark.parametrize("mode", CONFIGURATIONS)
@pytest.mark.parametrize("path", ["/api/submissions", "/sync"])
def test_one_server_span_a_request_and_one_trace(mode: str, path: str) -> None:
    otel = request(mode, path)
    assert len(otel.servers()) == 1
    assert len({span.context.trace_id for span in otel.spans()}) == 1


@pytest.mark.parametrize("mode", CONFIGURATIONS)
@pytest.mark.parametrize("path", ["/api/submissions", "/sync"])
def test_datum_submission_is_a_descendant_of_the_single_server_span_and_the_run_is_its_child(
    mode: str, path: str
) -> None:
    otel = request(mode, path)
    (server,) = otel.servers()
    (submission,) = [s for s in otel.spans() if s.name == "datum.submission"]
    (run,) = [s for s in otel.spans() if s.name == "datum.sandbox.run"]
    assert server.context.span_id in {a.context.span_id for a in otel.chain(submission)}
    assert next(a.name for a in otel.chain(run)) == "datum.submission"
    assert run.context.trace_id == server.context.trace_id


@pytest.mark.parametrize("mode", CONFIGURATIONS)
def test_the_sync_endpoint_spans_parent_correctly_through_fastapis_worker_thread_wrapper(mode: str) -> None:
    otel = request(mode, "/sync")
    (submission,) = [s for s in otel.spans() if s.name == "datum.submission"]
    (run,) = [s for s in otel.spans() if s.name == "datum.sandbox.run"]
    assert run.parent is not None
    assert run.parent.span_id == submission.context.span_id
    assert submission.parent is not None


@pytest.mark.parametrize("mode", CONFIGURATIONS)
def test_the_datum_submission_span_made_by_the_real_route_carries_its_attributes(mode: str) -> None:
    otel = request(mode, "/api/submissions")
    (submission,) = [s for s in otel.spans() if s.name == "datum.submission"]
    attributes = dict(submission.attributes or {})
    assert attributes["datum.channel"] == "http"
    assert attributes["datum.outcome"] == "accepted"
    assert attributes["datum.form"] == "contact"


def test_with_both_configurations_on_the_native_layer_stands_down_for_the_contrib_middleware() -> None:
    """FastAPI's detection of the contrib middleware is by module name, hence this canary."""
    if not NATIVE:
        pytest.skip(NO_NATIVE)
    otel = request("both", "/api/submissions")
    (server,) = otel.servers()
    assert server.instrumentation_scope is not None
    assert "opentelemetry.instrumentation.asgi" in server.instrumentation_scope.name
    assert not [s for s in otel.spans() if s.name.startswith("fastapi.")]


def test_a_request_the_throttle_refuses_still_makes_one_server_span_and_no_submission_span() -> None:
    otel = telemetry()
    datum, parts = make_datum(config())
    parts.throttle.deny = 5
    app = FastAPI()
    app.include_router(routers.submissions(datum))
    app.add_middleware(OpenTelemetryMiddleware)
    with TestClient(app) as client:
        otel.exporter.clear()
        assert client.post("/api/submissions", content=body_of(), headers=JSON).status_code == 429
    assert len(otel.servers()) == 1
    assert [s.name for s in otel.spans() if s.name == "datum.sandbox.run"] == []
