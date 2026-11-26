"""The PDF seams: protocols and the plain records they pass, nothing third-party.

Built on: the standard library (`typing.Protocol`, `dataclasses`, `enum`, `datetime`) and `datum_core.hooks` (the
`MaybeAwaitable` alias, `HookFindings`, `HookProblem`) cover every shape here. `pydantic` models would add validation
these records do not need, `cryptography` has no signer or revocation vocabulary the host may name without importing
it, and no standard type says "good, revoked or unknown" or a trust word; so the protocols are written here, once, for
the seal, the verifier, the trust policy and the application to implement against. The one-method hooks follow
`datum_core.builder.drafts`: a plain callable type over a record.

The private key never leaves its `PdfSigner`: the service hands it `toBeSigned` and takes a value back; the signer
names its certificates (public DER) and its algorithm, and nothing else. A customizer sees the request's JSON pieces
and never the ABI, the operation or the program (the kernel's request is stamped with those by the service). A result
validator sees the produced bytes before any seal (`pdf` is hidden from `repr`); a record names no key and no password.
"""

import enum
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from datetime import datetime
from typing import Final, Literal, Protocol

from datum_core.hooks import HookFindings, HookProblem, MaybeAwaitable
from datum_sandbox.json import JsonValue
from datum_sandbox.protocol import PdfKernelMiddleware, PdfSignatureAlgorithm

__all__ = [
    "PDF_TRUST_WORDS",
    "PdfKernelMiddleware",
    "PdfOperation",
    "PdfRequestCustomizer",
    "PdfRequestDraft",
    "PdfResultCandidate",
    "PdfResultValidator",
    "PdfSignatureAlgorithm",
    "PdfSigner",
    "PdfTrustVerdict",
    "PdfTrustWord",
    "PdfValidationTime",
    "PdfValueVerdict",
    "RevocationChecker",
    "RevocationStatus",
]

type PdfOperation = Literal["render", "fill", "sign", "render_submission"]
"""The operations that answer PDF bytes, which customizers and result validators run for (verify answers a report)."""

type PdfTrustWord = Literal["site", "site_retired", "trusted", "self_signed", "unknown"]
"""Where a signer's chain stands: this server's key, its retired key, a path to an anchor, a self-signed leaf, none."""

PDF_TRUST_WORDS: Final[tuple[PdfTrustWord, ...]] = ("site", "site_retired", "trusted", "self_signed", "unknown")
"""Every trust word, in the catalog's order."""

type PdfValueVerdict = Literal["valid", "invalid", "unchecked"]
"""The signature value under the signer's key: checked and good, checked and bad, or not checked."""

type RevocationStatus = Literal["good", "revoked", "unknown"]
"""A revocation checker's answer for a chain at a moment; `unknown` is never trusted."""


class PdfValidationTime(enum.StrEnum):
    """When a chain is judged: now, or the time a verified timestamp proves (the wire words of the verify report)."""

    NOW = "now"
    SIGNING_TIME = "signing-time"


@dataclass(frozen=True, slots=True)
class PdfTrustVerdict:
    """A signer's trust word, the instant the chain was judged at for a `trusted` one (absent otherwise), a reason.

    `reason` is a short note when the judging did not go as asked (a `proven_time` later than now is not usable, so the
    chain was judged at now); None otherwise.
    """

    word: PdfTrustWord
    trusted_at: datetime | None = None
    reason: str | None = None

    def __post_init__(self) -> None:
        """Refuse a word outside the list, a `trusted` one with no instant, another word with one, and a naive one."""
        if self.word not in PDF_TRUST_WORDS:
            raise ValueError(f"a trust word is one of {', '.join(PDF_TRUST_WORDS)}: {self.word!r}")
        if self.word == "trusted" and self.trusted_at is None:
            raise ValueError("a trusted signer carries the instant its chain was judged at")
        if self.trusted_at is not None:
            if self.word != "trusted":
                raise ValueError("only a trusted signer carries the instant its chain was judged at")
            if self.trusted_at.tzinfo is None or self.trusted_at.utcoffset() is None:
                raise ValueError("the instant a chain was judged at is timezone-aware")


# -- the signer and the revocation checker --


