"""Datum's observation: spans and instruments through the OpenTelemetry API alone.

`datum.submission` wraps one service call and `datum.sandbox.run` one call of the sandbox (the innermost layer, so a
queue consumer or a batch gets both as a route does). `datum.pdf.run` wraps one call of the PDF kernel the same way
(`ObservedPdfKernel`): the same attributes and instruments, with `datum.program` set to `pdf`.
`datum.tsa.issue` wraps one token of the timestamp authority (opened in `datum_core.timestamp.authority`, under
this same tracer name and scope, so a seal or a receipt gets it as the endpoint does): `datum.channel`, `datum.outcome`
(`granted` or `refused`) and, on a refusal, `error.type` set to the RFC 3161 failure name. It carries no imprint, nonce,
serial, key or client. The tracer and the meter are acquired at import under the name
`datum`: the API hands out proxies that follow a provider installed later, so a host that configures OpenTelemetry after
importing Datum still sees every span and metric. There is no SDK import, no exporter, no logging handler and no
Prometheus client here; with no provider every call is a no-op.

Libraries: `opentelemetry.trace` and `opentelemetry.metrics` are the instrument; `contextvars` carries the
per-call state a repository wrapper fills in (the form, once found) back to the span that is open on the same thread.
The two classes below exist because the service is a plain class with no observation seam: `ObservedSubmissionService`
subclasses it to open the span around its four calls (`isinstance(..., SubmissionService)` still holds), and
`_ObservedRepository` reports "the form was found" without the service knowing OpenTelemetry exists.

Attributes are `datum.`-prefixed (except `error.type`) and carry no answer, byte, digest, address or secret. The form id
rides only on `datum.submission` and on the received counter. A refused or rejected submission is a normal outcome
(status unset); the error status and `error.type` mark an infrastructure failure only.
"""

import contextvars
import functools
import importlib.metadata
import threading
import time
from collections.abc import Callable, Iterable, Iterator, Mapping
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Final

from opentelemetry import metrics, trace
from opentelemetry.metrics import CallbackOptions, Observation
from opentelemetry.trace import Span, Status, StatusCode

from datum_core.config.models import LogLevel
from datum_core.forms import FormDefinitionRepository, StoredDefinition
from datum_core.submissions import (
    Accepted,
    Checked,
    DryRun,
    FormRef,
    Inspected,
    InspectOutcome,
    JourneyCheck,
    KeyConflict,
    Malformed,
    NotFound,
    Outdated,
    Redelivered,
    Refused,
    Rejected,
    SubmissionContext,
    SubmissionMode,
    SubmissionOutcome,
    SubmissionService,
    Throttled,
    TooLarge,
    Unavailable,
)
from datum_sandbox.json import JsonValue
from datum_sandbox.protocol import (
    PdfCapabilities,
    PdfCompleted,
    PdfInspected,
    PdfKernel,
    PdfKernelError,
    PdfProduced,
    PdfSigned,
    PdfVerified,
    Program,
    SandboxError,
    SandboxFailure,
)
from datum_sandbox.wasi import EngineBusyError, EngineClosedError

__all__ = [
    "CORE_VERSION",
    "RUN_DURATION_BUCKETS",
    "Instruments",
    "ObservedPdfKernel",
    "ObservedSubmissionService",
    "PdfCall",
    "instruments",
    "observed_repository",
    "pdf_observed",
    "quiet",
    "run_observed",
    "watch_slots",
]


def _version() -> str:
    try:
        return importlib.metadata.version("argusvane-datum-core")
    except importlib.metadata.PackageNotFoundError:
        return "unknown"


CORE_VERSION: Final = _version()
"""argusvane-datum-core's own version: the instrumentation scope's version."""

RUN_DURATION_BUCKETS: Final = (0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 30.0, 60.0, 120.0, 300.0)
"""The advisory bucket boundaries of the run histograms, in seconds: a warm validation takes tens of milliseconds, a
budgeted one up to its wall limit (the PDF default is 60 s and its bound 300 s)."""

PROGRAM: Final = "sandbox"
PDF_PROGRAM: Final = "pdf"
_RAN: Final = "completed"

