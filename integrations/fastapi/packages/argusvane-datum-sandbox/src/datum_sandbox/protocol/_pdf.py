"""The `PdfKernel` protocol its callers see, the records it answers, the service that runs it.

Libraries: the standard library (`typing.Protocol`, `dataclasses`, `base64`, `re`) and the sandbox's own `Program`,
`JsonValue`, `read`, `RunBudget` and `GuestRuntime` cover every shape here. `pydantic` would add validation the
strict answer reader below already does (an `ok` that is the boolean `true`, a page count that is an integer and not a
boolean, base64 that decodes), `anyio` has nothing to run (the runtime call is synchronous, on a worker thread), and no
library speaks the PDF program's operations or its ABI words (semver libraries accept ``3.18`` and ``3.18.0rc1``, and
the gate compares exactly ``N.N.N``); so the protocol, its answers, `PdfKernelService` and `compose_pdf_kernel` are
written here, once, for a middleware and a replacement kernel to implement against.

A request is the program's request minus `abi` and `op`: the service stamps both, so a customizer, a middleware or a
replacement never chooses the ABI, the operation or the program. An answer is a frozen record read strictly from the
program's reply (``ok`` the boolean `true`); a refusal of the program is the `PdfKernelError` the service raises, never
a record. The PDF bytes live only in the `pdf` field of a record that holds them, hidden from `repr`; a record names no
key and no password (the signer holds those and never hands them to the kernel: it receives `toBeSigned` and answers a
value).

`PdfKernelService` runs one PDF-pool run per call: the stdin is the request as strict JSON (the PDF script has no nonce
frame), stdout is the answer, the budget is `ProgramLimits.pdf_budget()`. The PDF ABI gate runs once per program
SHA-256 before the first request: the program accepts any request of its own major, so the gate reads the
`capabilities` reply (see `require_pdf_capabilities`). A middleware delegates every call to the kernel it was handed and
never answers in its place (the sandbox's rule).
"""

import base64
import binascii
import json
from collections.abc import Callable, Mapping, Sequence
from contextlib import AbstractContextManager, nullcontext
from dataclasses import dataclass, field
from typing import Final, Literal, Protocol, cast, final

from datum_sandbox.json import BadDocumentError, JsonValue, read
from datum_sandbox.protocol._abi import (
    PDF_ABI_MIN,
    AbiProbe,
    program_error_code,
    read_pdf_capabilities,
    require_pdf_capabilities,
)
from datum_sandbox.protocol._classify import MAX_ANSWER_DEPTH, stderr_text
from datum_sandbox.protocol._errors import (
    DatumError,
    ProgramUnavailableError,
    SandboxError,
    SandboxFailure,
    StrayBoundError,
)
from datum_sandbox.protocol._limits import ProgramLimits
from datum_sandbox.protocol._protocol import Program, ProgramKind
from datum_sandbox.protocol._run_script import PDF_RUN_SCRIPT, program_run
from datum_sandbox.protocol._watch import REFUSED, RunRecorder, clock, note_outcome, note_run, watched
from datum_sandbox.wasi import (
    EngineBusyError,
    EngineClosedError,
    EngineInfo,
    EngineStrayBoundError,
    GuestRuntime,
    RunBudget,
    RunEnd,
    RunResult,
)

__all__ = [
    "PdfCapabilities",
    "PdfCompleted",
    "PdfInspected",
    "PdfKernel",
    "PdfKernelError",
    "PdfKernelMiddleware",
    "PdfKernelService",
    "PdfProduced",
    "PdfSignatureAlgorithm",
    "PdfSigned",
    "PdfSigningHandoff",
    "PdfVerified",
    "PdfWarning",
    "compose_pdf_kernel",
]

type PdfSignatureAlgorithm = Literal["RSASSA-PKCS1-v1_5-SHA256", "ECDSA-P256-SHA256", "ECDSA-P384-SHA256"]
"""How the host must sign `toBeSigned`, decided by the key the leaf certificate certifies (the program's words)."""


@dataclass(frozen=True, slots=True)
class PdfWarning:
    """One thing the program had to say about a file; it names a component or block when it knows which."""

    code: str
    message: str
    component_id: str | None = None
    block_id: str | None = None


