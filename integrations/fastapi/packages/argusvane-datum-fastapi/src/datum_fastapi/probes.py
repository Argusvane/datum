"""The management probes' responses: an empty 200 or 503, and the health and info bodies.

`livez` and `readyz` answer by status alone (no body, so nothing leaks to an anonymous prober); `health` answers the
flat report in both states. The statuses are the probe contract (200 up, 503 down); the report's own shape is Datum's
(`HealthReport.to_json`).

Built on: `HealthReport.to_json` is the core's flat wire body and starlette's `JSONResponse` writes it,
so nothing here serializes by hand; `http.HTTPStatus` names the two statuses a probe answers.
"""

from http import HTTPStatus

from fastapi.responses import JSONResponse
from starlette.responses import Response

from datum_core.health import HealthReport

__all__ = ["health_response", "info_response", "live_response", "not_ready_response", "ready_response"]


def live_response() -> Response:
    """200 with no body: the process answers."""
    return Response(status_code=HTTPStatus.OK)


def ready_response(report: HealthReport) -> Response:
    """200 when the `runtime` component is up, else 503, with no body."""
    return Response(status_code=HTTPStatus.OK if report.is_ready else HTTPStatus.SERVICE_UNAVAILABLE)


def not_ready_response() -> Response:
    """503 with no body: Datum was not entered (before the lifespan or after its exit)."""
    return Response(status_code=HTTPStatus.SERVICE_UNAVAILABLE)


def health_response(report: HealthReport) -> Response:
    """200 with the report when everything is up, else 503 with the report."""
    return JSONResponse(report.to_json(), status_code=HTTPStatus.OK if report.is_up else HTTPStatus.SERVICE_UNAVAILABLE)


def info_response(info: dict[str, object]) -> Response:
    """200 with the flat `Datum.info()` body."""
    return JSONResponse(info)
