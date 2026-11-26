"""Every call the service starts ends as exactly one outcome, and the observation says the same.

started = answered + interrupted + refused + failed. A mixed load (accepted, redelivered, rejected, busy, down,
interrupted, throttled, refused by a pre-check) goes through the service from eight threads; the counters, the spans
and the events are then held against the outcomes the callers received. A census of threads shows the start and the
stop leave none behind.
"""

import threading
from collections import Counter
from collections.abc import Mapping, Sequence
from concurrent.futures import ThreadPoolExecutor
from typing import Any, cast

from observe_support import telemetry
from submissions_support import RecordingSandbox, bus, envelope, http_context, refused_by_kernel, started

from datum_core.submissions import (
    Accepted,
    Allow,
    FormRef,
    IncomingSubmission,
    Redelivered,
    Refused,
    Reject,
    Rejected,
    SubmissionOutcome,
    SubmissionRedeliveredEvent,
    SubmissionRejectedEvent,
    SubmissionService,
    SubmissionThrottledEvent,
    SubmissionValidatedEvent,
    Throttled,
    Unavailable,
)
from datum_core.throttle import Allow as ThrottleAllow
from datum_core.throttle import Deny, ThrottleKey
from datum_sandbox.json import JsonValue
from datum_sandbox.protocol import ProgramUnavailableError, RuleModule, SandboxError, SandboxFailure, SandboxResult
from datum_sandbox.wasi import EngineBusyError

THREADS = 8
FLOODER = "198.51.100.9"
KINDS = ("ok", "bad", "busy", "down", "interrupted", "flood", "closed")
PER_KIND = 6


class FloodedAddress:
    """A throttle that refuses one address and lets the rest through."""

    def check(self, key: ThrottleKey) -> ThrottleAllow | Deny:
        return Deny(retry_after=3) if key.ip == FLOODER else ThrottleAllow()


def scripted(sandbox: RecordingSandbox) -> None:
    """Make the sandbox answer by the name the document carries: `<kind>-<n>`."""
    plain = sandbox.validate

    def validate(context: Mapping[str, JsonValue], rules: Sequence[RuleModule] = (), *, real: bool) -> SandboxResult:
        values = cast("Mapping[str, str]", context["values"])
        kind = values["name"].split("-")[0]
        if kind == "busy":
            raise EngineBusyError("slots")
        if kind == "down":
            raise ProgramUnavailableError("down")
        if kind == "interrupted":
            raise SandboxError(SandboxFailure.INTERRUPTED, "the runtime stopped")
        if kind == "bad":
            return refused_by_kernel()
        return plain(context, rules, real=real)

    sandbox.validate = validate  # type: ignore[method-assign]


def refuse_closed(incoming: IncomingSubmission) -> Allow | Reject:
    headers = incoming.context.headers or {}
    return Reject("form.closed", "Closed") if headers.get("x-case") == "closed" else Allow()


def jobs() -> list[tuple[str, int]]:
    return [(kind, number) for number in range(PER_KIND) for kind in KINDS]


def call(service: SubmissionService, kind: str, number: int) -> SubmissionOutcome:
    document = envelope(values={"name": f"{kind}-{number}"})
    # One attempt per job: running a job again is a retry of that attempt (its key).
    attempt = f"attempt-{kind}-{number}"
    context = http_context(ip=FLOODER, submission_key=attempt) if kind == "flood" else bus(submission_key=attempt)
    if kind == "closed":
        context = bus(headers={"x-case": "closed"}, submission_key=attempt)
    return service.submit(FormRef.from_document(), document, context)


def classify(outcome: SubmissionOutcome) -> str:
    """The four ends of the invariant (answered covers accepted, redelivered and rejected)."""
    match outcome:
        case Accepted() | Redelivered() | Rejected():
            return "answered"
        case Throttled() | Refused():
            return "refused"
        case Unavailable(code="server.busy"):
            return "refused"
        case Unavailable(cause=SandboxError() as cause) if cause.reason is SandboxFailure.INTERRUPTED:
            return "interrupted"
        case Unavailable():
            return "failed"
        case _:
            raise AssertionError(f"an unplanned outcome: {outcome!r}")


def test_every_started_call_ends_as_one_outcome_and_the_observation_agrees() -> None:
    otel = telemetry()
    seen = telemetry_snapshot(otel)
    census_before = {t.ident for t in threading.enumerate()}
    with started(pre_checks=[refuse_closed], throttle=FloodedAddress()) as rig:
        scripted(rig.sandbox)
        with ThreadPoolExecutor(THREADS) as pool:
            first = list(pool.map(lambda job: call(rig.service, *job), jobs()))
            again = list(pool.map(lambda job: call(rig.service, *job), [job for job in jobs() if job[0] == "ok"]))
        outcomes = [*first, *again]
        events = list(rig.events)
        handler_calls = len(rig.handler.calls)

    # the invariant: started = answered + interrupted + refused + failed
    ends = Counter(classify(outcome) for outcome in outcomes)
    assert sum(ends.values()) == len(outcomes) == len(jobs()) + PER_KIND
    assert ends == {
        "answered": 3 * PER_KIND,  # ok, bad, and the repeats of ok
        "refused": 3 * PER_KIND,  # flooded, closed by a pre-check, busy
        "interrupted": PER_KIND,
        "failed": PER_KIND,  # down
    }

    kinds = Counter(type(outcome).__name__ for outcome in outcomes)
    assert kinds["Accepted"] == PER_KIND
    assert kinds["Redelivered"] == PER_KIND
    assert kinds["Rejected"] == PER_KIND
    assert kinds["Throttled"] == PER_KIND
    assert kinds["Refused"] == PER_KIND

    # the counters say what the callers were told
    received = delta(otel, seen, "datum.submission.received")
    assert received == len(outcomes)
    assert delta(otel, seen, "datum.request.throttled") == PER_KIND
    assert delta(otel, seen, "datum.sandbox.run.rejected") == PER_KIND  # busy, once each
    assert otel.total("datum.sandbox.run.active", **{"datum.program": "sandbox"}) == seen["active"]  # all returned
    assert len(otel.spans("datum.submission")) == len(outcomes)

    # the events say it too: one per outcome that earns one, none for a refusal before the run
    by_type = Counter(type(event) for event in events)
    assert by_type[SubmissionValidatedEvent] == kinds["Accepted"] == handler_calls
    assert by_type[SubmissionRedeliveredEvent] == kinds["Redelivered"]
    assert by_type[SubmissionRejectedEvent] == kinds["Rejected"]
    assert by_type[SubmissionThrottledEvent] == kinds["Throttled"]

    # the start and the stop leave no thread behind
    leftover = [t for t in threading.enumerate() if t.ident not in census_before and t.is_alive()]
    assert leftover == []


def telemetry_snapshot(otel: Any) -> dict[str, float]:
    return {
        name: otel.total(name)
        for name in (
            "datum.submission.received",
            "datum.request.throttled",
            "datum.sandbox.run.rejected",
        )
    } | {"active": otel.total("datum.sandbox.run.active", **{"datum.program": "sandbox"})}


def delta(otel: Any, seen: dict[str, float], name: str) -> float:
    return float(otel.total(name)) - seen[name]