tracer = trace.get_tracer("datum", CORE_VERSION)
meter = metrics.get_meter("datum", CORE_VERSION)


@dataclass(frozen=True, slots=True)
class Instruments:
    """The instruments that the submission path records (the slot limit gauge: see `watch_slots`)."""

    run_duration: metrics.Histogram
    run_wait: metrics.Histogram
    run_active: metrics.UpDownCounter
    run_rejected: metrics.Counter
    submissions_received: metrics.Counter
    requests_throttled: metrics.Counter
    pdf_output_size: metrics.Histogram


def _instruments() -> Instruments:
    return Instruments(
        run_duration=meter.create_histogram(
            "datum.sandbox.run.duration",
            unit="s",
            description="Wall time of a sandbox call, by program and outcome.",
            explicit_bucket_boundaries_advisory=list(RUN_DURATION_BUCKETS),
        ),
        run_wait=meter.create_histogram(
            "datum.sandbox.run.wait.duration",
            unit="s",
            description="Time before the guest ran: the wait for a slot, or the whole wait of a refused call.",
            explicit_bucket_boundaries_advisory=list(RUN_DURATION_BUCKETS),
        ),
        run_active=meter.create_up_down_counter(
            "datum.sandbox.run.active", unit="{run}", description="Sandbox calls in progress."
        ),
        run_rejected=meter.create_counter(
            "datum.sandbox.run.rejected", unit="{run}", description="Calls refused because every slot stayed taken."
        ),
        submissions_received=meter.create_counter(
            "datum.submission.received", unit="{submission}", description="Deliveries answered, by outcome and form."
        ),
        requests_throttled=meter.create_counter(
            "datum.request.throttled", unit="{request}", description="Calls the throttle refused, by channel."
        ),
        pdf_output_size=meter.create_histogram(
            "datum.pdf.output.size", unit="By", description="Size of the PDF a call answered, by operation."
        ),
    )


instruments: Final = _instruments()

_SLOT_SOURCES: Final[dict[int, Callable[[], int]]] = {}
_SLOT_LOCK: Final = threading.Lock()


def _observe_slot_limit(_options: CallbackOptions) -> Iterable[Observation]:
    with _SLOT_LOCK:
        sources = list(_SLOT_SOURCES.values())
    if sources:
        yield Observation(sum(read() for read in sources))


meter.create_observable_gauge(
    "datum.sandbox.slot.limit",
    callbacks=[_observe_slot_limit],
    unit="{slot}",
    description="Run slots of the sandbox runtime: the most calls that run at once.",
)


def watch_slots(read: Callable[[], int]) -> Callable[[], None]:
    """Report `read()` on the slot limit gauge until the returned function is called (one runtime's slots)."""
    token = id(read)
    with _SLOT_LOCK:
        _SLOT_SOURCES[token] = read

    def stop() -> None:
        with _SLOT_LOCK:
            _SLOT_SOURCES.pop(token, None)

    return stop


# -- datum.sandbox.run ---------------------------------------------------------------------------------------------
def _run_outcome(error: Exception) -> str:
    if isinstance(error, SandboxError):
        return error.reason.value
    if isinstance(error, PdfKernelError):
        return _REFUSED
    if isinstance(error, EngineBusyError):
        return SandboxFailure.BUSY.value
    if isinstance(error, EngineClosedError):
        return SandboxFailure.INTERRUPTED.value
    return "failed"


_REFUSED: Final = "refused"
_QUIET: contextvars.ContextVar[bool] = contextvars.ContextVar("datum_observation_quiet", default=False)


@contextmanager
def quiet() -> Iterator[None]:
    """Make the sandbox calls inside the block (on this thread's context) unobserved: the start's own proof runs.

    The ABI proof and the warm-up runs of a start are not requests: as spans they would be root traces nobody asked
    for, and as samples they would colour the run histograms with the compile-time warm-up.
    """
    token = _QUIET.set(True)
    try:
        yield
    finally:
        _QUIET.reset(token)