@dataclass(frozen=True, slots=True)
class PdfCapabilities:
    """What the `capabilities` operation answers: the program's ABI (semver text) and its feature words."""

    abi: str
    features: tuple[str, ...]
    kernel_version: str | None = None


@dataclass(frozen=True, slots=True)
class PdfSigningHandoff:
    """What the host must sign: the field, the byte range, the digests and `toBeSigned` (all decoded from base64).

    `to_be_signed` is the DER of the signed attributes: what `PdfSigner.sign` receives. `to_be_signed_digest` is for a
    signer that takes a digest only. The same `to_be_signed_digest` reaches `complete`, which catches a changed input.
    """

    field_name: str
    byte_range: tuple[int, int, int, int]
    digest: bytes
    to_be_signed: bytes
    to_be_signed_digest: bytes
    signature_algorithm: PdfSignatureAlgorithm
    sub_filter: str


@dataclass(frozen=True, slots=True)
class PdfProduced:
    """A file `document` or `fill` produced; with a `signature` in the request, `pdf` is the prepared file.

    `layout_id` and `layout_kind` (``generated``, ``template`` or ``derived``) are the layout a `document` printed
    (None from `fill`). `fields` and `areas` are the program's per-field and
    per-area reports as sent; `attachments` names the embedded files.
    """

    pdf: bytes = field(repr=False)
    page_count: int
    warnings: tuple[PdfWarning, ...] = ()
    layout_id: str | None = None
    layout_kind: str | None = None
    fields: tuple[Mapping[str, JsonValue], ...] = ()
    areas: tuple[Mapping[str, JsonValue], ...] = ()
    attachments: tuple[str, ...] = ()
    signing: PdfSigningHandoff | None = None


@dataclass(frozen=True, slots=True)
class PdfSigned:
    """What `sign` answers: the prepared file and the handoff to sign."""

    pdf: bytes = field(repr=False)
    signing: PdfSigningHandoff
    warnings: tuple[PdfWarning, ...] = ()


@dataclass(frozen=True, slots=True)
class PdfCompleted:
    """What `complete` answers: the signed file, its field, the CMS (DER) and whether a token was embedded."""

    pdf: bytes = field(repr=False)
    field_name: str
    cms: bytes = field(repr=False)
    timestamped: bool


@dataclass(frozen=True, slots=True)
class PdfVerified:
    """What `verify` answers: the program's facts about the file, as sent.

    Each entry of `signatures` is the program's report of one signature (structure, digest, certificate binding, the
    DocMDP later-revision facts, the token's facts, `toBeVerified`, `signer.publicKey`). The program verifies no
    signature value, so the host does, and `PdfService.verify` reads these entries. `document_id` is the file's
    current claim and authenticates nothing.
    """

    signatures: tuple[Mapping[str, JsonValue], ...]
    attachments: tuple[Mapping[str, JsonValue], ...] = field(default=(), repr=False)
    warnings: tuple[PdfWarning, ...] = ()
    document_id: str | None = None


@dataclass(frozen=True, slots=True)
class PdfInspected:
    """What `inspect` answers: the program's description of a PDF (pages, fields, encryption, signatures) as sent."""

    info: Mapping[str, JsonValue] = field(repr=False)


class PdfKernel(Protocol):
    """The PDF program's operations as callers see them; every refusal and the ABI gate are `PdfKernelService`'s.

    Each operation takes the program's request without `abi` and `op` and answers a record; a refusal of the program
    (``{ok: false, error: {code, message}}``) is raised as the typed error the service defines, never answered. The
    ``timestampRequest`` operation is not offered: the seal asks its imprint of a `Timestamper`.
    """

    @property
    def program(self) -> Program:
        """The program this kernel runs."""
        ...

    def capabilities(self) -> PdfCapabilities:
        """Ask the program for its ABI and features (the gate reads this, never acceptance)."""
        ...

    def document(self, request: Mapping[str, JsonValue]) -> PdfProduced:
        """Build and render a form's answers to a PDF; with ``signature`` in the request, prepare it for signing."""
        ...

    def fill(self, request: Mapping[str, JsonValue]) -> PdfProduced:
        """Fill a template PDF's fields and areas with the answers."""
        ...

    def sign(self, request: Mapping[str, JsonValue]) -> PdfSigned:
        """Prepare a signature over any PDF: the field, the placeholder, the digest and what to sign."""
        ...

    def complete(self, request: Mapping[str, JsonValue]) -> PdfCompleted:
        """Embed the host's signature value (and a timestamp token) into a prepared PDF."""
        ...

    def verify(self, request: Mapping[str, JsonValue]) -> PdfVerified:
        """Read every signature of a PDF: structure, digest and certificate binding checked, no value verified."""
        ...

    def inspect(self, request: Mapping[str, JsonValue]) -> PdfInspected:
        """Describe a PDF (pages, fields, encryption, signature count, optionally its embedded files)."""
        ...


