"""The offline revocation adapter: `pyhanko-certvalidator` behind one class.

This module is the only importer of `pyhanko_certvalidator` (the `argusvane-datum-core[revocation]` extra);
`datum_core.pdf` imports no `asn1crypto`, so the adapter reaches the library's certificate type through the library's
own re-export (`pyhanko_certvalidator.x509`) for the roots and the chain, and hands it CRLs and OCSP responses as DER,
which `ValidationContext` reads itself.

Libraries: `cryptography` has no CRL or OCSP path checking (it parses both, and builds paths in
`x509.verification`, but never consults revocation), the standard library has no X.509, and pyhanko-certvalidator is the
checker the design needs; the class below only fixes its arguments and reads its answer as one of three words.

The settings that make it safe, always: `revocation_mode="hard-fail"` (no information is a failure, never a pass),
`allow_fetching=False` (no CRL download, no OCSP request, no AIA chase), explicit trust roots (never the operating
system's list; no roots is `unknown`), and `retroactive_revinfo=True` (a CRL issued after the moment still says
whether the certificate was revoked BEFORE it; the default refuses it as too recent). The library is async only in
0.33.0, so each call runs on its own `asyncio.Runner`, made on the calling (worker) thread and closed in `finally`: no
loop is shared, none survives the call, and the application's loop is never borrowed.

Whatever cannot be judged is `unknown`: no CRL or response for the certificate, one of another issuer, a stale one, an
OCSP response from after the moment that does not prove the revocation happened before it, a CRL or OCSP response issued
after a certificate on the path had expired (a CA may drop an expired certificate's entry, so it proves nothing about
the earlier moment; conservative: ExpiredCertsOnCRL and archiveCutoff are not honoured), a call made on a thread whose
event loop is running, a certificate on the path that names no CRL distribution point and no OCSP responder (the
library's hard-fail would pass it, listed or not), a path that is only a trust root (no status was looked up), an
input the adapter cannot read, any exception.

Unproven (no test, no claim): the reason codes of a CRL entry and its invalidityDate, delta CRLs and indirect CRLs; a
revocation is read from the entry's date alone, and a CRL that depends on any of them is not promised to be read.
"""

import asyncio
import datetime as dt
from collections.abc import Sequence
from typing import Any, Final

from cryptography import x509
from cryptography.x509 import ocsp
from cryptography.x509.oid import AuthorityInformationAccessOID
from pyhanko_certvalidator import CertificateValidator, ValidationContext
from pyhanko_certvalidator import x509 as _x509  # type: ignore[attr-defined]  # the library's asn1crypto re-export
from pyhanko_certvalidator.errors import RevokedError

from datum_core.pdf.protocols import RevocationStatus

__all__ = ["CertvalidatorRevocationChecker"]

# asn1crypto ships no type information: the library's certificate type is used as `Any`, here only.
_Certificate: Final[Any] = _x509.Certificate