def run_observed[T](
    op: str,
    engine_mode: str,
    call: Callable[[], T],
    *,
    ran: Callable[[T], float | None] = lambda _result: None,
    span_name: str = "datum.sandbox.run",
    program_name: str = PROGRAM,
) -> T:
    """Run one sandbox call inside a `datum.sandbox.run` span and record its instruments; errors rise as they are.

    `span_name` and `program_name` name another program's calls the same way (`datum.pdf.run`, ``pdf``).

    `ran` reads the guest's own run time from a result that carries one (a validation, a smoke run): what remains of
    the wall time was spent before the guest ran, which is the wait for a slot plus the framing, and is recorded as the
    wait. A call refused for want of a slot records its whole wall time as the wait, counts once on
    `datum.sandbox.run.rejected` and is not an error span (a refusal is a normal outcome). Any other failure marks the
    span with the error status and `error.type`.
    """
    if _QUIET.get():
        return call()
    program = {"datum.program": program_name}
    instruments.run_active.add(1, program)
    began = time.perf_counter()
    try:
        with tracer.start_as_current_span(
            span_name,
            attributes={"datum.op": op, "datum.engine.mode": engine_mode},
            record_exception=False,
            set_status_on_exception=False,
        ) as span:
            try:
                result = call()
            except Exception as error:
                _record_failure(span, error, time.perf_counter() - began, program_name)
                raise
            wall = time.perf_counter() - began
            span.set_attribute("datum.outcome", _RAN)
            instruments.run_duration.record(wall, {**program, "datum.outcome": _RAN})
            guest = ran(result)
            if guest is not None:
                instruments.run_wait.record(max(0.0, wall - guest), program)
            return result
    finally:
        instruments.run_active.add(-1, program)


def count_busy(wait: float, program_name: str = PROGRAM) -> None:
    """Count one refused call: the rejection counter and the whole wait of the call (one path for every caller)."""
    instruments.run_rejected.add(1, {"datum.reason": "busy"})
    instruments.run_wait.record(max(0.0, wait), {"datum.program": program_name})


def _record_failure(span: Span, error: Exception, wall: float, program_name: str = PROGRAM) -> None:
    outcome = _run_outcome(error)
    span.set_attribute("datum.outcome", outcome)
    program = {"datum.program": program_name}
    if outcome == SandboxFailure.BUSY.value:
        count_busy(wall, program_name)
        return
    if outcome == _REFUSED:
        # The program judged the request (a template it cannot read, a layout it does not know): the run worked.
        instruments.run_duration.record(wall, {**program, "datum.outcome": outcome})
        return
    span.set_status(Status(StatusCode.ERROR))
    span.set_attribute("error.type", type(error).__name__)
    instruments.run_duration.record(wall, {**program, "datum.outcome": outcome, "error.type": type(error).__name__})


# -- datum.pdf.run -------------------------------------------------------------------------------------------------
class ObservedPdfKernel:
    """Datum's observation, the innermost PDF kernel layer: a `datum.pdf.run` span and the run instruments per call.

    One span per call of the kernel (`datum.op`, `datum.engine.mode`, `datum.outcome`); the ABI gate's own run, made
    inside the first call, is part of that call. A program's refusal (`PdfKernelError`) is the outcome ``refused``, a
    normal outcome; a stop of the run marks the span with the error status as the sandbox's does. Nothing of the
    request or the answer is recorded. Compose it with `compose_pdf_kernel(..., observation=...)`.
    """

    def __init__(
        self,
        inner: PdfKernel,
        engine_mode: Callable[[], str],
        interrupted: Callable[[SandboxError, float], None] | None = None,
    ) -> None:
        """Wrap `inner`; `engine_mode` is read at each call (the engine's mode word).

        `interrupted` is told of a call the runtime stopped (the `SandboxError` and the call's wall time in seconds)
        before the error rises again: the owner publishes the interrupted-run event from it.
        """
        self._inner = inner
        self._engine_mode = engine_mode
        self._interrupted = interrupted

    @property
    def program(self) -> Program:
        """The program the wrapped kernel runs."""
        return self._inner.program

    def capabilities(self) -> PdfCapabilities:
        """See `PdfKernel.capabilities`."""
        return self._watched("capabilities", self._inner.capabilities)

    def document(self, request: Mapping[str, JsonValue]) -> PdfProduced:
        """See `PdfKernel.document`."""
        return self._watched("document", lambda: self._inner.document(request))

    def fill(self, request: Mapping[str, JsonValue]) -> PdfProduced:
        """See `PdfKernel.fill`."""
        return self._watched("fill", lambda: self._inner.fill(request))

    def sign(self, request: Mapping[str, JsonValue]) -> PdfSigned:
        """See `PdfKernel.sign`."""
        return self._watched("sign", lambda: self._inner.sign(request))

    def complete(self, request: Mapping[str, JsonValue]) -> PdfCompleted:
        """See `PdfKernel.complete`."""
        return self._watched("complete", lambda: self._inner.complete(request))

    def verify(self, request: Mapping[str, JsonValue]) -> PdfVerified:
        """See `PdfKernel.verify`."""
        return self._watched("verify", lambda: self._inner.verify(request))

    def inspect(self, request: Mapping[str, JsonValue]) -> PdfInspected:
        """See `PdfKernel.inspect`."""
        return self._watched("inspect", lambda: self._inner.inspect(request))

    def _watched[T](self, op: str, call: Callable[[], T]) -> T:
        began = time.perf_counter()
        try:
            return run_observed(op, self._engine_mode(), call, span_name="datum.pdf.run", program_name=PDF_PROGRAM)
        except SandboxError as error:
            if self._interrupted is not None:
                self._interrupted(error, time.perf_counter() - began)
            raise