type PdfKernelMiddleware = Callable[[PdfKernel], PdfKernel]
"""Wraps a kernel (`pdf_middleware`): delegates every call to the kernel it was handed, never answering for it."""


def compose_pdf_kernel(
    own: PdfKernel,
    *,
    replacement: PdfKernel | None = None,
    middleware: Sequence[PdfKernelMiddleware] = (),
    observation: PdfKernelMiddleware | None = None,
) -> PdfKernel:
    """Return the kernel callers use: `replacement` (when given) or `own`, wrapped once by everything.

    As `compose_sandbox`: Datum's `observation` wraps it first (innermost), then `middleware` from the last entry to the
    first, so the first entry is outermost and sees each call first. A middleware that answers `None` is refused with
    `TypeError`.
    """
    current = replacement if replacement is not None else own
    layers = [*([observation] if observation is not None else []), *reversed(middleware)]
    for layer in layers:
        wrapped = cast("PdfKernel | None", layer(current))  # a middleware is untyped code: hold it to its contract
        if wrapped is None:
            raise TypeError(f"the PDF kernel middleware {layer!r} answered None instead of a PdfKernel")
        current = wrapped
    return current


# -- the program's refusal --------------------------------------------------------------------------------------------

_MESSAGE_KEPT: Final = 2000
_RESERVED_REQUEST_KEYS: Final = frozenset({"abi", "op"})


class PdfKernelError(DatumError):
    """The PDF program refused a request (``{ok: false, error: {code, message}}``): 500 with the program's own `code`.

    `code` is the program's word (``signature``, ``template``, ``layout``, ``render_limit``, ``internal``...), or
    ``unknown`` when it gave none; `message` is the program's own text (never the request's bytes, a stderr or a
    key), cut to 2000 characters. What a refusal means on the wire (400, 404, 422) is the caller's mapping.
    """

    code = "internal"
    status = 500

    def __init__(self, code: str, message: str) -> None:
        """Keep the program's code and message."""
        super().__init__(message[:_MESSAGE_KEPT])
        self.code = code


# -- the strict answer reader -----------------------------------------------------------------------------------------

_HANDOFF_ALGORITHMS: Final = frozenset({"RSASSA-PKCS1-v1_5-SHA256", "ECDSA-P256-SHA256", "ECDSA-P384-SHA256"})


def _malformed(op: str, what: str) -> SandboxError:
    return SandboxError(SandboxFailure.NO_OUTCOME, f"The PDF program's {op} answer is not well formed ({what}).")


def _text(reply: Mapping[str, JsonValue], key: str, op: str, *, optional: bool = False) -> str | None:
    value = reply.get(key)
    if value is None and optional:
        return None
    if not isinstance(value, str):
        raise _malformed(op, key)
    return value


def _decoded(value: JsonValue, key: str, op: str) -> bytes:
    """Return the bytes of a non-empty, strictly valid base64 text (no whitespace, correct padding)."""
    if not isinstance(value, str):
        raise _malformed(op, key)
    try:
        data = base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError):
        raise _malformed(op, key) from None
    if not data:
        raise _malformed(op, key)
    return data


def _count(value: JsonValue, key: str, op: str, *, least: int = 0) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < least:
        raise _malformed(op, key)
    return value


