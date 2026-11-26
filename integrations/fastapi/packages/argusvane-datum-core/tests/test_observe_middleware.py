"""`sandbox_middleware` entries see each run first-outermost and Datum's observation is the innermost layer."""

from typing import Any, cast

from observe_support import Telemetry, telemetry
from opentelemetry import trace
from submissions_support import RecordingSandbox, started

from datum_sandbox.protocol import Sandbox, SandboxMiddleware

TRACER = trace.get_tracer("test-middleware")


class Spanning:
    """A middleware layer: opens a span and records its name around `validate`, delegates everything else."""

    def __init__(self, name: str, inner: Sandbox, trail: list[str]) -> None:
        self._name = name
        self._inner = inner
        self._trail = trail

    def validate(self, context: Any, rules: Any = (), *, real: bool) -> Any:
        self._trail.append(self._name)
        with TRACER.start_as_current_span(self._name):
            return self._inner.validate(context, rules, real=real)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._inner, name)


def layer(name: str, trail: list[str]) -> SandboxMiddleware:
    return lambda inner: cast("Sandbox", Spanning(name, inner, trail))


def test_two_entries_see_each_run_first_outermost_then_the_sandbox() -> None:
    trail: list[str] = []
    with started(sandbox_middleware=[layer("outer", trail), layer("inner", trail)]) as rig:
        trail.clear()
        rig.trail.clear()
        rig.submit()
    assert [name for name in trail if name in {"outer", "inner"}] == ["outer", "inner"]
    assert "sandbox" in rig.trail


def test_the_observation_span_is_innermost_below_both_entries_and_below_datum_submission() -> None:
    otel = telemetry()
    trail: list[str] = []
    with started(sandbox_middleware=[layer("outer", trail), layer("inner", trail)]) as rig:
        rig.submit()
    names = {s.name: s for s in otel.spans()}
    run, inner, outer, submission = (names[n] for n in ("datum.sandbox.run", "inner", "outer", "datum.submission"))
    assert _parent(otel, run) == inner.context.span_id
    assert _parent(otel, inner) == outer.context.span_id
    assert _parent(otel, outer) == submission.context.span_id


def test_the_observation_wraps_a_replacement_sandbox_once_not_twice() -> None:
    otel = telemetry()
    with started() as rig:
        rig.submit()
    assert len(otel.spans("datum.sandbox.run")) == 1


def test_a_recording_sandbox_below_the_chain_is_called_once_per_run() -> None:
    trail: list[str] = []
    with started(sandbox_middleware=[layer("only", trail)]) as rig:
        rig.submit()
    assert isinstance(rig.sandbox, RecordingSandbox)
    assert len(rig.sandbox.validations) == 1


def _parent(otel: Telemetry, span: Any) -> int | None:
    parent = otel.parent_of(span)
    return None if parent is None else parent.context.span_id
