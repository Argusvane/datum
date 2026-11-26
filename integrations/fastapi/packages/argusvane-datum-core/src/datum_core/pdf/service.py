"""`PdfService`: render, fill, sign and verify through the PDF program, in a fixed order.

For the operations that answer PDF bytes the order is contract, one step at a time:

    size cap > throttle (`pdf`) > PDFs available > the receiver's dry run in PDF mode (`pdf_check`) > the layout >
    pdf_request_customizers > the program (through `pdf_middleware`) > pdf_result_validators > seal >
    `PdfRenderedEvent`

so a refused PDF costs no signature, no timestamp, no serial and no event: every validator sees the bytes `complete`
embeds into, before any key is used. `render_submission` prints an accepted submission (no throttle, no dry run: the
answers were judged when they were accepted) with the submission's digest as the document's identity and the server's
key as the seal. A redelivered accepted submission is never sealed twice: the idempotency layer answers the stored
receipt and the handler, where an application calls `render_submission`, does not run again.

`verify` reads a file: the size cap and the `%PDF-` check first (a file that is not a PDF costs no throttle check and no
run), the throttle, the program's report, then the host's checks (`datum_core.pdf.verify`) and `PdfVerifiedEvent`.

The answers: a refusal of a step is an outcome (`datum_core.pdf.outcomes`); a hook's `HookRefusedError`, the
program's `PdfKernelError` (its code kept for the HTTP mapping), a `PdfError` and anything a hook raises are
raised. A run the engine could not make (`SandboxError`, a program that failed its proof) is `Unavailable`
(`server.busy` for a slot that stayed taken, else `server.unavailable`, a full stray bound included). After the
owner's stop (its scoped dispatcher closed) every call is `Unavailable` and no key is used.

The request: `env.documentId` is a fresh `secrets.token_hex(16)` for posted answers and the
submission's digest for an accepted one, `env.createdAt` the clock's instant in UTC; the fonts are `datum.pdf.fonts`'
faces; a layout named by id must be in the definition, a fill's must be a template layout, and a template must be
inline base64 (any other source is `LayoutNotFound`, the reason logged). A customizer changes the draft's `env`,
`options`, `host_context`, `attachments` and `fonts`, never the ABI, the operation or the program: the kernel service
stamps those. The draft's `host_context` starts as a copy of the context the answers were judged with
(`Datum(host_context=...)`; the accepted submission's own for `render_submission`), and the request carries
`hostContext` whenever there was one, even empty, so the PDF reads `host.` as the verdict did.

Libraries: the standard library (`dataclasses`, `collections.abc`, `logging`) and Datum's own pieces
(`SubmissionService.pdf_check`, `PdfKernel`, `call_hook`, `resolve`, `EventDispatcher`, the throttle key) cover the
steps; no library runs Datum's PDF order, so the service is written here, once, and every operation is a method.
"""

import base64
import copy
import logging
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Final, cast

from datum_core.bindings import HostBindings
from datum_core.config.models import PdfFonts, ThrottleKind
from datum_core.events import EventDispatcher, PdfRenderedEvent, PdfVerifiedEvent
from datum_core.forms import FormDefinitionRepository
from datum_core.forms.keys import version_matches
from datum_core.forms.protocols import TranslationCatalogStore
from datum_core.hooks import Awaiter, HookFindings, HookProblem, call_hook, resolve
from datum_core.loggers import PDF
from datum_core.pdf.outcomes import (
    LayoutNotFound,
    LayoutNotTemplate,
    NotAPdf,
    PdfError,
    PdfOutcome,
    PdfUnavailableError,
    Printed,
    ResultRejected,
    Unreadable,
    Verified,
    VerifyOutcome,
)
from datum_core.pdf.protocols import (
    PdfOperation,
    PdfRequestCustomizer,
    PdfRequestDraft,
    PdfResultCandidate,
    PdfResultValidator,
)
from datum_core.pdf.request import (
    b64,
    find_layout,
    font_resources,
    iso_instant,
    known_certificates,
    new_document_id,
    problems_of,
    template_problem,
)
from datum_core.pdf.seal import PdfSeal, Sealed, SealPlan, TimestampSource
from datum_core.pdf.trust import PdfTrustPolicy
from datum_core.pdf.verify import assemble_report
from datum_core.submissions import (
    AcceptedSubmission,
    FormRef,
    Malformed,
    NotFound,
    Outdated,
    PdfChecked,
    SubmissionContext,
    SubmissionService,
    Throttled,
    TooLarge,
    Unavailable,
)
from datum_core.throttle import Deny, SubmissionThrottle, ThrottleKey, counted_address
from datum_sandbox.json import BadDocumentError, JsonValue, json_size
from datum_sandbox.protocol import (
    PdfKernel,
    PdfKernelError,
    PdfProduced,
    PdfSigningHandoff,
    ProgramUnavailableError,
    SandboxError,
    StrayBoundError,
)
from datum_sandbox.wasi import EngineBusyError, EngineClosedError