def _objects(
    reply: Mapping[str, JsonValue], key: str, op: str, *, required: bool
) -> tuple[Mapping[str, JsonValue], ...]:
    value = reply.get(key)
    if value is None and not required:
        return ()
    if not isinstance(value, list) or not all(isinstance(item, dict) for item in value):
        raise _malformed(op, key)
    return tuple(cast("list[dict[str, JsonValue]]", value))


def _warnings(reply: Mapping[str, JsonValue], op: str) -> tuple[PdfWarning, ...]:
    found: list[PdfWarning] = []
    for item in _objects(reply, "warnings", op, required=False):
        code = _text(item, "code", op)
        message = _text(item, "message", op)
        if code is None or message is None:  # pragma: no cover - _text raises for a non-text member
            raise _malformed(op, "warnings")
        found.append(
            PdfWarning(
                code,
                message,
                _text(item, "componentId", op, optional=True),
                _text(item, "blockId", op, optional=True),
            )
        )
    return tuple(found)


def _handoff(value: JsonValue, op: str) -> PdfSigningHandoff:
    if not isinstance(value, dict):
        raise _malformed(op, "signing")
    field_name = _text(value, "field", op)
    algorithm = _text(value, "signatureAlgorithm", op)
    sub_filter = _text(value, "subFilter", op)
    byte_range = value.get("byteRange")
    if (
        not field_name
        or sub_filter is None
        or algorithm not in _HANDOFF_ALGORITHMS
        or not isinstance(byte_range, list)
        or len(byte_range) != 4  # noqa: PLR2004 - a PDF byte range is four numbers
    ):
        raise _malformed(op, "signing")
    first, second, third, fourth = (_count(item, "signing.byteRange", op) for item in byte_range)
    return PdfSigningHandoff(
        field_name=field_name,
        byte_range=(first, second, third, fourth),
        digest=_decoded(value.get("digest"), "signing.digest", op),
        to_be_signed=_decoded(value.get("toBeSigned"), "signing.toBeSigned", op),
        to_be_signed_digest=_decoded(value.get("toBeSignedDigest"), "signing.toBeSignedDigest", op),
        signature_algorithm=cast("PdfSignatureAlgorithm", algorithm),
        sub_filter=sub_filter,
    )


def _names(reply: Mapping[str, JsonValue], key: str, op: str) -> tuple[str, ...]:
    value = reply.get(key)
    if value is None:
        return ()
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        raise _malformed(op, key)
    return tuple(str(item) for item in value)


def _produced(reply: Mapping[str, JsonValue], op: str) -> PdfProduced:
    signing = reply.get("signing")
    return PdfProduced(
        pdf=_decoded(reply.get("bytes"), "bytes", op),
        page_count=_count(reply.get("pageCount"), "pageCount", op, least=1),
        warnings=_warnings(reply, op),
        layout_id=_text(reply, "layoutId", op, optional=True),
        layout_kind=_text(reply, "layoutKind", op, optional=True),
        fields=_objects(reply, "fields", op, required=False),
        areas=_objects(reply, "areas", op, required=False),
        attachments=_names(reply, "attachments", op),
        signing=None if signing is None else _handoff(signing, op),
    )


def _signed(reply: Mapping[str, JsonValue], op: str) -> PdfSigned:
    return PdfSigned(
        pdf=_decoded(reply.get("bytes"), "bytes", op),
        signing=_handoff(reply.get("signing"), op),
        warnings=_warnings(reply, op),
    )


def _completed(reply: Mapping[str, JsonValue], op: str) -> PdfCompleted:
    timestamped = reply.get("timestamped")
    field_name = _text(reply, "field", op)
    if not isinstance(timestamped, bool) or not field_name:
        raise _malformed(op, "timestamped")
    return PdfCompleted(
        pdf=_decoded(reply.get("bytes"), "bytes", op),
        field_name=field_name,
        cms=_decoded(reply.get("cms"), "cms", op),
        timestamped=timestamped,
    )


def _verified(reply: Mapping[str, JsonValue], op: str) -> PdfVerified:
    return PdfVerified(
        signatures=_objects(reply, "signatures", op, required=True),
        attachments=_objects(reply, "attachments", op, required=False),
        warnings=_warnings(reply, op),
        document_id=_text(reply, "documentId", op, optional=True),
    )