# -- datum.pdf -----------------------------------------------------------------------------------------------------
@dataclass(slots=True)
class PdfCall:
    """What one open `datum.pdf` span learns on its way; `finish` writes it once the call has an answer.

    The span names the operation, the outcome, which key sealed the file and where its token came from, and the form
    once the repository found it. It carries no answer, byte, digest, certificate or key.
    """

    op: str
    span: Span
    state: "_Call"

    def finish(
        self, outcome: str, *, seal: str | None = None, timestamp: str | None = None, size: int | None = None
    ) -> None:
        """Record the outcome; `seal` and `timestamp` are the words of a printed file; `size` feeds the histogram."""
        self.span.set_attribute("datum.outcome", outcome)
        if seal is not None:
            self.span.set_attribute("datum.pdf.seal", seal)
        if timestamp is not None:
            self.span.set_attribute("datum.pdf.timestamp", timestamp)
        if self.state.form is not None:
            self.span.set_attribute("datum.form", self.state.form)
        if size is not None:
            instruments.pdf_output_size.record(size, {"datum.pdf.op": self.op})

    def unavailable(self, cause: str) -> None:
        """Mark the span as an infrastructure failure (the service could not run), naming the cause's type only."""
        self.span.set_status(Status(StatusCode.ERROR))
        self.span.set_attribute("error.type", cause)


@contextmanager
def pdf_observed(op: str) -> Iterator[PdfCall]:
    """Open a `datum.pdf` span for one call of the PDF service; the repository tells it the form it found.

    An exception that rises out marks the span with the error status and `error.type` and is raised again.
    """
    state = _Call()
    token = _CALL.set(state)
    try:
        with tracer.start_as_current_span(
            "datum.pdf", attributes={"datum.pdf.op": op}, record_exception=False, set_status_on_exception=False
        ) as span:
            try:
                yield PdfCall(op, span, state)
            except Exception as error:
                span.set_status(Status(StatusCode.ERROR))
                span.set_attribute("error.type", type(error).__name__)
                raise
    finally:
        _CALL.reset(token)


# -- datum.submission ----------------------------------------------------------------------------------------------
@dataclass(slots=True)
class _Call:
    """What the open call learns on its way: the form id, once the repository has found the form."""

    form: str | None = None


_CALL: contextvars.ContextVar[_Call | None] = contextvars.ContextVar("datum_submission_call", default=None)

_NAMES: Final[dict[type, str]] = {
    Accepted: "accepted",
    Redelivered: "redelivered",
    KeyConflict: "key_conflict",
    Rejected: "rejected",
    Checked: "checked",
    DryRun: "dry_run",
    Outdated: "outdated",
    NotFound: "not_found",
    Malformed: "malformed",
    TooLarge: "too_large",
    Refused: "refused",
    Throttled: "throttled",
    Unavailable: "unavailable",
    Inspected: "inspected",
}


