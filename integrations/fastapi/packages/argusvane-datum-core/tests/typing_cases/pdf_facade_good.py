"""The facade shows the real types: a right use through `datum_core.pdf` is accepted by mypy and pyright strict."""

from collections.abc import Sequence
from datetime import UTC, datetime

from datum_core.hooks import HookFindings, HookProblem
from datum_core.pdf import (
    PDF_TRUST_WORDS,
    PdfKernelMiddleware,
    PdfRequestCustomizer,
    PdfRequestDraft,
    PdfResultCandidate,
    PdfResultValidator,
    PdfSignatureAlgorithm,
    PdfSigner,
    PdfTrustVerdict,
    PdfValidationTime,
    RevocationChecker,
    RevocationStatus,
)
from datum_core.pdf.protocols import PdfSigner as DirectSigner
from datum_sandbox.json import JsonValue
from datum_sandbox.protocol import PdfKernel, PdfProduced


class Signer:
    @property
    def algorithm(self) -> PdfSignatureAlgorithm:
        return "ECDSA-P256-SHA256"

    def certificates(self) -> tuple[bytes, ...]:
        return (b"leaf", b"issuer")

    def sign(self, to_be_signed: bytes) -> bytes:
        return to_be_signed[:64]


class Checker:
    def status(
        self, chain: Sequence[bytes], moment: datetime, *, crls: Sequence[bytes] = (), ocsps: Sequence[bytes] = ()
    ) -> RevocationStatus:
        return "good" if chain and moment.tzinfo is UTC else "unknown"


signer: PdfSigner = Signer()
same: DirectSigner = signer
checker: RevocationChecker = Checker()


def customize(draft: PdfRequestDraft) -> None:
    draft.env["documentId"] = "x"
    draft.options["compact"] = True
    draft.host_context["tenant"] = draft.form_key
    draft.attachments.append({"name": "a.txt"})


async def customize_async(draft: PdfRequestDraft) -> None:
    draft.fonts.clear()


def validate(candidate: PdfResultCandidate) -> HookFindings | None:
    if candidate.size > 1000:
        return HookFindings(errors=(HookProblem(None, "pdf.tooBig", "Too big."),))
    return None


async def validate_async(candidate: PdfResultCandidate) -> None:
    return None


customizers: Sequence[PdfRequestCustomizer] = [customize, customize_async]
validators: Sequence[PdfResultValidator] = [validate, validate_async]
verdict: PdfTrustVerdict = PdfTrustVerdict("trusted", datetime.now(UTC))
words: tuple[str, ...] = PDF_TRUST_WORDS
when: PdfValidationTime = PdfValidationTime.SIGNING_TIME


def middleware(kernel: PdfKernel) -> PdfKernel:
    return kernel


wrapped: PdfKernelMiddleware = middleware


def page_count(produced: PdfProduced) -> int:
    return produced.page_count


context: dict[str, JsonValue] = {}