__all__ = ["PdfService"]

logger = logging.getLogger(PDF)

_PDF_HEADER: Final = b"%PDF-"
_HEADER_WINDOW: Final = 1024
_BUSY: Final = "server.busy"
_UNAVAILABLE: Final = "server.unavailable"
_RUN_ANSWERS: Final = frozenset({_BUSY, "wasm.execution_error", "outcome_too_large"})
"""The codes of a `SandboxError` a PDF call answers as they are; any other is `server.unavailable`."""
_REASONS: Final = {
    "wasm.execution_error": "The PDF run gave no answer.",
    "outcome_too_large": "The PDF run's answer was larger than the server will read.",
    _BUSY: "Every PDF slot is taken; try again shortly.",
    _UNAVAILABLE: "PDFs cannot be made now; try again later.",
}
_STRAYS_REASON: Final = "PDFs cannot be made now: runs that would not stop have not ended."
"""The reason of the `server.unavailable` a full stray bound answers: a fault of the runtime, never "try again"."""


class _Stop(Exception):  # noqa: N818 - control flow inside this module only
    """A step reached the call's answer: unwind to the caller with it."""

    def __init__(self, outcome: Unavailable) -> None:
        super().__init__(outcome.code)
        self.outcome = outcome


@dataclass(frozen=True, slots=True)
class _Job:
    """One PDF to print: the operation, the form, the answers, who asked, the layout asked, the document's identity."""

    op: PdfOperation
    form_key: str
    definition: Mapping[str, JsonValue]
    values: Mapping[str, JsonValue]
    locale: str
    principal: object | None
    layout_id: str | None
    document_id: str
    notes: tuple[HookProblem, ...] = ()
    catalog: Mapping[str, JsonValue] | None = None
    host_context: Mapping[str, JsonValue] | None = None
    """The host context the answers were judged with (`Datum(host_context=...)`), `None` when none was supplied."""


def _unavailable(code: str, cause: BaseException | None = None) -> Unavailable:
    return Unavailable(code, _REASONS.get(code, _REASONS[_UNAVAILABLE]), cause)


