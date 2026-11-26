"""PDF hook, signer, checker, kernel-middleware, event and Datum shapes the type checkers must accept (strict mypy and
pyright)."""

import functools
from collections.abc import Mapping, Sequence
from datetime import UTC, datetime

from datum_core import Datum
from datum_core.aio import AsyncPdfService, AsyncRunner
from datum_core.events import DatumEvent, PdfRenderedEvent, PdfVerifiedEvent, listener
from datum_core.hooks import HookFindings, HookProblem, HookRefusedError
from datum_core.pdf import (
    PdfKernelMiddleware,
    PdfRequestCustomizer,
    PdfRequestDraft,
    PdfResultCandidate,
    PdfResultValidator,
    PdfService,
    PdfSignatureAlgorithm,
    PdfSigner,
    PdfTrustPolicy,
    PdfValidationTime,
    RevocationChecker,
    RevocationStatus,
    TestSealSigner,
)
from datum_core.pdf.outcomes import PdfOutcome, Printed, VerifyOutcome
from datum_core.submissions import FormRef, SubmissionContext
from datum_core.timestamp import TimestampChannel, Timestamper, TimestampGrant
from datum_sandbox.protocol import PdfKernel, Program
from datum_sandbox.protocol._pdf import PdfCapabilities, PdfCompleted, PdfInspected, PdfProduced, PdfSigned, PdfVerified


# -- customizers and validators: plain, async, partial, lambda -----------------------------------------------------
def customize(draft: PdfRequestDraft) -> None:
    draft.env["producer"] = "My Org"
    draft.options["compact"] = True
    draft.host_context["tenant"] = "acme"
    draft.fonts.clear()
    layout: str | None = draft.layout_id
    form: str | None = draft.form_key
    if draft.op == "fill" and layout is None:
        raise HookRefusedError.invalid("pdf.layout", "A layout is needed.")
    _ = (layout, form)


async def customize_async(draft: PdfRequestDraft) -> None:
    draft.attachments.append({"name": "terms.txt"})


def tag(prefix: str, draft: PdfRequestDraft) -> None:
    assert prefix


def validate(candidate: PdfResultCandidate) -> HookFindings | None:
    size: int = candidate.size
    pages: int = candidate.page_count
    data: bytes = candidate.pdf
    if size > 5_000_000 or pages > 100 or not data:
        return HookFindings(errors=(HookProblem(None, "pdf.big", "Too big."),))
    return None


async def validate_async(candidate: PdfResultCandidate) -> HookFindings:
    return HookFindings(warnings=(HookProblem(None, "pdf.note", "Noted."),))


plain: PdfRequestCustomizer = customize
plain_async: PdfRequestCustomizer = customize_async
plain_partial: PdfRequestCustomizer = functools.partial(tag, "p")
plain_lambda: PdfRequestCustomizer = lambda draft: None  # noqa: E731
checker_fn: PdfResultValidator = validate
checker_async: PdfResultValidator = validate_async
checker_lambda: PdfResultValidator = lambda candidate: None  # noqa: E731


# -- a signer, a checker, a timestamper, a kernel middleware -------------------------------------------------------
class KeySigner:
    @property
    def algorithm(self) -> PdfSignatureAlgorithm:
        return "ECDSA-P256-SHA256"

    def certificates(self) -> tuple[bytes, ...]:
        return (b"",)

    def sign(self, to_be_signed: bytes) -> bytes:
        return to_be_signed


class Checker:
    def status(
        self, chain: Sequence[bytes], moment: datetime, *, crls: Sequence[bytes] = (), ocsps: Sequence[bytes] = ()
    ) -> RevocationStatus:
        return "unknown" if not chain or moment.tzinfo is None else "good"


class Stamper:
    def request(
        self,
        imprint: bytes,
        algorithm: str,
        *,
        policy: str | None = None,
        cert_req: bool = True,
        channel: TimestampChannel = "seal",
    ) -> TimestampGrant:
        return TimestampGrant(imprint, imprint, datetime.now(UTC), 1)