def _inspected(reply: Mapping[str, JsonValue], op: str) -> PdfInspected:
    info = reply.get("info")
    if not isinstance(info, dict):
        raise _malformed(op, "info")
    return PdfInspected(info)


def _pdf_answer(result: RunResult, budget: RunBudget) -> bytes:
    """Return the stdout of a clean PDF run (the answer, not yet decoded), or raise `SandboxError` with the reason.

    The order is the sandbox's: a capped stream first (whatever ended the run), then the time stops, the closing
    runtime, a re-check of the byte counts, then the end itself. There is no started marker, so no stop is the
    guest's own (`guest_stopped` stays false).
    """
    stderr = stderr_text(result)
    capped = SandboxError(
        SandboxFailure.OUTPUT_CAP,
        f"The PDF run wrote more than its output limit ({budget.stdout_cap} bytes to stdout, {budget.stderr_cap} to "
        "stderr).",
        stderr=stderr,
    )
    if result.end is RunEnd.OUTPUT_CAP or result.stdout_capped or result.stderr_capped:
        raise capped
    if result.end is RunEnd.BUDGET:
        raise SandboxError(
            SandboxFailure.BUDGET, f"The PDF run passed its {budget.wall_seconds:g} s budget.", stderr=stderr
        )
    if result.end is RunEnd.STUCK:
        raise SandboxError(
            SandboxFailure.BUDGET,
            f"The PDF run passed its {budget.wall_seconds:g} s budget and did not stop.",
            stderr=stderr,
        )
    if result.end is RunEnd.INTERRUPTED:
        raise SandboxError(SandboxFailure.INTERRUPTED, "The PDF runtime stopped the run while closing.", stderr=stderr)
    if len(result.stdout) > budget.stdout_cap or len(result.stderr) > budget.stderr_cap:
        raise capped
    if result.end is RunEnd.CLEAN or (result.end is RunEnd.EXIT and result.exit_code == 0):
        return result.stdout
    if result.end is RunEnd.MEMORY:
        raise SandboxError(SandboxFailure.MEMORY, "The PDF run passed its memory budget.", stderr=stderr)
    if result.end is RunEnd.TRAP:
        raise SandboxError(SandboxFailure.TRAP, "The PDF program trapped.", stderr=stderr)
    raise SandboxError(SandboxFailure.THREW, "The PDF program threw.", stderr=stderr)


def _request_json(value: Mapping[str, JsonValue]) -> bytes:
    """Write a request as strict JSON; a number or text JSON cannot carry (NaN, a lone surrogate) refuses the run."""
    try:
        return json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")
    except (ValueError, TypeError, RecursionError) as error:
        raise SandboxError(
            SandboxFailure.INPUT, f"The PDF request could not be written as JSON ({type(error).__name__})."
        ) from None


def _strict(answer: bytes, op: str, stderr: str = "") -> JsonValue:
    try:
        return read(answer, max_depth=MAX_ANSWER_DEPTH)
    except BadDocumentError:
        raise SandboxError(
            SandboxFailure.NOT_JSON, f"The PDF program's {op} answer is not JSON.", stderr=stderr
        ) from None


# -- the service ------------------------------------------------------------------------------------------------------