class PdfService:
    """Render, fill, sign and verify PDFs (see the module text); one call per thread, no state between calls.

    Every seam is a keyword. `kernel` answers the composed `PdfKernel` or raises `PdfUnavailableError` when PDFs cannot
    be made (it is asked once per call, after the throttle). `submissions` runs the dry run (`pdf_check`) and gives the
    document cap; `repository` serves the definition `render_submission` prints with. `seal` is the preset over the
    server's key, the test seal and the timestamper; `trust_policy` places verified signers. `events` is the owner's
    scoped dispatcher: once it is closed the service answers `Unavailable` and uses no key. `known_certificates` are
    certificates the program is told it knows on verify, beside the server's chain and the policy's site and retired
    certificates (the in-process authority's chain, say). `awaiter` resolves an async hook or throttle.
    `verify_max_bytes` is the CLAMPED budget (`Datum.limits.verify_max_bytes`), the cap the verify route reads too, so a
    file the route admits is never refused here for a smaller number.
    """

    __slots__ = (
        "_awaiter",
        "_bindings",
        "_customizers",
        "_events",
        "_fonts",
        "_kernel",
        "_known",
        "_max_verify",
        "_now",
        "_policy",
        "_repository",
        "_seal",
        "_submissions",
        "_throttle",
        "_translation_store",
        "_validators",
    )

    def __init__(
        self,
        *,
        kernel: Callable[[], PdfKernel],
        submissions: SubmissionService,
        repository: FormDefinitionRepository,
        seal: PdfSeal,
        trust_policy: PdfTrustPolicy,
        events: EventDispatcher,
        now: Callable[[], datetime],
        verify_max_bytes: int,
        fonts: PdfFonts | str = PdfFonts.DEFAULT,
        throttle: SubmissionThrottle | None = None,
        customizers: Sequence[PdfRequestCustomizer] = (),
        validators: Sequence[PdfResultValidator] = (),
        known_certificates: Sequence[bytes] = (),
        awaiter: Awaiter | None = None,
        translation_store: TranslationCatalogStore | None = None,
        bindings: HostBindings | None = None,
    ) -> None:
        """Keep the seams; the fonts are read here, once.

        `bindings` says which binding each form route is drawn by: a form's request that names no `theme` of its
        own carries the PDF theme object its binding suggests as the host rung of the engine's ladder.
        """
        if verify_max_bytes < 1:
            raise ValueError("verify_max_bytes is at least 1")
        self._kernel = kernel
        self._submissions = submissions
        self._repository = repository
        self._translation_store = translation_store
        self._bindings = bindings
        self._seal = seal
        self._policy = trust_policy
        self._events = events
        self._now = now
        self._max_verify = verify_max_bytes
        self._fonts = font_resources(fonts)
        self._throttle = throttle
        self._customizers = tuple(customizers)
        self._validators = tuple(validators)
        self._known = tuple(bytes(item) for item in known_certificates)
        self._awaiter = awaiter

    def __repr__(self) -> str:
        """Name the seal and the policy only."""
        return f"PdfService({self._seal!r}, policy={self._policy.name!r})"

    def _catalog_of(self, form_key: str) -> Mapping[str, JsonValue] | None:
        """Return the form's stored host catalog when it holds anything, else None."""
        if self._translation_store is None:
            return None
        stored = self._translation_store.read(form_key)
        return cast("Mapping[str, JsonValue]", stored.catalog) if stored is not None and stored.catalog else None

    # -- what the service is built with ------------------------------------------------------------------------------
    @property
    def seal(self) -> PdfSeal:
        """The seal preset."""
        return self._seal

    @property
    def trust_policy(self) -> PdfTrustPolicy:
        """The policy verified signers are placed under."""
        return self._policy

    @property
    def timestamp_source(self) -> TimestampSource:
        """Where the seal's tokens come from (`custom`, `server`, `site`, `none`)."""
        return self._seal.timestamp_source

    def certificate_chain(self) -> str | None:
        """Return the server's certificate chain as PEM (leaf first), or None when the server has no key."""
        return self._seal.certificate_chain()

    # -- the operations ----------------------------------------------------------------------------------------------
    def render(
        self, form: FormRef, document: object, context: SubmissionContext, *, layout_id: str | None = None
    ) -> PdfOutcome:
        """Print posted answers (`layout_id`, or the layout the program chooses); sealed as the preset says."""
        return self._posted("render", form, document, context, layout_id)

    def fill(self, form: FormRef, document: object, context: SubmissionContext, *, layout_id: str) -> PdfOutcome:
        """Fill the template layout `layout_id` with posted answers; sealed as the preset says."""
        return self._posted("fill", form, document, context, layout_id)

    def sign(
        self, form: FormRef, document: object, context: SubmissionContext, *, layout_id: str | None = None
    ) -> PdfOutcome:
        """Print posted answers and sign them with the server's key, whatever the preset's switches say."""
        return self._posted("sign", form, document, context, layout_id)

    def render_submission(self, accepted: AcceptedSubmission, *, layout_id: str | None = None) -> PdfOutcome:
        """Print an accepted submission (the handler's input) with the server's seal; its digest is the document id."""
        try:
            if self._events.closed:
                return _unavailable(_UNAVAILABLE)
            kernel = self._available()
            stored = self._repository.current(accepted.form_key)
            if stored is None:
                return NotFound(accepted.form_key)
            if accepted.version is not None and not version_matches(stored.definition, accepted.version):
                held = stored.definition.get("version")
                current = str(held) if isinstance(held, str | int) and not isinstance(held, bool) else ""
                return Outdated(current, stored.sha256)
            job = _Job(
                op="render_submission",
                form_key=accepted.form_key,
                definition=stored.definition,
                values=accepted.values,
                locale=accepted.locale or "en",
                principal=accepted.principal,
                layout_id=layout_id,
                document_id=accepted.digest,
                catalog=self._catalog_of(accepted.form_key),
                host_context=accepted.host_context,
            )
            return self._print(kernel, job)
        except _Stop as stop:
            return stop.outcome

    def verify(self, data: bytes, context: SubmissionContext) -> VerifyOutcome:  # noqa: PLR0911 - one answer per step
        """Read every signature of `data` and place each signer (`Verified`), or say why the file was not read."""
        try:
            if self._events.closed:
                return _unavailable(_UNAVAILABLE)
            data = bytes(data)
            if len(data) > self._max_verify:
                return TooLarge(self._max_verify)
            if _PDF_HEADER not in data[: _HEADER_WINDOW + len(_PDF_HEADER) - 1]:
                return NotAPdf()
            throttled = self._throttled(context, None)
            if throttled is not None:
                return throttled
            kernel = self._available()
            known = self._known_certificates()
            request: dict[str, JsonValue] = {"pdf": {"data": b64(data)}}
            sent = known_certificates([known])  # the program's caps (64 x 16 KiB); the report is judged on the same set
            if sent:
                request["knownCertificates"] = cast("JsonValue", sent)
            try:
                verified = self._run(lambda: kernel.verify(request))
            except PdfKernelError as error:
                logger.info("the PDF program could not read a file to verify (%s)", error.code)
                return Unreadable(error.code)
            capped = tuple(base64.b64decode(item) for item in sent)
            report = assemble_report(data, verified, policy=self._policy, now=self._now(), known_certificates=capped)
            self._events.publish(
                PdfVerifiedEvent(
                    sha256=report.sha256,
                    size=report.size,
                    document_id=report.document_id,
                    signatures=len(report.signatures),
                    trust_policy=report.trust_policy.name,
                )
            )
            return Verified(report)
        except _Stop as stop:
            return stop.outcome

    # -- the steps ---------------------------------------------------------------------------------------------------
    def _posted(  # noqa: PLR0911 - one answer per step
        self, op: PdfOperation, form: FormRef, document: object, context: SubmissionContext, layout_id: str | None
    ) -> PdfOutcome:
        try:
            if self._events.closed:
                return _unavailable(_UNAVAILABLE)
            try:
                size = json_size(document)
            except BadDocumentError:
                return Malformed("the document has no JSON form")
            limit = self._submissions.max_document_bytes
            if size > limit:
                return TooLarge(limit)
            throttled = self._throttled(context, _form_key_of(form, document))
            if throttled is not None:
                return throttled
            kernel = self._available()
            checked = self._submissions.pdf_check(form, document, context)
            if not isinstance(checked, PdfChecked):
                return checked
            job = _Job(
                op=op,
                form_key=checked.form_key,
                definition=checked.definition,
                values=checked.values,
                locale=checked.locale,
                principal=context.principal,
                layout_id=layout_id,
                document_id=new_document_id(),
                notes=checked.warnings,
                catalog=self._catalog_of(checked.form_key),
                host_context=checked.host_context,
            )
            return self._print(kernel, job)
        except _Stop as stop:
            return stop.outcome

    def _print(self, kernel: PdfKernel, job: _Job) -> PdfOutcome:
        refused = self._layout_refusal(job)
        if refused is not None:
            return refused
        if job.op == "sign" and self._seal.server_signer is None:  # never the test seal
            logger.warning("a PDF was to be signed and the server has no signing key (datum.pdf.signing)")
            return _unavailable(_UNAVAILABLE)
        moment = self._now()
        draft = PdfRequestDraft(
            op=job.op,
            form_key=job.form_key,
            layout_id=job.layout_id,
            principal=job.principal,
            env={"documentId": job.document_id, "createdAt": iso_instant(moment)},
            options={},
            host_context=copy.deepcopy(dict(job.host_context)) if job.host_context is not None else {},
            attachments=[],
            fonts=[dict(face) for face in self._fonts],
        )
        for customizer in self._customizers:
            call_hook(customizer, self._awaiter, draft)
        covered = self._seal.covers(job.op, job.layout_id)
        plan = self._seal.plan(job.op) if covered else None  # PdfError here costs no run
        two_calls = covered is None  # `sign` is always covered, so its signature rides the document call: one run
        request = _document_request(job, draft, moment)
        suggested = self._bindings.pdf_theme(job.form_key) if self._bindings is not None else None
        if suggested is not None and "theme" not in request:
            request["theme"] = dict(suggested)
        if plan is not None and not two_calls:
            request["signature"] = plan.signature()
        produced: PdfProduced = self._run(lambda: kernel.document(request))
        printed_layout = job.layout_id if job.layout_id is not None else produced.layout_id
        if covered is None:
            plan = self._seal.plan(job.op) if self._seal.covers(job.op, printed_layout) else None
        pdf, handoff, warnings = produced.pdf, produced.signing, list(produced.warnings)
        if plan is not None and two_calls:
            prepared = self._run(
                lambda: kernel.sign(
                    {
                        "pdf": {"data": b64(pdf)},
                        "signature": plan.signature(),
                        "env": dict(draft.env),
                        "fonts": cast("JsonValue", list(draft.fonts)),
                    }
                )
            )
            pdf, handoff = prepared.pdf, prepared.signing
            warnings += prepared.warnings
        kernel_warnings = problems_of(warnings)
        findings = self._validate(
            PdfResultCandidate(
                op=job.op,
                form_key=job.form_key,
                layout_id=printed_layout,
                principal=job.principal,
                pdf=pdf,
                page_count=produced.page_count,
                warnings=kernel_warnings,
            )
        )
        if findings.errors:
            return ResultRejected(findings.errors)
        notes = [*job.notes, *kernel_warnings, *findings.warnings]
        signed_by: str | None = None
        field_name: str | None = None
        timestamped = False
        if plan is not None:
            sealed = self._sealed(kernel, plan, pdf, handoff)
            pdf, signed_by, field_name, timestamped = (
                sealed.pdf,
                sealed.signed_by,
                sealed.field_name,
                sealed.timestamped,
            )
            notes += sealed.warnings
        self._events.publish(
            PdfRenderedEvent(
                form_key=job.form_key,
                op=job.op,
                bytes=len(pdf),
                layout_id=printed_layout,
                signed=plan is not None,
                timestamped=timestamped,
            )
        )
        return Printed(
            data=pdf,
            page_count=produced.page_count,
            layout_id=printed_layout,
            signed_by=signed_by,
            signature_field=field_name,
            timestamped=timestamped,
            warnings=tuple(notes),
            seal=plan.word if plan is not None else "none",
            pdf_theme=self._bindings.pdf_theme_id(job.form_key) if self._bindings is not None else None,
        )

    def _sealed(self, kernel: PdfKernel, plan: SealPlan, pdf: bytes, handoff: PdfSigningHandoff | None) -> Sealed:
        if handoff is None:
            raise PdfError("the PDF program prepared no signature (a program without the signature feature)")
        return self._run(lambda: self._seal.seal(kernel, plan, pdf, handoff, open_=lambda: not self._events.closed))

    def _layout_refusal(self, job: _Job) -> LayoutNotFound | LayoutNotTemplate | None:
        if job.layout_id is None:
            return None
        layout = find_layout(job.definition, job.layout_id)
        if layout is None:
            return LayoutNotFound(job.layout_id)
        kind = layout.get("kind")
        if job.op == "fill" and kind != "template":
            return LayoutNotTemplate(job.layout_id)
        if kind == "template":
            problem = template_problem(layout)
            if problem is not None:
                logger.warning("the layout %r of %s is not printed: %s", job.layout_id, job.form_key, problem)
                return LayoutNotFound(job.layout_id)
        return None

    def _validate(self, candidate: PdfResultCandidate) -> HookFindings:
        """Run every validator in order (a `HookRefusedError` stops at once); the findings, merged."""
        findings = HookFindings()
        for validator in self._validators:
            answer = call_hook(validator, self._awaiter, candidate)
            if answer is None:
                continue
            if not isinstance(answer, HookFindings):  # pyright: ignore[reportUnnecessaryIsInstance]
                raise TypeError(f"a PDF result validator answered {type(answer).__name__}, not HookFindings or None")
            findings = findings.merged(answer)
        return findings

    def _throttled(self, context: SubmissionContext, form_key: str | None) -> Throttled | None:
        given = context.throttle_key
        if given is None or self._throttle is None:
            return None
        key = ThrottleKey(
            ip=counted_address(given.ip),
            form_key=form_key,
            principal=given.principal,
            kind=ThrottleKind.PDF,
            channel=context.channel,
        )
        answer = resolve(self._throttle.check(key), self._awaiter, what="the throttle")
        return Throttled(answer.retry_after, key) if isinstance(answer, Deny) else None

    def _available(self) -> PdfKernel:
        try:
            return self._kernel()
        except (PdfUnavailableError, ProgramUnavailableError) as error:
            logger.warning("PDFs cannot be made now (%s)", error)
            raise _Stop(_unavailable(_UNAVAILABLE, error)) from None

    def _run[T](self, call: Callable[[], T]) -> T:
        """Make one program call; a run the engine could not make is the `Unavailable` answer."""
        try:
            return call()
        except SandboxError as error:
            code = error.code if error.code in _RUN_ANSWERS else _UNAVAILABLE  # a failed run keeps its own code
            logger.warning("a PDF run gave no answer (%s)", error.reason)
            raise _Stop(_unavailable(code, error)) from None
        except EngineBusyError as error:
            raise _Stop(_unavailable(_BUSY, error)) from None
        except StrayBoundError as error:
            logger.warning("a PDF run could not be made (%s)", type(error).__name__)
            raise _Stop(Unavailable(_UNAVAILABLE, _STRAYS_REASON, error)) from None
        except (EngineClosedError, ProgramUnavailableError, PdfUnavailableError) as error:
            logger.warning("a PDF run could not be made (%s)", type(error).__name__)
            raise _Stop(_unavailable(_UNAVAILABLE, error)) from None

    def _known_certificates(self) -> tuple[bytes, ...]:
        """Return the certificates verify tells the program it knows: the server's chain first, then the rest, once."""
        signer = self._seal.server_signer
        groups: list[Sequence[bytes]] = [
            signer.certificates() if signer is not None else (),
            self._known,
            self._policy.site_certificates,
            self._policy.retired_certificates,
        ]
        seen: set[bytes] = set()
        kept: list[bytes] = []
        for group in groups:
            for item in group:
                der = bytes(item)
                if der not in seen:
                    seen.add(der)
                    kept.append(der)
        return tuple(kept)


