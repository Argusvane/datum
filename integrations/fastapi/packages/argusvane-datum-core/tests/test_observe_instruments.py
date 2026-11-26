"""The instruments, their attributes, the rejected count and the import-time acquisition."""

import asyncio
import subprocess
import sys
import threading
from pathlib import Path

import pytest
from observe_support import Telemetry, telemetry
from submissions_support import bus, envelope, http_context, journey_check, refused_by_kernel, started, wrapped

from datum_core.events import DatumEvent
from datum_core.observe import RUN_DURATION_BUCKETS
from datum_core.submissions import FormRef, Reject
from datum_sandbox.protocol import ProgramUnavailableError
from datum_sandbox.wasi import EngineBusyError

TESTS = Path(__file__).resolve().parent
NAMES = {
    "datum.sandbox.run.duration",
    "datum.sandbox.run.wait.duration",
    "datum.sandbox.run.active",
    "datum.sandbox.run.rejected",
    "datum.submission.received",
    "datum.request.throttled",
}


@pytest.fixture
def otel() -> Telemetry:
    return telemetry()


def test_a_run_records_the_duration_the_wait_and_returns_the_active_count_to_zero(otel: Telemetry) -> None:
    before = otel.observations("datum.sandbox.run.duration", **{"datum.program": "sandbox"})
    waited = otel.observations("datum.sandbox.run.wait.duration", **{"datum.program": "sandbox"})
    with started() as rig:
        rig.submit()
    assert otel.observations("datum.sandbox.run.duration", **{"datum.program": "sandbox"}) == before + 1
    assert otel.observations("datum.sandbox.run.wait.duration", **{"datum.program": "sandbox"}) == waited + 1
    assert otel.total("datum.sandbox.run.active", **{"datum.program": "sandbox"}) == 0


def test_the_duration_histogram_carries_the_documented_bucket_advice(otel: Telemetry) -> None:
    with started() as rig:
        rig.submit()
    (point, *_) = otel.points("datum.sandbox.run.duration")
    assert tuple(point.explicit_bounds) == RUN_DURATION_BUCKETS
    assert list(RUN_DURATION_BUCKETS) == sorted(set(RUN_DURATION_BUCKETS))
    assert RUN_DURATION_BUCKETS[0] <= 0.005
    assert RUN_DURATION_BUCKETS[-1] >= 60
    assert RUN_DURATION_BUCKETS[-1] == 300.0, "the last bound is the five-minute ceiling the runs are sized to"


def test_the_duration_histogram_has_the_program_and_the_outcome_but_never_the_form(otel: Telemetry) -> None:
    with started() as rig:
        rig.submit()
    for name in ("datum.sandbox.run.duration", "datum.sandbox.run.wait.duration"):
        for point in otel.points(name):
            assert "datum.form" not in point.attributes, name
            assert "datum.program" in point.attributes, name
    assert all("datum.outcome" in p.attributes for p in otel.points("datum.sandbox.run.duration"))


def test_a_failed_run_adds_error_type_to_the_duration(otel: Telemetry) -> None:
    with started() as rig:
        rig.sandbox.error = ProgramUnavailableError("down")
        rig.submit()
    assert any("error.type" in p.attributes for p in otel.points("datum.sandbox.run.duration"))


def test_the_received_counter_is_the_one_instrument_with_the_form(otel: Telemetry) -> None:
    attributes = {"datum.status": "accepted", "datum.form": "contact"}
    before = otel.total("datum.submission.received", **attributes)
    with started() as rig:
        rig.submit()
    assert otel.total("datum.submission.received", **attributes) == before + 1
    carrying_form = {n for n in otel.instrument_names() if any("datum.form" in p.attributes for p in otel.points(n))}
    assert carrying_form == {"datum.submission.received"}


def test_a_rejection_is_counted_on_received_with_its_status(otel: Telemetry) -> None:
    before = otel.total("datum.submission.received", **{"datum.status": "rejected"})
    with started() as rig:
        rig.sandbox.verdict = refused_by_kernel()
        rig.submit(envelope(values={"name": ""}))
    assert otel.total("datum.submission.received", **{"datum.status": "rejected"}) == before + 1


def test_a_throttled_request_is_counted_with_its_channel(otel: Telemetry) -> None:
    before = otel.total("datum.request.throttled", **{"datum.channel": "http"})
    with started() as rig:
        rig.throttle.deny = 3
        rig.submit(envelope(), http_context())
    assert otel.total("datum.request.throttled", **{"datum.channel": "http"}) == before + 1