class _ObservedRepository:
    """Tells the open call which form was found (stale or not); everything else is the repository's."""

    def __init__(self, inner: FormDefinitionRepository) -> None:
        self._inner = inner

    def current(self, key: str) -> StoredDefinition | None:
        found = self._inner.current(key)
        call = _CALL.get()
        if found is not None and call is not None:
            call.form = key
            trace.get_current_span().set_attribute("datum.form", key)
        return found


def observed_repository(repository: FormDefinitionRepository) -> FormDefinitionRepository:
    """Wrap `repository` so the `datum.submission` span open on this thread learns the form once it is found."""
    return _ObservedRepository(repository)


def _unavailable_type(outcome: Unavailable) -> str:
    return type(outcome.cause).__name__ if outcome.cause is not None else outcome.code


class ObservedSubmissionService(SubmissionService):
    """`SubmissionService` with a `datum.submission` span around each call and the received and throttled counters."""

    def submit(self, form: FormRef, document: object, context: SubmissionContext) -> SubmissionOutcome:
        """See `SubmissionService.submit`."""
        return self._observed(
            SubmissionMode.SUBMIT.value, context.channel, functools.partial(super().submit, form, document, context)
        )

    def validate(
        self, form: FormRef, document: object, context: SubmissionContext, *, check: JourneyCheck | None = None
    ) -> SubmissionOutcome:
        """See `SubmissionService.validate`."""
        return self._observed(
            SubmissionMode.VALIDATE.value,
            context.channel,
            functools.partial(super().validate, form, document, context, check=check),
        )

    def test(
        self, form: FormRef, document: object, context: SubmissionContext, *, log_level: LogLevel | str | None = None
    ) -> SubmissionOutcome:
        """See `SubmissionService.test`."""
        return self._observed(
            SubmissionMode.TEST.value,
            context.channel,
            functools.partial(super().test, form, document, context, log_level=log_level),
        )

    def inspect(self, op: str, definition: object, context: SubmissionContext) -> InspectOutcome:
        """See `SubmissionService.inspect`."""
        return self._observed("inspect", context.channel, functools.partial(super().inspect, op, definition, context))

    def address_refusal(self, mode: str, address: str | None, channel: str, retry_after: int) -> Throttled:
        """See `SubmissionService.address_refusal`: the span and the throttled counter of the per-form refusal."""
        return self._observed(
            mode, channel, functools.partial(super().address_refusal, mode, address, channel, retry_after)
        )

    def _observed[T: SubmissionOutcome | InspectOutcome](self, mode: str, channel: str, call: Callable[[], T]) -> T:
        state = _Call()
        token = _CALL.set(state)
        try:
            with tracer.start_as_current_span(
                "datum.submission",
                attributes={"datum.mode": mode, "datum.channel": channel},
                record_exception=False,
                set_status_on_exception=False,
            ) as span:
                try:
                    outcome = call()
                except Exception as error:
                    span.set_status(Status(StatusCode.ERROR))
                    span.set_attribute("error.type", type(error).__name__)
                    raise
                self._record(span, mode, channel, state, outcome)
                return outcome
        finally:
            _CALL.reset(token)

    @staticmethod
    def _record(span: Span, mode: str, channel: str, state: _Call, outcome: object) -> None:
        name = _NAMES.get(type(outcome), "unknown")
        span.set_attribute("datum.outcome", name)
        if state.form is not None:
            span.set_attribute("datum.form", state.form)
        stage = outcome.stage if isinstance(outcome, Rejected | DryRun) else None
        if stage is not None:
            span.set_attribute("datum.stage", stage)
        if isinstance(outcome, Unavailable) and outcome.code != "server.busy":
            span.set_status(Status(StatusCode.ERROR))
            span.set_attribute("error.type", _unavailable_type(outcome))
        if isinstance(outcome, Throttled):
            instruments.requests_throttled.add(1, {"datum.channel": channel})
        if mode == SubmissionMode.SUBMIT.value:
            counted: dict[str, str] = {"datum.status": name}
            if state.form is not None:
                counted["datum.form"] = state.form
            instruments.submissions_received.add(1, counted)
