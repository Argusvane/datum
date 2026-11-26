"""One in-memory OpenTelemetry SDK per process, for every member's observation tests.

The API allows one global tracer provider and one global meter provider per process: a second
`set_tracer_provider` is ignored with a warning, and an exporter hung on the loser sees nothing. Two members' test
helpers that each installed "once per process" on a flag of their own did exactly that whenever one process
collected both (a workspace-wide `pytest`). Every helper installs through this module instead: the first call
installs, the rest read back the same exporter and reader.

`datum_core.observe` is imported here first: its tracer and meter are acquired at import, before any provider
exists, and must record afterwards. The SDK is the testing extra's (`opentelemetry-sdk`); `datum_core` itself needs
only the API, and this module is not exported from `datum_core.testing` for that reason.
"""

import threading
from dataclasses import dataclass

from opentelemetry import metrics, trace
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import InMemoryMetricReader
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

import datum_core.observe  # noqa: F401 -- acquired at import, before the provider below is installed

_LOCK = threading.Lock()
_installed: "InMemorySdk | None" = None


@dataclass(frozen=True)
class InMemorySdk:
    """The process's in-memory SDK: the span exporter and the metric reader the observation tests read back."""

    exporter: InMemorySpanExporter
    reader: InMemoryMetricReader


def in_memory_sdk() -> InMemorySdk:
    """Install the in-memory SDK on first use and return it; the finished spans are cleared on each call."""
    global _installed  # noqa: PLW0603 -- the API allows one provider per process
    with _LOCK:
        if _installed is None:
            exporter = InMemorySpanExporter()
            provider = TracerProvider()
            provider.add_span_processor(SimpleSpanProcessor(exporter))
            trace.set_tracer_provider(provider)
            reader = InMemoryMetricReader()
            metrics.set_meter_provider(MeterProvider(metric_readers=[reader]))
            _installed = InMemorySdk(exporter, reader)
        _installed.exporter.clear()
        return _installed