class CertvalidatorRevocationChecker:
    """A `RevocationChecker` over pyhanko-certvalidator: offline, hard-fail, explicit roots, archived CRLs and OCSP.

    `roots` are the DER trust roots the paths must end at (the trust policy's anchors, usually); `crls` and `ocsps` the
    DER CRLs and OCSP responses the adapter may consult, archived or current. Nothing is fetched. An input that cannot
    be read makes every answer `unknown` (a broken archive is never half trusted). The instance holds public data only.
    """

    __slots__ = ("_crls", "_ocsps", "_readable", "_roots")

    def __init__(self, *, roots: Sequence[bytes], crls: Sequence[bytes] = (), ocsps: Sequence[bytes] = ()) -> None:
        """Keep copies of the DER `roots`, `crls` and `ocsps`; nothing is parsed into the library until a call."""
        self._roots = tuple(bytes(item) for item in roots)
        self._crls = tuple(bytes(item) for item in crls)
        self._ocsps = tuple(bytes(item) for item in ocsps)
        self._readable = _all_readable(self._roots, self._crls, self._ocsps)

    def __repr__(self) -> str:
        """Name the counts, never the data."""
        return (
            f"CertvalidatorRevocationChecker(roots={len(self._roots)}, crls={len(self._crls)}, "
            f"ocsps={len(self._ocsps)})"
        )

    def status(
        self, chain: Sequence[bytes], moment: dt.datetime, *, crls: Sequence[bytes] = (), ocsps: Sequence[bytes] = ()
    ) -> RevocationStatus:
        """Return `good`, `revoked` or `unknown` for the DER `chain` (leaf first) at the aware `moment`.

        `crls` and `ocsps` add archived status for this call (a trust policy's `archived_crls` and `archived_ocsp`). A
        naive `moment` is a programming error (`ValueError`); every other failure is `unknown`.
        """
        if moment.tzinfo is None or moment.utcoffset() is None:
            raise ValueError("the revocation moment must be timezone-aware")
        extra_crls = tuple(bytes(item) for item in crls)
        extra_ocsps = tuple(bytes(item) for item in ocsps)
        if not self._readable or not _all_readable((), extra_crls, extra_ocsps):
            return "unknown"
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            pass
        else:  # called on a thread whose loop runs: the status is not learnt here (the worker's job)
            return "unknown"
        runner = asyncio.Runner(loop_factory=asyncio.new_event_loop)  # the thread's current loop is left alone
        try:
            return runner.run(
                self._judge(tuple(chain), moment, (*self._crls, *extra_crls), (*self._ocsps, *extra_ocsps))
            )
        except (
            Exception,
            asyncio.CancelledError,
        ):  # whatever the library or the input raises, the status was not learnt
            return "unknown"
        finally:
            runner.close()

    async def _judge(
        self, chain: tuple[bytes, ...], moment: dt.datetime, crls: tuple[bytes, ...], ocsps: tuple[bytes, ...]
    ) -> RevocationStatus:
        if not chain or not self._roots or not all(_reads_certificate(item) for item in chain):
            return "unknown"
        parsed = [x509.load_der_x509_certificate(item) for item in chain]
        crls = tuple(item for item in crls if not _issued_after_expiry_crl(item, parsed))
        ocsps = tuple(item for item in ocsps if not _issued_after_expiry_ocsp(item, parsed))
        context = ValidationContext(
            trust_roots=[_Certificate.load(item) for item in self._roots],
            other_certs=[_Certificate.load(item) for item in chain[1:]],
            crls=list(crls),
            ocsps=list(ocsps),
            moment=moment,
            revocation_mode="hard-fail",
            allow_fetching=False,
            retroactive_revinfo=True,
        )
        validator: Any = CertificateValidator(_Certificate.load(chain[0]), validation_context=context)
        try:
            path = await validator.async_validate_usage(set())  # no key usage asked: the path and its status
        except RevokedError:
            return "revoked"
        checked = list(path.iter_certs(include_root=False))
        if not checked:  # a path that is only a trust root has no issuer to hold a status: nothing was looked up
            return "unknown"
        if not all(_names_a_status_source(certificate.dump()) for certificate in checked):
            return "unknown"
        return "good"


def _all_readable(certificates: tuple[bytes, ...], crls: tuple[bytes, ...], ocsps: tuple[bytes, ...]) -> bool:
    return (
        all(_reads_certificate(item) for item in certificates)
        and all(_reads_crl(item) for item in crls)
        and all(_reads_ocsp(item) for item in ocsps)
    )


def _reads_certificate(der: bytes) -> bool:
    try:
        x509.load_der_x509_certificate(der)
    except ValueError:
        return False
    return True


def _reads_crl(der: bytes) -> bool:
    try:
        x509.load_der_x509_crl(der)
    except ValueError:
        return False
    return True


def _reads_ocsp(der: bytes) -> bool:
    try:
        ocsp.load_der_ocsp_response(der)
    except ValueError:
        return False
    return True


def _names_a_status_source(der: bytes) -> bool:
    """Whether the certificate names a CRL distribution point or an OCSP responder (hard-fail asks nothing else)."""
    extensions = x509.load_der_x509_certificate(der).extensions
    try:
        extensions.get_extension_for_class(x509.CRLDistributionPoints)
    except x509.ExtensionNotFound:
        pass
    else:
        return True
    try:
        access = extensions.get_extension_for_class(x509.AuthorityInformationAccess).value
    except x509.ExtensionNotFound:
        return False
    return any(item.access_method == AuthorityInformationAccessOID.OCSP for item in access)


def _issued_after_expiry_crl(der: bytes, chain: list[x509.Certificate]) -> bool:
    crl = x509.load_der_x509_crl(der)
    return any(c.issuer == crl.issuer and crl.last_update_utc > c.not_valid_after_utc for c in chain)


def _issued_after_expiry_ocsp(der: bytes, chain: list[x509.Certificate]) -> bool:
    response = ocsp.load_der_ocsp_response(der)
    if response.response_status is not ocsp.OCSPResponseStatus.SUCCESSFUL:
        return False
    return any(
        single.serial_number == c.serial_number and single.this_update_utc > c.not_valid_after_utc
        for single in response.responses
        for c in chain
    )
