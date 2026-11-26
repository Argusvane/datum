"""The binding tests' view of the process's one in-memory OpenTelemetry SDK.

The SDK is installed once per process by `datum_core.testing.otel`, shared with argusvane-datum-core's tests (a
workspace-wide `pytest` collects both members into one process, and the API allows one provider per process).
"""

from dataclasses import dataclass
from typing import Any

from opentelemetry import trace
from opentelemetry.sdk.metrics.export import InMemoryMetricReader
from opentelemetry.sdk.trace import ReadableSpan
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

from datum_core.testing.otel import in_memory_sdk


@dataclass
class Telemetry:
    exporter: InMemorySpanExporter
    reader: InMemoryMetricReader

    def spans(self) -> list[ReadableSpan]:
        return list(self.exporter.get_finished_spans())

    def servers(self) -> list[ReadableSpan]:
        return [span for span in self.spans() if span.kind == trace.SpanKind.SERVER]

    def chain(self, span: ReadableSpan) -> list[ReadableSpan]:
        """The span's ancestors, nearest first (finished spans only)."""
        by_id = {s.context.span_id: s for s in self.spans()}
        found: list[ReadableSpan] = []
        current = span
        while current.parent is not None and current.parent.span_id in by_id:
            current = by_id[current.parent.span_id]
            found.append(current)
        return found

    def total(self, name: str, **attributes: str) -> float:
        data = self.reader.get_metrics_data()
        found = 0.0
        if data is None:
            return found
        for resource in data.resource_metrics:
            for scope in resource.scope_metrics:
                for metric in scope.metrics:
                    points: list[Any] = list(metric.data.data_points) if metric.name == name else []
                    for point in points:
                        if all((point.attributes or {}).get(key) == value for key, value in attributes.items()):
                            found += float(point.value)
        return found


def telemetry() -> Telemetry:
    """The process's in-memory SDK, installed on first use; spans are cleared on each call."""
    sdk = in_memory_sdk()
    return Telemetry(sdk.exporter, sdk.reader)
