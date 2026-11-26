"""The PDF render, fill, sign and verify capability: a lazy facade over the submodules.

`argusvane-datum-core[pdf]` brings cryptography and `argusvane-datum-core[revocation]` adds pyhanko-certvalidator, so
importing this package pulls neither: a name is imported from its submodule on first use (PEP 562). The names appear
under `TYPE_CHECKING` so the type checkers see the real types. A name whose module needs an extra that is not installed
fails naming the extra.

Every name of `__all__` and `_SOURCES` has its `TYPE_CHECKING` import; a name
added later adds its import with it, so pyright holds `__all__` to the names it can see.
"""

import importlib
from typing import TYPE_CHECKING, Any, Final

if TYPE_CHECKING:
    from datum_core.pdf.outcomes import (
        LayoutNotFound,
        LayoutNotTemplate,
        NotAPdf,
        PdfError,
        PdfOutcome,
        PdfSignatureError,
        PdfUnavailableError,
        Printed,
        ResultRejected,
        SealWord,
        Unreadable,
        Verified,
        VerifyOutcome,
    )
    from datum_core.pdf.protocols import (
        PDF_TRUST_WORDS,
        PdfKernelMiddleware,
        PdfOperation,
        PdfRequestCustomizer,
        PdfRequestDraft,
        PdfResultCandidate,
        PdfResultValidator,
        PdfSignatureAlgorithm,
        PdfSigner,
        PdfTrustVerdict,
        PdfTrustWord,
        PdfValidationTime,
        PdfValueVerdict,
        RevocationChecker,
        RevocationStatus,
    )
    from datum_core.pdf.revocation import CertvalidatorRevocationChecker
    from datum_core.pdf.seal import PdfSeal, TimestampSource
    from datum_core.pdf.service import PdfService
    from datum_core.pdf.signer import KeyFilePdfSigner, TestSealSigner
    from datum_core.pdf.trust import PdfTrustPolicy, PdfTrustPolicySummary
    from datum_core.pdf.verify import PdfVerifyReport, SignatureVerdict

    # Each submodule adds its names here; tests/test_pdf_facade.py fails until it does.

_SOURCES: dict[str, str] = {
    "KeyFilePdfSigner": "signer",
    "TestSealSigner": "signer",
    "PdfTrustPolicy": "trust",
    "PdfTrustPolicySummary": "trust",
    "CertvalidatorRevocationChecker": "revocation",
    "PdfVerifyReport": "verify",
    "SignatureVerdict": "verify",
    "PdfService": "service",
    "PdfSeal": "seal",
    "TimestampSource": "seal",
    **dict.fromkeys(
        (
            "LayoutNotFound",
            "LayoutNotTemplate",
            "NotAPdf",
            "PdfError",
            "PdfOutcome",
            "PdfSignatureError",
            "PdfUnavailableError",
            "Printed",
            "ResultRejected",
            "SealWord",
            "Unreadable",
            "Verified",
            "VerifyOutcome",
        ),
        "outcomes",
    ),
    **dict.fromkeys(
        (
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
        ),
        "protocols",
    ),
}

__all__ = [
    "PDF_TRUST_WORDS",
    "CertvalidatorRevocationChecker",
    "KeyFilePdfSigner",
    "LayoutNotFound",
    "LayoutNotTemplate",
    "NotAPdf",
    "PdfError",
    "PdfKernelMiddleware",
    "PdfOperation",
    "PdfOutcome",
    "PdfRequestCustomizer",
    "PdfRequestDraft",
    "PdfResultCandidate",
    "PdfResultValidator",
    "PdfSeal",
    "PdfService",
    "PdfSignatureAlgorithm",
    "PdfSignatureError",
    "PdfSigner",
    "PdfTrustPolicy",
    "PdfTrustPolicySummary",
    "PdfTrustVerdict",
    "PdfTrustWord",
    "PdfUnavailableError",
    "PdfValidationTime",
    "PdfValueVerdict",
    "PdfVerifyReport",
    "Printed",
    "ResultRejected",
    "RevocationChecker",
    "RevocationStatus",
    "SealWord",
    "SignatureVerdict",
    "TestSealSigner",
    "TimestampSource",
    "Unreadable",
    "Verified",
    "VerifyOutcome",
]

_EXTRAS: Final[dict[str, tuple[str, str]]] = {
    # the top-level package whose absence is the extra's absence -> (the extra, the distribution it brings)
    "cryptography": ("pdf", "cryptography"),
    "asn1crypto": ("pdf", "asn1crypto"),
    "pyhanko_certvalidator": ("revocation", "pyhanko-certvalidator"),
    "oscrypto": ("revocation", "oscrypto"),
    "aiohttp": ("revocation", "aiohttp"),
    "certifi": ("revocation", "certifi"),
}


def __getattr__(name: str) -> Any:  # noqa: ANN401 - the real types come from the TYPE_CHECKING imports
    """Import `name` from its submodule on first use and keep it on the package."""
    module = _SOURCES.get(name)
    if module is None:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    try:
        value = getattr(importlib.import_module(f"{__name__}.{module}"), name)
    except ModuleNotFoundError as exc:
        extra = _EXTRAS.get((exc.name or "").partition(".")[0])
        if extra is None:
            raise
        raise ModuleNotFoundError(
            f"{name} needs {extra[1]}, which is not installed: "
            f"install it with `pip install 'argusvane-datum-core[{extra[0]}]'`",
            name=exc.name,
        ) from exc
    globals()[name] = value
    return value


def __dir__() -> list[str]:
    """List the public names with the module's own."""
    return sorted({*globals(), *__all__})