def test_a_pre_check_refusal_is_not_a_throttle(otel: Telemetry) -> None:
    before = otel.total("datum.request.throttled")
    with started(pre_checks=[lambda incoming: Reject("closed", "Closed")]) as rig:
        rig.submit(envelope(), http_context())
    assert otel.total("datum.request.throttled") == before


# -- the rejected counter: busy refusals, counted once for every caller ------------------------------------------------
def test_a_bus_channel_busy_refusal_is_counted_once_with_the_reason_busy(otel: Telemetry) -> None:
    before = otel.total("datum.sandbox.run.rejected", **{"datum.reason": "busy"})
    with started() as rig:
        rig.sandbox.error = EngineBusyError("slots")
        outcome = rig.submit(envelope(), bus())
    assert type(outcome).__name__ == "Unavailable"
    assert otel.total("datum.sandbox.run.rejected", **{"datum.reason": "busy"}) == before + 1


def test_a_route_channel_busy_refusal_is_counted_once_too(otel: Telemetry) -> None:
    before = otel.total("datum.sandbox.run.rejected")
    with started() as rig:
        rig.sandbox.error = EngineBusyError("slots")
        rig.submit(envelope(), http_context())
    assert otel.total("datum.sandbox.run.rejected") == before + 1


def test_a_busy_refusal_is_counted_once_however_many_layers_the_error_crosses(otel: Telemetry) -> None:
    before = otel.total("datum.sandbox.run.rejected")
    with started() as rig:
        rig.sandbox.error = EngineBusyError("slots")
        rig.service.validate(FormRef.from_document(), journey_check(envelope()), bus())
        rig.service.test(FormRef.from_document(), wrapped(envelope()), bus())
    assert otel.total("datum.sandbox.run.rejected") == before + 2  # two calls, one count each


def test_a_runtime_that_is_down_is_not_a_rejected_run(otel: Telemetry) -> None:
    before = otel.total("datum.sandbox.run.rejected")
    with started() as rig:
        rig.sandbox.error = ProgramUnavailableError("down")
        rig.submit()
    assert otel.total("datum.sandbox.run.rejected") == before


def test_a_raising_hook_or_listener_never_changes_the_rejected_counter(otel: Telemetry) -> None:
    def explode(*args: object) -> None:
        raise RuntimeError("broken")

    before = otel.total("datum.sandbox.run.rejected")
    with started(listeners=[(DatumEvent, explode)], validators=[explode]) as rig:
        rig.service.submit(FormRef.from_document(), envelope(), bus())
    assert otel.total("datum.sandbox.run.rejected") == before


# -- acquired at import, no SDK needed ---------------------------------------------------------------------------------
def isolated(code: str) -> subprocess.CompletedProcess[str]:
    prelude = f"import sys; sys.path.insert(0, {str(TESTS)!r})\n"
    return subprocess.run(  # noqa: S603
        [sys.executable, "-c", prelude + code], capture_output=True, text=True, check=False, timeout=120
    )


def test_instruments_created_at_import_record_after_a_later_set_meter_provider() -> None:
    result = isolated(
        """
import datum_core.observe
from opentelemetry import metrics
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import InMemoryMetricReader
reader = InMemoryMetricReader()
metrics.set_meter_provider(MeterProvider(metric_readers=[reader]))
from submissions_support import started, envelope
with started() as rig:
    rig.submit()
names = {m.name for r in reader.get_metrics_data().resource_metrics for s in r.scope_metrics for m in s.metrics}
print(sorted(names))
"""
    )
    assert result.returncode == 0, result.stderr
    assert "datum.submission.received" in result.stdout
    assert "datum.sandbox.run.duration" in result.stdout


