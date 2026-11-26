"""The typed event dispatcher: guarded, sequential, list-ordered delivery.

Datum opens no transaction. An event published inside an application's transaction precedes its commit, and a listener
cannot veto anything: whatever a listener does, the answer and the effect stand. Each concrete event's docstring says
when it is published and whether it can fall inside a caller's transaction.
"""

import logging
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from datetime import datetime
from typing import Literal, Protocol, cast

from datum_core.hooks import Awaiter, MaybeAwaitable, call_hook, is_async_callable
from datum_core.loggers import EVENTS
from datum_sandbox.checks import DatumConfigurationError

logger = logging.getLogger(EVENTS)


@dataclass(frozen=True, slots=True)
class DatumEvent:
    """The base of every event: a frozen, slotted record that does not cross the wire."""


class EngineDescription(Protocol):
    """What an engine says about itself, as an event carries it (`datum_sandbox.wasi.EngineInfo` is one).

    The event names this read-only shape instead of the engine's record; every `EngineInfo` satisfies it. Whether the
    PDF program runs is the sandbox's decision (`pdfCapable` on the `runtime` health), not the engine's.
    """

    @property
    def id(self) -> str:
        """The engine id (`wasmtime`)."""
        ...

    @property
    def release(self) -> str:
        """The engine's own release."""
        ...

    @property
    def mode(self) -> str:
        """How the engine runs the guest (its compilation mode)."""
        ...

    @property
    def notes(self) -> tuple[str, ...]:
        """Free notes for health and logs."""
        ...


@dataclass(frozen=True, slots=True)
class DatumRuntimeReadyEvent(DatumEvent):
    """Published once per start, after the ABI proof and the warm-ups, from the thread that ran the start.

    It never falls inside a caller's transaction (no request is being served yet). `warm_up_millis` is the wall time
    of the smoke and warm-up runs together; `sandbox_abi` and `pdf_abi` are the ABIs the programs declare.
    """

    engine: EngineDescription
    sandbox_abi: str = ""
    pdf_abi: str = ""
    warm_up_millis: float = 0.0


type InterruptReason = Literal["budget", "memory", "trap", "output-cap", "interrupted"]
"""Why the runtime stopped a run: its time budget, its memory, a trap, an output cap, or the shutdown stop."""


@dataclass(frozen=True, slots=True)
class SandboxRunInterruptedEvent(DatumEvent):
    """Published when the runtime stops a sandbox run, on the thread that asked for the run, after the run ended.

    Inside an application's transaction it precedes the commit (Datum opens none). `program` is the program's kind
    (`sandbox`), `elapsed` the call's wall time in seconds. A listener cannot change the answer: the caller still gets
    the refusal the stop caused.
    """

    program: str
    reason: InterruptReason
    elapsed: float


@dataclass(frozen=True, slots=True)
class FormDefinitionSavedEvent(DatumEvent):
    """Published by the builder once a definition is stored, on the thread that saved it, before the call returns.

    It follows the store, the catalog's move and the snapshots, and is never published for a refusal or for a catalog
    write. Inside an application's transaction it precedes the commit (Datum opens none); a listener cannot change the
    answer or undo the save. `key` is the form, `sha256` the hash of what was stored (the author's copy's ETag) and
    `previous_sha256` the hash it replaced (`None` for a create). It carries no definition text.

    It is published after the form's lock is released, so two in-process saves of one form may publish out of store
    order; `previous_sha256` orders them (each names the hash it replaced).
    """

    key: str
    sha256: str
    previous_sha256: str | None


@dataclass(frozen=True, slots=True)
class TimestampIssuedEvent(DatumEvent):
    """Published by the timestamp authority once a token is made and its log row is kept, on the thread that made it.

    It follows the signature, the read-back and the log, so a refused request, a log that failed and a token the
    authority never completed publish none. Inside an application's transaction it precedes the commit (Datum opens
    none); a listener cannot change the answer or undo the token. `client` is the client store's id for the caller
    (None: an open endpoint or the host's own token), never the key it presented. It carries no imprint and no nonce.
    """

    serial: int
    gen_time: datetime
    imprint_algorithm: str
    client: str | None


@dataclass(frozen=True, slots=True)
class TimestampRefusedEvent(DatumEvent):
    """Published by the timestamp authority when it answers a rejection, on the thread that judged the request.

    `fail_info` is the RFC 3161 failure name (`badAlg`, `systemFailure`, ...) and `reason` Datum's own status text for
    it. It carries no request byte, no imprint, no nonce, no client and no exception text. A refusal publishes this
    event only: no serial was taken and the key signed nothing.
    """

    fail_info: str
    reason: str


