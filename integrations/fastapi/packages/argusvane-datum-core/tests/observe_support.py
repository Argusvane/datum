"""The observation tests' view of the process's one in-memory OpenTelemetry SDK, read back by span name.

The SDK is installed once per process by `datum_core.testing.otel`, shared with every other member's tests (a
workspace-wide `pytest` collects them into one process, and the API allows one provider per process).
"""

from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Any

from opentelemetry.sdk.metrics.export import InMemoryMetricReader
from opentelemetry.sdk.trace import ReadableSpan
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

from datum_core.testing.otel import in_memory_sdk


@dataclass
class Telemetry:
    exporter: InMemorySpanExporter
    reader: InMemoryMetricReader

    def spans(self, name: str | None = None) -> list[ReadableSpan]:
        finished = self.exporter.get_finished_spans()
        return [s for s in finished if name is None or s.name == name]

    def by_id(self) -> dict[int, ReadableSpan]:
        return {s.context.span_id: s for s in self.exporter.get_finished_spans()}

    def parent_of(self, span: ReadableSpan) -> ReadableSpan | None:
        return self.by_id().get(span.parent.span_id) if span.parent is not None else None

    def points(self, name: str) -> list[Any]:
        data = self.reader.get_metrics_data()
        found: list[Any] = []
        if data is None:
            return found
        for resource in data.resource_metrics:
            for scope in resource.scope_metrics:
                found.extend(
                    point for metric in scope.metrics if metric.name == name for point in metric.data.data_points
                )
        return found

    def total(self, name: str, **attributes: str) -> float:
        """Sum a counter's (or an up-down counter's) data points whose attributes include `attributes`."""
        return float(sum(p.value for p in self.points(name) if _matches(p.attributes, attributes)))

    def observations(self, name: str, **attributes: str) -> int:
        """Count the recordings of a histogram whose attributes include `attributes`."""
        return int(sum(p.count for p in self.points(name) if _matches(p.attributes, attributes)))

    def instrument_names(self) -> set[str]:
        data = self.reader.get_metrics_data()
        if data is None:
            return set()
        return {m.name for r in data.resource_metrics for s in r.scope_metrics for m in s.metrics}


def _matches(actual: Mapping[str, Any] | None, wanted: Mapping[str, str]) -> bool:
    return all((actual or {}).get(key) == value for key, value in wanted.items())


def telemetry() -> Telemetry:
    """The process's in-memory SDK, installed on first use; spans are cleared on each call."""
    sdk = in_memory_sdk()
    return Telemetry(sdk.exporter, sdk.reader)


@contextmanager
def observed() -> Iterator[Telemetry]:
    yield telemetry()


def attribute_text(span: ReadableSpan) -> str:
    return " ".join(f"{key}={value!r}" for key, value in (span.attributes or {}).items())


def attrs(span: ReadableSpan) -> dict[str, Any]:
    """The span's attributes as a plain dict."""
    return dict(span.attributes or {})