def _form_key_of(form: FormRef, document: object) -> str | None:
    """Return the form a document names (what the throttle counts under), read without judging anything."""
    if form.key is not None:
        return form.key
    if not isinstance(document, Mapping):
        return None
    context = cast("Mapping[str, object]", document).get("versionContext")
    named = cast("Mapping[str, object]", context).get("form") if isinstance(context, Mapping) else None
    form_id = cast("Mapping[str, object]", named).get("id") if isinstance(named, Mapping) else None
    return form_id if isinstance(form_id, str) else None


def _document_request(job: _Job, draft: PdfRequestDraft, moment: datetime) -> dict[str, JsonValue]:
    """Return the `document` request of a job after its customizers (the kernel service adds `abi` and `op`)."""
    request: dict[str, JsonValue] = {
        "form": job.definition.get("root"),
        "values": dict(job.values),
        "locale": job.locale,
        "env": dict(draft.env),
        "fonts": cast("JsonValue", list(draft.fonts)),
        "today": moment.date().isoformat(),
    }
    block = job.definition.get("pdf")
    if isinstance(block, dict):
        request["pdf"] = block
    form_translations = job.definition.get("translations")
    if isinstance(form_translations, dict):
        # The form's own map, for the layout's texts; the host catalog rides beside it as `translations`.
        request["formTranslations"] = form_translations
    if job.catalog:
        request["translations"] = dict(job.catalog)
    if job.layout_id is not None:
        request["layoutId"] = job.layout_id
    if draft.options:
        request["options"] = dict(draft.options)
    if draft.host_context or job.host_context is not None:
        # the verdict's context, present even when empty (every `host.` rule judged), and what a customizer added
        request["hostContext"] = dict(draft.host_context)
    if draft.attachments:
        request["attachments"] = cast("JsonValue", list(draft.attachments))
    return request