@dataclass(frozen=True, slots=True)
class PdfRenderedEvent(DatumEvent):
    """Published by the PDF service once a PDF is made and sealed, on the thread that made it, before the call returns.

    It follows the validators and the seal, so a refused step (throttle, availability, dry run, customizer, program,
    validator, an unknown layout) publishes none; it is best effort as a record (a record needed before release is a
    result validator's write). Inside an application's transaction it precedes the commit (Datum opens none); a
    listener cannot change the answer. `op` is `render`, `fill`, `sign` or `render_submission`, `bytes` the size of the
    answered file, `layout_id` the layout printed (None when the program named none), `signed` and `timestamped` what
    the file carries. It holds scalars only: no bytes, digest, key or certificate.
    """

    form_key: str | None
    op: str
    bytes: int
    layout_id: str | None
    signed: bool
    timestamped: bool


@dataclass(frozen=True, slots=True)
class PdfVerifiedEvent(DatumEvent):
    """Published by the PDF service after a verify report is made, on the thread that made it, before the call returns.

    A file that is not a PDF, too large, unreadable, throttled or not read for want of a runtime publishes none. Inside
    an application's transaction it precedes the commit (Datum opens none); a listener cannot change the report.
    `sha256` (lowercase hex) and `size` name the file, `document_id` is the report's, `signatures` the number of
    signatures and `trust_policy` the policy's name. It never carries the file.
    """

    sha256: str
    size: int
    document_id: str | None
    signatures: int
    trust_policy: str


type Listener = Callable[..., MaybeAwaitable[None]]
"""A listener as the dispatcher stores it; `listener()` is what types it against its event."""

type ListenerEntry = tuple[type[DatumEvent], Listener]
"""An `(EventType, fn)` pair; build it with `listener()` so a wrong parameter type is a type error."""


def listener[E: DatumEvent](event: type[E], fn: Callable[[E], MaybeAwaitable[None]]) -> ListenerEntry:
    """Pair an event type with a listener typed for it (sync or async, a function, partial, lambda or instance)."""
    return (event, fn)


class EventDispatcher:
    """Deliver events to listeners: list order, `isinstance` match, failures logged and never raised.

    A listener on a base class sees its subclasses; a bus is one forwarding listener on `DatumEvent`. A sync listener
    runs inline on the calling (worker) thread, an async one through the awaiter. A listener that raises `Exception` (an
    `AssertionError` or `RecursionError` included) is logged at ERROR on `datum.events` with its traceback and delivery
    goes on; `MemoryError` and everything that is not an `Exception` (cancellation, `SystemExit`, `KeyboardInterrupt`)
    propagates.
    """

    def __init__(self, listeners: Iterable[ListenerEntry] = (), *, awaiter: Awaiter | None = None) -> None:
        """Keep the listeners in the order given; the awaiter may be handed over later with `bind`."""
        self._entries: tuple[ListenerEntry, ...] = tuple(listeners)
        for event, fn in self._entries:
            if not (isinstance(cast("object", event), type) and issubclass(cast("type", event), DatumEvent)):
                raise TypeError(f"a listener is registered for a DatumEvent subclass, not {event!r}")
            if not callable(fn):
                raise TypeError(f"a listener for {event.__name__} is not callable: {fn!r}")
        self._awaiter = awaiter
        self._closed = False

    def scoped(self) -> "EventDispatcher":
        """Return a dispatcher over the same listeners and awaiter that can be closed on its own."""
        return EventDispatcher(self._entries, awaiter=self._awaiter)

    def close(self) -> None:
        """Stop delivering: a later `publish` drops its event with one DEBUG line naming the type."""
        self._closed = True

    @property
    def closed(self) -> bool:
        """Whether `close()` ran: the owner of this dispatcher has stopped."""
        return self._closed

    def bind(self, awaiter: Awaiter | None) -> None:
        """Hand over the binding's awaiter (done once at start)."""
        self._awaiter = awaiter

    def validate(self) -> None:
        """Raise `DatumConfigurationError` when an async listener is registered and there is no awaiter."""
        if self._awaiter is None:
            names = [getattr(fn, "__qualname__", repr(fn)) for _, fn in self._entries if is_async_callable(fn)]
            if names:
                raise DatumConfigurationError(
                    f"async listeners need an awaiter: {', '.join(names)}",
                    hint="use the binding that supplies one, or make the listeners plain functions",
                )

    @property
    def listeners(self) -> tuple[ListenerEntry, ...]:
        """The registered pairs, in order."""
        return self._entries

    def publish(self, event: DatumEvent) -> None:
        """Deliver `event` to every listener whose type it is an instance of, in list order, before returning."""
        if self._closed:
            logger.debug("event %s dropped: its dispatcher is closed", type(event).__name__)
            return
        for kind, fn in self._entries:
            if not isinstance(event, kind):
                continue
            try:
                call_hook(fn, self._awaiter, event)
            except MemoryError:
                raise
            except Exception:
                logger.exception(
                    "listener %s failed on %s",
                    getattr(fn, "__qualname__", repr(fn)),
                    type(event).__name__,
                    extra={"datum_event": type(event).__name__},
                )
