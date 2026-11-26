"""The correlation-id resolver: the request header, else the current trace id, else 12 random hex digits."""

import re
import secrets
from collections.abc import Mapping

from opentelemetry import trace

from datum_core.http._headers import header

_PATTERN = re.compile(r"[A-Za-z0-9._-]{1,64}")
_INVALID_TRACE_ID = 0


def _current_trace_id() -> int:
    context = trace.get_current_span().get_span_context()
    return context.trace_id if context.is_valid else _INVALID_TRACE_ID


def resolve_correlation_id(
    headers: Mapping[str, str], *, header_name: str = "X-Request-ID", trace_id: int | None = None
) -> str:
    """Return the id that names a request in the logs and, in problem mode, in `correlationId`.

    A header value is used only when it matches `[A-Za-z0-9._-]{1,64}` entirely. Otherwise the trace id is used as 32
    lowercase hex digits: `trace_id` when given, else the current span's when that span context `is_valid` (asked of
    the OpenTelemetry API, which answers an invalid span when no SDK is installed). Otherwise `secrets.token_hex(6)`.
    """
    value = header(headers, header_name)
    if value is not None and _PATTERN.fullmatch(value):
        return value
    traced = _current_trace_id() if trace_id is None else trace_id
    if traced != _INVALID_TRACE_ID:
        return f"{traced:032x}"
    return secrets.token_hex(6)