class Observing:
    def __init__(self, inner: PdfKernel) -> None:
        self._inner = inner

    @property
    def program(self) -> Program:
        return self._inner.program

    def capabilities(self) -> PdfCapabilities:
        return self._inner.capabilities()

    def document(self, request: Mapping[str, object]) -> PdfProduced:
        return self._inner.document({})

    def fill(self, request: Mapping[str, object]) -> PdfProduced:
        return self._inner.fill({})

    def sign(self, request: Mapping[str, object]) -> PdfSigned:
        return self._inner.sign({})

    def complete(self, request: Mapping[str, object]) -> PdfCompleted:
        return self._inner.complete({})

    def verify(self, request: Mapping[str, object]) -> PdfVerified:
        return self._inner.verify({})

    def inspect(self, request: Mapping[str, object]) -> PdfInspected:
        return self._inner.inspect({})


def observe(kernel: PdfKernel) -> PdfKernel:
    return Observing(kernel)


signer: PdfSigner = KeySigner()
revocation: RevocationChecker = Checker()
timestamper: Timestamper = Stamper()
middleware: PdfKernelMiddleware = observe
policy = PdfTrustPolicy(anchors=(b"",), revocation=revocation, validation_time=PdfValidationTime.SIGNING_TIME)
sealed_by: PdfSigner = TestSealSigner()

customizers: Sequence[PdfRequestCustomizer] = [plain, plain_async, plain_partial, plain_lambda, customize]
validators: Sequence[PdfResultValidator] = [checker_fn, checker_async, checker_lambda]

datum = Datum(
    pdf_request_customizers=customizers,
    pdf_result_validators=validators,
    pdf_middleware=[middleware],
    pdf_signer=signer,
    timestamper=timestamper,
    pdf_trust_policy=policy,
)

# -- the service and its outcomes -----------------------------------------------------------------------------------
service: PdfService | None = datum.pdf_service
if service is not None:
    context = SubmissionContext("bus")
    rendered: PdfOutcome = service.render(FormRef.from_document(), {}, context)
    filled: PdfOutcome = service.fill(FormRef.from_document(), {}, context, layout_id="t1")
    signed: PdfOutcome = service.sign(FormRef.from_document(), {}, context)
    checked: VerifyOutcome = service.verify(b"%PDF-", context)
    pem: str | None = service.certificate_chain()
    if isinstance(rendered, Printed):
        body: bytes = rendered.data
        pages: int = rendered.page_count
        who: str | None = rendered.signed_by
        field: str | None = rendered.signature_field
        stamped: bool = rendered.timestamped
        rendered_fields = (body, pages, who, field, stamped)
    other_answers = (filled, signed, checked, pem)
    wrapped = AsyncPdfService(service, AsyncRunner(worker_threads=2, wait=1.0, shutdown_grace=1.0))
    _ = wrapped


# -- events ----------------------------------------------------------------------------------------------------------
def on_rendered(event: PdfRenderedEvent) -> None:
    size: int = event.bytes
    op: str = event.op
    form: str | None = event.form_key
    layout: str | None = event.layout_id
    signed: bool = event.signed
    stamped: bool = event.timestamped
    _ = (size, op, form, layout, signed, stamped)


async def on_verified(event: PdfVerifiedEvent) -> None:
    digest: str = event.sha256
    size: int = event.size
    document: str | None = event.document_id
    count: int = event.signatures
    name: str = event.trust_policy
    _ = (digest, size, document, count, name)


def on_anything(event: DatumEvent) -> None: ...


listener(PdfRenderedEvent, on_rendered)
listener(PdfVerifiedEvent, on_verified)
listener(PdfRenderedEvent, on_anything)  # a listener typed for the base accepts the subclass event
listener(PdfVerifiedEvent, lambda event: None)