class PdfSigner(Protocol):
    """Signs what the kernel prepared; the key stays inside, loaded once at start and used through `sign` only.

    A signer exposes its certificates and its algorithm and never the key, a password or a path. Its value is RSA
    PKCS#1 v1.5 or ECDSA (DER; a raw ``r||s`` is converted by the host before `complete`, anything else refused).
    """

    @property
    def algorithm(self) -> PdfSignatureAlgorithm:
        """The algorithm the key signs with, the one the kernel's handoff must name."""
        ...

    def certificates(self) -> tuple[bytes, ...]:
        """Return the DER certificates, the signer's leaf first and its issuers after (public data)."""
        ...

    def sign(self, to_be_signed: bytes) -> bytes:
        """Return the signature over `to_be_signed` (the DER signed attributes) in the algorithm's wire form."""
        ...


class RevocationChecker(Protocol):
    """Says whether a chain was revoked at a moment; an adapter, optional, offline (never fetches).

    A checker that cannot learn the status answers `unknown`, and one that raises (a cancellation included) counts as
    `unknown`: an unknown status is not trusted. The trust policy always passes the archived CRLs and OCSP responses it
    holds (possibly none) by the keywords `crls` and `ocsps`, so a checker implements both.
    """

    def status(
        self, chain: Sequence[bytes], moment: datetime, *, crls: Sequence[bytes] = (), ocsps: Sequence[bytes] = ()
    ) -> RevocationStatus:
        """Return the status of the DER `chain` (leaf first) at `moment` (timezone-aware): good, revoked or unknown.

        `crls` and `ocsps` are DER archived status that goes with this call, beside whatever the checker holds.
        """
        ...


# -- the hooks --


@dataclass(frozen=True, slots=True)
class PdfRequestDraft:
    """What a customizer is told: the operation, the form and layout, who asks, and the request's pieces to change.

    `env`, `options`, `host_context`, `attachments` and `fonts` are the service's own copies (JSON as the kernel takes
    it): change them in place, or raise `HookRefusedError`. The record cannot be rebound and holds neither the ABI, the
    kernel operation nor the program, so a customizer cannot change them. `form_key` and `layout_id` are None when the
    operation names none (a sign of an uploaded file). `attachments` and `fonts` hold file bytes as base64 and are
    hidden from `repr`.
    """

    op: PdfOperation
    form_key: str | None
    layout_id: str | None
    principal: object | None
    env: dict[str, JsonValue]
    options: dict[str, JsonValue]
    host_context: dict[str, JsonValue]
    attachments: list[dict[str, JsonValue]] = field(default_factory=list[dict[str, JsonValue]], repr=False)
    fonts: list[dict[str, JsonValue]] = field(default_factory=list[dict[str, JsonValue]], repr=False)


@dataclass(frozen=True, slots=True)
class PdfResultCandidate:
    """What a validator is told: the operation, the form and layout, who asked, and the produced PDF before any seal.

    `pdf` is the produced file, hidden from `repr`: the one `complete` embeds a seal into (the prepared file when the
    PDF is sealed). `warnings` are the PDF program's warnings about it (`PdfWarning`), as findings: the component id
    (else the block id) as the field, the program's code (`pdf.warning` when it is no hook code) and its message; the
    dry run's and the other validators' findings are not among them. A validator that wants the file kept out of the
    answer refuses (`HookRefusedError`) or answers errors in its findings.
    """

    op: PdfOperation
    form_key: str | None
    layout_id: str | None
    principal: object | None
    pdf: bytes = field(repr=False)
    page_count: int
    warnings: tuple[HookProblem, ...] = ()

    @property
    def size(self) -> int:
        """The produced file's size in bytes."""
        return len(self.pdf)


type PdfRequestCustomizer = Callable[[PdfRequestDraft], MaybeAwaitable[None]]
"""Changes the draft in place, or raises `HookRefusedError` (403, 409, 422); sync or async; run in list order."""

type PdfResultValidator = Callable[[PdfResultCandidate], MaybeAwaitable[HookFindings | None]]
"""Answers findings (or None), or raises `HookRefusedError`; sync or async; every validator runs before any seal."""