def test_datum_core_runs_a_submission_with_no_sdk_installed_or_importable() -> None:
    result = isolated(
        """
import importlib.abc, sys
class NoSdk(importlib.abc.MetaPathFinder):
    def find_spec(self, name, path=None, target=None):
        if name.startswith(("opentelemetry.sdk", "opentelemetry.exporter", "prometheus_client")):
            raise ImportError("blocked: " + name)
sys.meta_path.insert(0, NoSdk())
from submissions_support import started, envelope
from datum_core.submissions import Accepted
with started() as rig:
    assert isinstance(rig.submit(), Accepted)
print("ok")
"""
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip().endswith("ok")


def test_the_floor_api_accepts_the_bucket_advice_and_the_up_down_counter_without_an_sdk() -> None:
    result = isolated(
        """
import importlib.abc, sys
class NoSdk(importlib.abc.MetaPathFinder):
    def find_spec(self, name, path=None, target=None):
        if name.startswith(("opentelemetry.sdk", "opentelemetry.exporter", "prometheus_client")):
            raise ImportError("blocked: " + name)
sys.meta_path.insert(0, NoSdk())
from datum_core.observe import RUN_DURATION_BUCKETS
from opentelemetry import metrics
meter = metrics.get_meter("floor-probe")
meter.create_histogram("probe.duration", unit="s", explicit_bucket_boundaries_advisory=list(RUN_DURATION_BUCKETS))
meter.create_up_down_counter("probe.in_flight")
print("ok")
"""
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip().endswith("ok")


def test_the_six_instruments_exist_after_a_mixed_load(otel: Telemetry) -> None:
    with started() as rig:
        rig.submit()
        rig.sandbox.error = EngineBusyError("slots")
        rig.submit(envelope(values={"name": "busy"}))
        rig.sandbox.error = None
        rig.throttle.deny = 2
        rig.submit(envelope(values={"name": "flood"}), http_context())
    assert otel.instrument_names() >= NAMES


def test_only_deliveries_are_counted_as_received(otel: Telemetry) -> None:
    with started() as rig:
        before = otel.total("datum.submission.received")
        rig.service.validate(FormRef.from_document(), journey_check(envelope()), bus())
        rig.service.test(FormRef.from_document(), wrapped(envelope()), bus())
        rig.service.inspect("abi", envelope(), http_context())
    assert otel.total("datum.submission.received") == before


@pytest.mark.anyio
async def test_the_runner_counts_its_own_busy_refusal_once() -> None:
    from datum_core.aio import AsyncRunner  # noqa: PLC0415

    otel = telemetry()
    runner = AsyncRunner(worker_threads=1, wait=0, shutdown_grace=1.0)
    release = threading.Event()
    holder = asyncio.create_task(runner.run(release.wait, 10))
    await asyncio.sleep(0.1)
    before = otel.total("datum.sandbox.run.rejected", **{"datum.reason": "busy"})
    waited = otel.observations("datum.sandbox.run.wait.duration", **{"datum.program": "sandbox"})
    with pytest.raises(EngineBusyError):
        await runner.run(lambda: None)
    assert otel.total("datum.sandbox.run.rejected", **{"datum.reason": "busy"}) == before + 1
    assert otel.observations("datum.sandbox.run.wait.duration", **{"datum.program": "sandbox"}) == waited + 1
    release.set()
    await holder
    await runner.drain()


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


ALLOWED_METRIC_KEYS = {
    "datum.sandbox.run.duration": {"datum.program", "datum.outcome", "error.type"},
    "datum.sandbox.run.wait.duration": {"datum.program"},
    "datum.sandbox.run.active": {"datum.program"},
    "datum.sandbox.run.rejected": {"datum.reason"},
    "datum.submission.received": {"datum.status", "datum.form"},
    "datum.request.throttled": {"datum.channel"},
}
ALLOWED_SPAN_KEYS = {
    "datum.submission": {"datum.mode", "datum.channel", "datum.outcome", "datum.stage", "datum.form", "error.type"},
    "datum.sandbox.run": {"datum.op", "datum.outcome", "datum.engine.mode", "error.type"},
}


def test_every_instrument_and_span_carries_only_its_allowed_keys_and_no_forbidden_value(otel: Telemetry) -> None:
    document = envelope(extra={"note": "ZZSECRETZZ-note"})
    context = http_context(ip="198.51.100.77", principal="alice@example.org")
    with started() as rig:
        rig.submit(document, context)
        rig.sandbox.verdict = refused_by_kernel()
        rig.submit(envelope(values={"name": ""}), bus())
        rig.sandbox.verdict = None
        rig.sandbox.error = EngineBusyError("slots")
        rig.submit(envelope(values={"name": "busy"}), bus())
        rig.sandbox.error = ProgramUnavailableError("down")
        rig.submit(envelope(values={"name": "down"}), bus())
        rig.sandbox.error = None
        rig.throttle.deny = 2
        rig.submit(envelope(values={"name": "flood"}), context)
        rig.throttle.deny = 0
        rig.service.validate(FormRef.from_document(), journey_check(envelope()), bus())
        rig.service.test(FormRef.from_document(), wrapped(envelope()), bus())
        rig.service.inspect("abi", envelope(), http_context())
    forbidden = ("Grace Hopper", "ZZSECRETZZ", "198.51.100.77", "alice@example.org")
    for name, allowed in ALLOWED_METRIC_KEYS.items():
        for point in otel.points(name):
            keys = set(point.attributes or {})
            assert keys <= allowed, (name, keys)
            assert not any(any(f in str(v) for f in forbidden) for v in (point.attributes or {}).values()), name
    for name, allowed in ALLOWED_SPAN_KEYS.items():
        for span in otel.spans(name):
            assert set(span.attributes or {}) <= allowed, (name, set(span.attributes or {}))