@final
class PdfKernelService:
    """The one `PdfKernel` implementation: runs the PDF program through a `GuestRuntime`, in the PDF pool.

    Every call: the request checked for `abi` and `op` (the service's words), the ABI gate once per program, the
    request written as strict JSON, one run (the slot is the runtime's; `EngineBusyError` is 503 `server.busy`, a full
    stray bound `StrayBoundError`, 503 `server.unavailable`), the classification of how it ended, the answer read
    strictly. The service is final: a host observes calls by wrapping the kernel it answers (`compose_pdf_kernel`),
    never by subclassing.
    """

    __slots__ = ("_limits", "_probe", "_program", "_recorder", "_runtime")

    def __init__(
        self,
        runtime: GuestRuntime,
        program: Program,
        *,
        limits: ProgramLimits | None = None,
        probe: AbiProbe | None = None,
        recorder: RunRecorder | None = None,
    ) -> None:
        """Run the PDF `program` on `runtime`; `probe` remembers which programs proved the floor.

        `recorder` receives every run's record (the diagnostics); `None` records and measures nothing.
        """
        if program.kind is not ProgramKind.PDF:
            raise ValueError(f"the PDF kernel service runs the PDF program, not the {program.kind} program")
        self._runtime = runtime
        self._program = program
        self._limits = limits or ProgramLimits()
        self._probe = probe or AbiProbe()
        self._recorder = recorder

    @property
    def program(self) -> Program:
        """The program this service runs."""
        return self._program

    @property
    def recorder(self) -> RunRecorder | None:
        """The diagnostics' recorder this service hands its runs to, or `None` while they are off."""
        return self._recorder

    def _engine_info(self) -> EngineInfo:
        return self._runtime.engine_info()

    def _watched(self, op: str) -> AbstractContextManager[None]:
        recorder = self._recorder
        if recorder is None:  # pragma: no cover - callers test it first
            return nullcontext()
        return watched(
            recorder,
            program=self._program.kind.value,
            op=op,
            abi=self._program.abi,
            sha256=self._program.sha256,
            engine=self._engine_info,
        )

    @property
    def limits(self) -> ProgramLimits:
        """The budgets runs are made with."""
        return self._limits

    # -- the operations ----------------------------------------------------------------------------------------------

    def capabilities(self) -> PdfCapabilities:
        """Ask the program for its ABI and features (the gate's own question: it does not itself run the gate)."""
        if self._recorder is None:
            return self._capabilities()
        with self._watched("capabilities"):
            return self._capabilities()

    def _capabilities(self) -> PdfCapabilities:
        answer = _strict(self._run_op("capabilities", {}), "capabilities")
        try:
            abi, features, kernel_version = read_pdf_capabilities(answer)
        except ProgramUnavailableError:
            if self._recorder is not None:
                note_outcome(REFUSED)
            raise
        return PdfCapabilities(abi, features, kernel_version)

    def document(self, request: Mapping[str, JsonValue]) -> PdfProduced:
        """Build and render a form's answers to a PDF; with ``signature`` in the request, prepare it for signing."""
        if self._recorder is None:
            return _produced(self._call("document", request), "document")
        with self._watched("document"):
            return _produced(self._call("document", request), "document")

    def fill(self, request: Mapping[str, JsonValue]) -> PdfProduced:
        """Fill a template PDF's fields and areas with the answers."""
        if self._recorder is None:
            return _produced(self._call("fill", request), "fill")
        with self._watched("fill"):
            return _produced(self._call("fill", request), "fill")

    def sign(self, request: Mapping[str, JsonValue]) -> PdfSigned:
        """Prepare a signature over any PDF: the field, the placeholder, the digest and what to sign."""
        if self._recorder is None:
            return _signed(self._call("sign", request), "sign")
        with self._watched("sign"):
            return _signed(self._call("sign", request), "sign")

    def complete(self, request: Mapping[str, JsonValue]) -> PdfCompleted:
        """Embed the host's signature value (and a timestamp token) into a prepared PDF."""
        if self._recorder is None:
            return _completed(self._call("complete", request), "complete")
        with self._watched("complete"):
            return _completed(self._call("complete", request), "complete")

    def verify(self, request: Mapping[str, JsonValue]) -> PdfVerified:
        """Read every signature of a PDF: structure, digest and certificate binding checked, no value verified."""
        if self._recorder is None:
            return _verified(self._call("verify", request), "verify")
        with self._watched("verify"):
            return _verified(self._call("verify", request), "verify")

    def inspect(self, request: Mapping[str, JsonValue]) -> PdfInspected:
        """Describe a PDF (pages, fields, encryption, signature count, optionally its embedded files)."""
        if self._recorder is None:
            return _inspected(self._call("inspect", request), "inspect")
        with self._watched("inspect"):
            return _inspected(self._call("inspect", request), "inspect")

    def prove_abi(self) -> None:
        """Prove the program answers for `PDF_ABI_MIN`, once per program SHA-256; a refusal is never remembered.

        Raises `ProgramUnavailableError` (with the rebuild hint) when the reply is not a `capabilities` answer, its ABI
        is older than the floor or of another major, or a feature the host needs is missing; and `SandboxError`
        (`BUSY`, `INTERRUPTED`) or `StrayBoundError` when the probe could not run at all.
        """
        if self._probe.proved(self._program.sha256, PDF_ABI_MIN, kind="pdf"):
            return
        if self._recorder is None:
            self._prove_abi()
            return
        with self._watched("probe"):
            self._prove_abi()

    def _prove_abi(self) -> None:
        try:
            answer: JsonValue = _strict(self._run_op("capabilities", {}), "capabilities")
        except SandboxError as error:
            if error.reason in {SandboxFailure.BUSY, SandboxFailure.INTERRUPTED}:
                raise
            raise ProgramUnavailableError(
                f"The PDF program did not answer the ABI {PDF_ABI_MIN} probe ({error.reason}). Rebuild the program "
                "assets (npm run fastapi:assets) or install a argusvane-datum-programs release that ships them."
            ) from error
        try:
            require_pdf_capabilities(answer)
        except ProgramUnavailableError:
            if self._recorder is not None:
                note_outcome(REFUSED)  # the program answered: an ABI or feature it lacks is its own refusal
            raise
        self._probe.remember(self._program.sha256, PDF_ABI_MIN, kind="pdf")

    # -- one run -----------------------------------------------------------------------------------------------------

    def _call(self, op: str, request: Mapping[str, JsonValue]) -> dict[str, JsonValue]:
        """Gate, run and read one operation: the program's reply as an object whose `ok` was `true`."""
        clash = _RESERVED_REQUEST_KEYS.intersection(request)
        if clash:
            raise ValueError(f"a PDF request's {', '.join(sorted(clash))} is the host's, not a member to set")
        self.prove_abi()
        answer = _strict(self._run_op(op, request), op)
        if not isinstance(answer, dict) or not isinstance(answer.get("ok"), bool):
            raise SandboxError(SandboxFailure.NO_OUTCOME, f"The PDF program printed no {op} answer.")
        if answer["ok"] is not True:
            error = answer.get("error")
            message = error.get("message") if isinstance(error, dict) else None
            code = program_error_code(answer)
            raise PdfKernelError(
                code, message if isinstance(message, str) else f"The PDF program refused the {op} request ({code})."
            )
        if answer.get("op") != op:
            raise _malformed(op, "op")
        return answer

    def _run_op(self, op: str, request: Mapping[str, JsonValue]) -> bytes:
        """Run one request in the PDF pool and return the answer's bytes (not yet read)."""
        body = _request_json({**request, "abi": PDF_ABI_MIN, "op": op})
        budget = self._limits.pdf_budget()
        result = self._run(body, budget)
        return _pdf_answer(result, budget)

    def _run(self, stdin: bytes, budget: RunBudget) -> RunResult:
        recorder = self._recorder
        run = program_run(self._program.data, PDF_RUN_SCRIPT.encode("utf-8"), stdin, budget, timed=recorder is not None)
        began = clock() if recorder is not None else 0.0
        try:
            result = self._runtime.run(run)
        except EngineBusyError as error:
            raise SandboxError(
                SandboxFailure.BUSY, f"Every PDF slot stayed taken for {budget.wait:g} s ({error.reason})."
            ) from None
        except EngineClosedError:
            raise SandboxError(
                SandboxFailure.INTERRUPTED, "The PDF runtime is stopping; the run was not made."
            ) from None
        except EngineStrayBoundError:
            # A fault of the runtime, not a queue: a failed run the watch records as `unavailable`, never a busy one.
            if recorder is not None:
                note_run(run, None, clock() - began)
            raise StrayBoundError(
                "The PDF runtime is unavailable: runs that would not stop have not ended, so no new run starts "
                "until they do."
            ) from None
        except Exception as error:
            if recorder is not None:
                note_run(run, None, clock() - began)
            raise ProgramUnavailableError("The runtime could not start the PDF program.") from error
        if recorder is not None:
            note_run(run, result, clock() - began)
        return result
