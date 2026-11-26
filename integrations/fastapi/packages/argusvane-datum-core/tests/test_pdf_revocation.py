"""`CertvalidatorRevocationChecker`: offline revocation, hard-fail.

The one adapter over `pyhanko-certvalidator` (extra `argusvane-datum-core[revocation]`):
`ValidationContext(trust_roots=roots, crls=, ocsps=, moment=, revocation_mode="hard-fail", allow_fetching=False,
retroactive_revinfo=True)` and `CertificateValidator(...).async_validate_usage(set())`, run on an `asyncio.Runner()` the
adapter owns for the call and closes in `finally` (the library is async only; never `anyio.from_thread`). `status(chain,
moment)` answers `good`, `revoked` or `unknown`; whatever cannot be judged (no information, a CRL of another issuer, a
stale one, a chain the adapter cannot read, any exception) is `unknown`, never `good`.

The first four rows are the library's own and are pinned here against the library (the first block), so a bump of the
`pyhanko-certvalidator` floor that changes them fails here. The adapter's rows follow. Where the library would pass a
chain the adapter must not (a certificate that names no CRL distribution point and no OCSP responder passes under
`hard-fail`, listed or not), the adapter says `unknown`. OCSP is tried (good, revoked, none, and a response from after
the moment); delta and indirect CRLs are not and are recorded as unproven.
"""

import ast
import asyncio
import datetime as dt
import socket
import subprocess
import sys
import textwrap
import threading
from pathlib import Path
from typing import Any

import pytest
from tsa_support import run_openssl

import datum_core

pytest.importorskip(
    "pyhanko_certvalidator", reason="the revocation extra (argusvane-datum-core[revocation]) is not installed"
)

import pyhanko_certvalidator
from asn1crypto import crl as _asn1_crl  # type: ignore[import-untyped]  # pyright: ignore[reportMissingTypeStubs]
from asn1crypto import ocsp as _asn1_ocsp  # pyright: ignore[reportMissingTypeStubs]
from asn1crypto import x509 as _asn1_x509  # pyright: ignore[reportMissingTypeStubs]
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509 import ocsp
from cryptography.x509.oid import NameOID
from pyhanko_certvalidator import CertificateValidator, ValidationContext
from pyhanko_certvalidator.errors import InsufficientRevinfoError, RevokedError

from datum_core.testing.openssl import requires_openssl
from datum_core.testing.tsa_pki import (
    CRL_URI,
    DOCUMENT_SIGNING,
    EXPIRED_LEAF_SIGNED_AT,
    INSTANT,
    DocumentPki,
    TsaIdentity,
    build_document_pki,
    make_crl,
    make_leaf,
    make_ocsp_response,
    make_root,
)

SRC = Path(datum_core.__file__ or "").parent
# asn1crypto ships no type information: its modules are `Any` here (the library rows below speak to it directly).
asn1_crl: Any = _asn1_crl
asn1_ocsp: Any = _asn1_ocsp
asn1_x509: Any = _asn1_x509
REVOKED_AT = dt.datetime(2026, 6, 1, tzinfo=dt.UTC)
BEFORE = dt.datetime(2026, 3, 1, tzinfo=dt.UTC)
AFTER = dt.datetime(2026, 9, 1, tzinfo=dt.UTC)


@pytest.fixture(scope="module")
def pki() -> DocumentPki:
    return build_document_pki()


def crl_der(pki: DocumentPki, identity: TsaIdentity | None = None, *, revoked: bool = True, **more: Any) -> bytes:
    target = identity or pki.signer
    entries = [(target.leaf.serial_number, REVOKED_AT)] if revoked else []
    crl = make_crl(target.root, target.root_key, entries, **more)
    return crl.public_bytes(serialization.Encoding.DER)


def checker(
    pki: DocumentPki, *crls: bytes, ocsps: tuple[bytes, ...] = (), roots: tuple[bytes, ...] | None = None
) -> Any:
    from datum_core.pdf import CertvalidatorRevocationChecker  # noqa: PLC0415 - the library rows run without it

    return CertvalidatorRevocationChecker(
        roots=roots if roots is not None else (pki.signer.root_der,), crls=crls, ocsps=ocsps
    )


# -- against the library itself ----------------------------------------------------------------------------------
def library_verdict(pki: DocumentPki, moment: dt.datetime, *, retroactive: bool, crls: tuple[bytes, ...]) -> str:
    async def go() -> None:
        context = ValidationContext(
            trust_roots=[asn1_x509.Certificate.load(pki.signer.root_der)],
            crls=[asn1_crl.CertificateList.load(item) for item in crls],
            moment=moment,
            revocation_mode="hard-fail",
            allow_fetching=False,
            retroactive_revinfo=retroactive,
        )
        validator: Any = CertificateValidator(
            asn1_x509.Certificate.load(pki.signer.leaf_der), validation_context=context
        )
        await validator.async_validate_usage(set())

    with asyncio.Runner() as runner:
        try:
            runner.run(go())
        except RevokedError:
            return "revoked"
        except InsufficientRevinfoError as error:
            return "insufficient" + (" too-recent" if "too recent" in str(error) else "")
    return "valid"


@pytest.mark.parametrize(
    ("moment", "retroactive", "expected"),
    [
        (BEFORE, False, "insufficient too-recent"),  # the CRL (issued after the moment) is refused as too recent
        (AFTER, False, "insufficient too-recent"),
        (BEFORE, True, "valid"),
        (AFTER, True, "revoked"),
    ],
)
def test_the_four_revocation_rows_hold_for_the_library(
    pki: DocumentPki, moment: dt.datetime, retroactive: bool, expected: str
) -> None:
    verdict = library_verdict(pki, moment, retroactive=retroactive, crls=(crl_der(pki),))
    assert verdict == expected


def test_the_library_passes_a_leaf_that_names_no_crl_point_even_when_a_crl_lists_it(pki: DocumentPki) -> None:
    """The reason the adapter checks for a pointer itself: `hard-fail` does not ask a pointer-less leaf for a CRL."""

    async def go() -> str:
        crl = make_crl(pki.signer.root, pki.signer.root_key, [(pki.no_crl_point.leaf.serial_number, REVOKED_AT)])
        context = ValidationContext(
            trust_roots=[asn1_x509.Certificate.load(pki.signer.root_der)],
            crls=[asn1_crl.CertificateList.load(crl.public_bytes(serialization.Encoding.DER))],
            moment=AFTER,
            revocation_mode="hard-fail",
            allow_fetching=False,
            retroactive_revinfo=True,
        )
        validator: Any = CertificateValidator(
            asn1_x509.Certificate.load(pki.no_crl_point.leaf_der), validation_context=context
        )
        await validator.async_validate_usage(set())
        return "valid"

    with asyncio.Runner() as runner:
        assert runner.run(go()) == "valid"


# -- the adapter: the four rows ----------------------------------------------------------------------------------------
def test_a_leaf_is_good_before_its_revocation_time_even_though_the_crl_is_newer_than_the_moment(
    pki: DocumentPki,
) -> None:
    assert checker(pki, crl_der(pki)).status(pki.signer.chain_der, BEFORE) == "good"


def test_a_leaf_is_revoked_after_its_revocation_time(pki: DocumentPki) -> None:
    assert checker(pki, crl_der(pki)).status(pki.signer.chain_der, AFTER) == "revoked"


def test_a_leaf_the_crl_does_not_list_is_good_now(pki: DocumentPki) -> None:
    assert checker(pki, crl_der(pki, revoked=False)).status(pki.signer.chain_der, INSTANT) == "good"


def test_the_same_answers_come_with_the_leaf_alone_or_with_the_root_in_the_chain(pki: DocumentPki) -> None:
    adapter = checker(pki, crl_der(pki))
    assert adapter.status((pki.signer.leaf_der,), AFTER) == "revoked"
    assert adapter.status(pki.signer.chain_der, AFTER) == "revoked"
    assert adapter.status((pki.signer.leaf_der,), BEFORE) == "good"


def test_a_chain_judged_in_the_past_is_good_when_a_crl_of_that_time_lists_nothing(pki: DocumentPki) -> None:
    old = crl_der(
        pki,
        revoked=False,
        this_update=dt.datetime(2026, 2, 28, tzinfo=dt.UTC),
        next_update=dt.datetime(2026, 3, 7, tzinfo=dt.UTC),
    )
    assert checker(pki, old).status(pki.expired.chain_der, EXPIRED_LEAF_SIGNED_AT) == "good"


# -- the adapter: unknown, never good ----------------------------------------------------------------------------------
def test_no_crl_at_all_is_unknown(pki: DocumentPki) -> None:
    assert checker(pki).status(pki.signer.chain_der, INSTANT) == "unknown"


def test_a_crl_of_another_issuer_is_unknown(pki: DocumentPki) -> None:
    foreign = make_crl(pki.stranger.root, pki.stranger.root_key, []).public_bytes(serialization.Encoding.DER)
    assert checker(pki, foreign).status(pki.signer.chain_der, INSTANT) == "unknown"


def test_a_crl_whose_next_update_has_passed_at_the_moment_is_unknown(pki: DocumentPki) -> None:
    stale = crl_der(
        pki,
        revoked=False,
        this_update=dt.datetime(2026, 1, 2, tzinfo=dt.UTC),
        next_update=dt.datetime(2026, 1, 9, tzinfo=dt.UTC),
    )
    assert checker(pki, stale).status(pki.signer.chain_der, INSTANT) == "unknown"


def test_a_leaf_that_names_no_crl_point_and_no_responder_is_unknown_even_with_a_crl_that_lists_it(
    pki: DocumentPki,
) -> None:
    crl = make_crl(pki.signer.root, pki.signer.root_key, [(pki.no_crl_point.leaf.serial_number, REVOKED_AT)])
    adapter = checker(pki, crl.public_bytes(serialization.Encoding.DER))
    assert adapter.status(pki.no_crl_point.chain_der, AFTER) == "unknown"
    assert adapter.status(pki.no_crl_point.chain_der, BEFORE) == "unknown"


def test_a_chain_to_a_root_the_adapter_was_not_given_is_unknown(pki: DocumentPki) -> None:
    other = (pki.stranger.root_der,)
    assert checker(pki, crl_der(pki, revoked=False), roots=other).status(pki.signer.chain_der, INSTANT) == "unknown"


def test_no_roots_is_unknown_never_an_implicit_system_store(pki: DocumentPki) -> None:
    assert checker(pki, crl_der(pki, revoked=False), roots=()).status(pki.signer.chain_der, INSTANT) == "unknown"


@pytest.mark.parametrize("chain", [(), (b"not a certificate",), (b"",), (b"\x30\x03\x02\x01\x00",)])
def test_a_chain_the_adapter_cannot_read_is_unknown_and_nothing_is_raised(
    pki: DocumentPki, chain: tuple[bytes, ...]
) -> None:
    assert checker(pki, crl_der(pki)).status(chain, INSTANT) == "unknown"


def test_a_crl_the_adapter_cannot_read_is_unknown_and_nothing_is_raised(pki: DocumentPki) -> None:
    assert checker(pki, b"not a crl").status(pki.signer.chain_der, INSTANT) == "unknown"


def test_an_exception_inside_the_library_is_unknown_never_good(
    pki: DocumentPki, monkeypatch: pytest.MonkeyPatch
) -> None:
    import pyhanko_certvalidator  # noqa: PLC0415 - patched below

    def boom(*_a: object, **_k: object) -> None:
        raise RuntimeError("library failure")

    monkeypatch.setattr(pyhanko_certvalidator.CertificateValidator, "async_validate_usage", boom)
    assert checker(pki, crl_der(pki, revoked=False)).status(pki.signer.chain_der, INSTANT) == "unknown"


def test_a_naive_moment_is_a_programming_error(pki: DocumentPki) -> None:
    with pytest.raises(ValueError, match="aware"):
        checker(pki, crl_der(pki)).status(pki.signer.chain_der, INSTANT.replace(tzinfo=None))


# -- archived status handed per call (the trust policy's archived_crls and archived_ocsp) ---------------------------
def test_an_archived_crl_handed_with_the_call_is_read_beside_the_adapters_own(pki: DocumentPki) -> None:
    adapter = checker(pki)
    assert adapter.status(pki.signer.chain_der, AFTER) == "unknown"
    assert adapter.status(pki.signer.chain_der, AFTER, crls=(crl_der(pki),)) == "revoked"
    assert adapter.status(pki.signer.chain_der, BEFORE, crls=(crl_der(pki),)) == "good"
    assert adapter.status(pki.signer.chain_der, AFTER) == "unknown", "nothing handed with a call is kept"


def test_an_archived_ocsp_response_handed_with_the_call_is_read(pki: DocumentPki) -> None:
    response = ocsp_response(pki, ocsp.OCSPCertStatus.GOOD)
    assert checker(pki).status(pki.ocsp_signer.chain_der, INSTANT, ocsps=(response,)) == "good"


def test_an_unreadable_archive_handed_with_the_call_is_unknown(pki: DocumentPki) -> None:
    adapter = checker(pki, crl_der(pki, revoked=False))
    assert adapter.status(pki.signer.chain_der, INSTANT, crls=(b"junk",)) == "unknown"
    assert adapter.status(pki.signer.chain_der, INSTANT, ocsps=(b"junk",)) == "unknown"


def test_a_signing_time_policy_reads_unknown_without_the_archived_status_of_that_time_and_trusted_with_it(
    pki: DocumentPki,
) -> None:
    """The revocation check moves back with the judging time; only the status of that time can pass it."""
    from datum_core.pdf import PdfTrustPolicy  # noqa: PLC0415 - beside the adapter
    from datum_core.pdf.protocols import PdfTrustVerdict, PdfValidationTime  # noqa: PLC0415

    then = crl_der(
        pki,
        pki.expired,
        revoked=False,
        this_update=dt.datetime(2026, 2, 28, tzinfo=dt.UTC),
        next_update=dt.datetime(2026, 3, 7, tzinfo=dt.UTC),
    )
    adapter = checker(pki)
    without = PdfTrustPolicy(
        anchors=(pki.signer.root_der,), revocation=adapter, validation_time=PdfValidationTime.SIGNING_TIME
    )
    archived = PdfTrustPolicy(
        anchors=(pki.signer.root_der,),
        revocation=adapter,
        archived_crls=(then,),
        validation_time=PdfValidationTime.SIGNING_TIME,
    )
    at = EXPIRED_LEAF_SIGNED_AT
    assert without.judge(pki.expired.chain_der, now=INSTANT, proven_time=at) == PdfTrustVerdict("unknown")
    assert archived.judge(pki.expired.chain_der, now=INSTANT, proven_time=at) == PdfTrustVerdict("trusted", at)


# -- OCSP --------------------------------------------------------------------------------------------------------------
def ocsp_response(pki: DocumentPki, status: ocsp.OCSPCertStatus, **more: Any) -> bytes:
    leaf = pki.ocsp_signer
    return make_ocsp_response(leaf.leaf, leaf.root, leaf.root_key, status, **more)


def test_a_good_ocsp_response_makes_the_leaf_good_now(pki: DocumentPki) -> None:
    adapter = checker(pki, ocsps=(ocsp_response(pki, ocsp.OCSPCertStatus.GOOD),))
    assert adapter.status(pki.ocsp_signer.chain_der, INSTANT) == "good"


def test_a_revoked_ocsp_response_makes_the_leaf_revoked(pki: DocumentPki) -> None:
    response = ocsp_response(pki, ocsp.OCSPCertStatus.REVOKED, revoked_at=REVOKED_AT)
    assert checker(pki, ocsps=(response,)).status(pki.ocsp_signer.chain_der, INSTANT) == "revoked"
    assert checker(pki, ocsps=(response,)).status(pki.ocsp_signer.chain_der, AFTER) == "revoked"


def test_an_ocsp_response_from_after_the_moment_is_not_evidence_of_the_past_so_it_is_unknown(pki: DocumentPki) -> None:
    response = ocsp_response(pki, ocsp.OCSPCertStatus.REVOKED, revoked_at=REVOKED_AT)
    assert checker(pki, ocsps=(response,)).status(pki.ocsp_signer.chain_der, BEFORE) == "unknown"


def test_no_ocsp_response_for_a_responder_leaf_is_unknown(pki: DocumentPki) -> None:
    assert checker(pki).status(pki.ocsp_signer.chain_der, INSTANT) == "unknown"
    assert (
        asn1_ocsp.OCSPResponse.load(ocsp_response(pki, ocsp.OCSPCertStatus.GOOD))["response_status"].native
        == "successful"
    )


# -- isolation ---------------------------------------------------------------------------------------------------------
def test_no_network_call_is_made(pki: DocumentPki, monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[str] = []

    def refuse(name: str) -> Any:
        def inner(*_a: object, **_k: object) -> None:
            calls.append(name)
            raise OSError("network blocked")

        return inner

    monkeypatch.setattr(socket.socket, "connect", refuse("connect"))
    monkeypatch.setattr(socket.socket, "connect_ex", refuse("connect_ex"))
    monkeypatch.setattr(socket, "create_connection", refuse("create_connection"))
    monkeypatch.setattr(socket, "getaddrinfo", refuse("getaddrinfo"))
    adapter = checker(pki, crl_der(pki), ocsps=(ocsp_response(pki, ocsp.OCSPCertStatus.GOOD),))
    answers = {
        (name, moment.month): adapter.status(getattr(pki, name).chain_der, moment)
        for name in ("signer", "no_crl_point", "ocsp_signer", "stranger")
        for moment in (BEFORE, AFTER, INSTANT)
    }
    assert [answers[("signer", month)] for month in (3, 9, 10)] == ["good", "revoked", "revoked"]
    assert {answers[("no_crl_point", month)] for month in (3, 9, 10)} == {"unknown"}
    assert {answers[("stranger", month)] for month in (3, 9, 10)} == {"unknown"}
    assert answers[("ocsp_signer", 10)] == "good"
    assert calls == []


def test_oscrypto_and_aiohttp_are_never_imported_by_a_validation() -> None:
    probe = textwrap.dedent(
        """
        import datetime as dt, sys
        from datum_core.pdf import CertvalidatorRevocationChecker
        from datum_core.testing.tsa_pki import INSTANT, build_document_pki, make_crl
        from cryptography.hazmat.primitives import serialization
        pki = build_document_pki()
        crl = make_crl(pki.signer.root, pki.signer.root_key, []).public_bytes(serialization.Encoding.DER)
        from cryptography.x509 import ocsp
        from datum_core.testing.tsa_pki import make_ocsp_response
        checker = CertvalidatorRevocationChecker(roots=(pki.signer.root_der,), crls=(crl,))
        print(checker.status(pki.signer.chain_der, INSTANT))
        entry = (pki.signer.leaf.serial_number, dt.datetime(2026, 6, 1, tzinfo=dt.UTC))
        listing = make_crl(pki.signer.root, pki.signer.root_key, [entry])
        revoked = CertvalidatorRevocationChecker(
            roots=(pki.signer.root_der,), crls=(listing.public_bytes(serialization.Encoding.DER),)
        )
        print(revoked.status(pki.signer.chain_der, INSTANT))
        leaf = pki.ocsp_signer
        response = make_ocsp_response(leaf.leaf, leaf.root, leaf.root_key, ocsp.OCSPCertStatus.GOOD)
        by_ocsp = CertvalidatorRevocationChecker(roots=(pki.signer.root_der,), ocsps=(response,))
        print(by_ocsp.status(leaf.chain_der, INSTANT))
        print(CertvalidatorRevocationChecker(roots=(pki.signer.root_der,)).status(pki.signer.chain_der, INSTANT))
        print("oscrypto" in sys.modules, "aiohttp" in sys.modules)
        """
    )
    done = subprocess.run([sys.executable, "-I", "-c", probe], capture_output=True, text=True, check=False, timeout=120)  # noqa: S603
    assert done.returncode == 0, done.stderr
    assert done.stdout.split() == ["good", "revoked", "good", "unknown", "False", "False"]


def test_no_event_loop_and_no_thread_survives_a_call_and_none_is_running_during_the_caller_s_turn(
    pki: DocumentPki,
) -> None:
    adapter = checker(pki, crl_der(pki))
    before = {thread.ident for thread in threading.enumerate()}
    for moment in (BEFORE, AFTER, INSTANT):
        adapter.status(pki.signer.chain_der, moment)
    adapter.status((b"junk",), INSTANT)
    assert {thread.ident for thread in threading.enumerate()} == before
    with pytest.raises(RuntimeError):
        asyncio.get_running_loop()
    # the calling thread keeps no loop of its own either
    import warnings  # noqa: PLC0415 - one use

    with warnings.catch_warnings():
        warnings.simplefilter("ignore", DeprecationWarning)
        try:
            loop = asyncio.get_event_loop_policy().get_event_loop()  # pyright: ignore[reportDeprecated]
        except RuntimeError:
            loop = None
    assert loop is None or not loop.is_running()


def test_the_adapter_makes_one_runner_per_call_and_closes_it_even_when_the_call_fails(
    pki: DocumentPki, monkeypatch: pytest.MonkeyPatch
) -> None:
    made: list[asyncio.Runner] = []
    closed: list[asyncio.Runner] = []
    original_init = asyncio.Runner.__init__
    original_close = asyncio.Runner.close

    def counting_init(self: asyncio.Runner, *args: Any, **kwargs: Any) -> None:
        made.append(self)
        original_init(self, *args, **kwargs)

    def counting_close(self: asyncio.Runner) -> None:
        closed.append(self)
        original_close(self)

    monkeypatch.setattr(asyncio.Runner, "__init__", counting_init)
    monkeypatch.setattr(asyncio.Runner, "close", counting_close)
    adapter = checker(pki, crl_der(pki))
    adapter.status(pki.signer.chain_der, BEFORE)
    adapter.status(pki.signer.chain_der, AFTER)

    def boom(*_a: object, **_k: object) -> None:
        raise RuntimeError("library failure")

    monkeypatch.setattr(pyhanko_certvalidator.CertificateValidator, "async_validate_usage", boom)
    assert adapter.status(pki.signer.chain_der, INSTANT) == "unknown"
    assert len(made) == 3, "a new runner for every call (no shared loop to leak state or contend)"
    assert all(runner in closed for runner in made), "closed even when the call failed"


def test_calls_from_several_threads_agree_and_leave_no_thread(pki: DocumentPki) -> None:
    adapter = checker(pki, crl_der(pki))
    answers: list[str] = []
    lock = threading.Lock()

    def work(moment: dt.datetime) -> None:
        for _ in range(3):
            verdict = adapter.status(pki.signer.chain_der, moment)
            with lock:
                answers.append(verdict)

    before = threading.active_count()
    threads = [threading.Thread(target=work, args=(BEFORE if index % 2 else AFTER,)) for index in range(6)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=120)
    assert sorted(answers) == ["good"] * 9 + ["revoked"] * 9
    assert threading.active_count() == before


def test_the_adapter_runs_its_own_runner_not_the_applications_loop() -> None:
    tree = ast.parse((SRC / "pdf" / "revocation.py").read_text(encoding="utf-8"))
    names = {node.attr for node in ast.walk(tree) if isinstance(node, ast.Attribute)} | {
        node.id for node in ast.walk(tree) if isinstance(node, ast.Name)
    }
    imported = {
        alias.name.partition(".")[0] for node in ast.walk(tree) if isinstance(node, ast.Import) for alias in node.names
    } | {(node.module or "").partition(".")[0] for node in ast.walk(tree) if isinstance(node, ast.ImportFrom)}
    assert "Runner" in names
    assert "anyio" not in imported
    assert "from_thread" not in names
    assert "oscrypto" not in imported
    assert "aiohttp" not in imported


def test_the_adapter_sets_the_three_library_arguments_that_make_it_safe() -> None:
    text = (SRC / "pdf" / "revocation.py").read_text(encoding="utf-8")
    assert 'revocation_mode="hard-fail"' in text
    assert "allow_fetching=False" in text
    assert "retroactive_revinfo=True" in text


# -- trust rows --------------------------------------------------------------------------------------------
def crl_at(pki: DocumentPki, identity: TsaIdentity, this_update: dt.datetime) -> bytes:
    return crl_der(pki, identity, revoked=False, this_update=this_update)


def test_a_crl_issued_after_the_certificate_expired_proves_nothing_about_the_earlier_moment(pki: DocumentPki) -> None:
    """RFC 5280 3.3: a CA may drop an expired certificate's entry, so a later, empty CRL is not a clean bill."""
    for issued in (INSTANT, dt.datetime(2026, 7, 1, tzinfo=dt.UTC)):
        crl = crl_at(pki, pki.expired, issued)
        assert checker(pki, crl).status(pki.expired.chain_der, EXPIRED_LEAF_SIGNED_AT) == "unknown"


def test_a_crl_issued_before_the_certificate_expired_still_clears_the_earlier_moment(pki: DocumentPki) -> None:
    crl = crl_at(pki, pki.expired, dt.datetime(2026, 5, 1, tzinfo=dt.UTC))
    assert checker(pki, crl).status(pki.expired.chain_der, EXPIRED_LEAF_SIGNED_AT) == "good"


def test_an_ocsp_response_issued_after_the_certificate_expired_is_unknown(pki: DocumentPki) -> None:
    key = rsa.generate_private_key(65537, 2048)
    leaf = make_leaf(
        "Test expired responder leaf",
        key,
        pki.signer.root,
        pki.signer.root_key,
        eku=(DOCUMENT_SIGNING,),
        eku_critical=False,
        ocsp_uri="http://ocsp.test.invalid/",
        not_before=dt.datetime(2026, 1, 1, tzinfo=dt.UTC),
        not_after=dt.datetime(2026, 6, 1, tzinfo=dt.UTC),
    )
    chain = (leaf.public_bytes(serialization.Encoding.DER), pki.signer.root_der)
    late = make_ocsp_response(leaf, pki.signer.root, pki.signer.root_key, ocsp.OCSPCertStatus.GOOD, this_update=INSTANT)
    assert checker(pki, ocsps=(late,)).status(chain, EXPIRED_LEAF_SIGNED_AT) == "unknown"


def test_a_signing_time_policy_over_an_expired_leaf_reads_unknown_with_only_a_later_crl(pki: DocumentPki) -> None:
    from datum_core.pdf import PdfTrustPolicy  # noqa: PLC0415 - beside the adapter
    from datum_core.pdf.protocols import PdfTrustVerdict, PdfValidationTime  # noqa: PLC0415

    policy = PdfTrustPolicy(
        anchors=(pki.signer.root_der,),
        revocation=checker(pki, crl_at(pki, pki.expired, INSTANT)),
        validation_time=PdfValidationTime.SIGNING_TIME,
    )
    verdict = policy.judge(pki.expired.chain_der, now=INSTANT, proven_time=EXPIRED_LEAF_SIGNED_AT)
    assert verdict == PdfTrustVerdict("unknown")


class Tiers:
    """root -> intermediate -> leaf, both certificates naming a CRL point."""

    def __init__(self, *, intermediate_points: bool = True) -> None:
        self.root_key = rsa.generate_private_key(65537, 3072)
        self.root = make_root("Test tiered root", self.root_key, path_length=1)
        self.ca_key = rsa.generate_private_key(65537, 2048)
        builder = (
            x509.CertificateBuilder()
            .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Test tiered intermediate")]))
            .issuer_name(self.root.subject)
            .public_key(self.ca_key.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(self.root.not_valid_before_utc)
            .not_valid_after(self.root.not_valid_after_utc)
            .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
            .add_extension(x509.KeyUsage(True, False, False, False, False, True, True, False, False), critical=True)
            .add_extension(x509.SubjectKeyIdentifier.from_public_key(self.ca_key.public_key()), critical=False)
            .add_extension(
                x509.AuthorityKeyIdentifier.from_issuer_public_key(self.root_key.public_key()), critical=False
            )
        )
        if intermediate_points:
            point = x509.DistributionPoint([x509.UniformResourceIdentifier(CRL_URI + ".root")], None, None, None)
            builder = builder.add_extension(x509.CRLDistributionPoints([point]), critical=False)
        self.ca = builder.sign(self.root_key, hashes.SHA256())
        self.leaf = make_leaf(
            "Test tiered leaf",
            rsa.generate_private_key(65537, 2048),
            self.ca,
            self.ca_key,
            eku=(DOCUMENT_SIGNING,),
            eku_critical=False,
            crl_uri=CRL_URI,
        )
        der = serialization.Encoding.DER
        self.root_der = self.root.public_bytes(der)
        self.chain = (self.leaf.public_bytes(der), self.ca.public_bytes(der), self.root_der)
        self.leaf_crl = make_crl(self.ca, self.ca_key, []).public_bytes(der)
        self.root_crl = make_crl(self.root, self.root_key, []).public_bytes(der)
        self.root_crl_listing = make_crl(self.root, self.root_key, [(self.ca.serial_number, REVOKED_AT)]).public_bytes(
            der
        )

    def status(self, *crls: bytes, moment: dt.datetime = INSTANT) -> str:
        from datum_core.pdf import CertvalidatorRevocationChecker  # noqa: PLC0415

        adapter = CertvalidatorRevocationChecker(roots=(self.root_der,), crls=crls)
        return str(adapter.status(self.chain, moment))


def test_an_intermediate_is_checked_too_clean_crls_for_both_tiers_are_good() -> None:
    tiers = Tiers()
    assert tiers.status(tiers.leaf_crl, tiers.root_crl) == "good"


def test_an_intermediate_whose_crl_is_missing_makes_the_path_unknown() -> None:
    tiers = Tiers()
    assert tiers.status(tiers.leaf_crl) == "unknown"


def test_a_revoked_intermediate_makes_the_path_revoked_and_the_policy_untrusted() -> None:
    from datum_core.pdf import CertvalidatorRevocationChecker, PdfTrustPolicy  # noqa: PLC0415
    from datum_core.pdf.protocols import PdfTrustVerdict  # noqa: PLC0415

    tiers = Tiers()
    assert tiers.status(tiers.leaf_crl, tiers.root_crl_listing) == "revoked"
    adapter = CertvalidatorRevocationChecker(roots=(tiers.root_der,), crls=(tiers.leaf_crl, tiers.root_crl_listing))
    policy = PdfTrustPolicy(anchors=(tiers.root_der,), revocation=adapter)
    assert policy.judge(tiers.chain[:2], now=INSTANT) == PdfTrustVerdict("unknown")


def test_an_intermediate_that_names_no_crl_point_is_unknown_even_when_the_root_crl_lists_it() -> None:
    tiers = Tiers(intermediate_points=False)
    assert tiers.status(tiers.leaf_crl, tiers.root_crl_listing) == "unknown"


def test_the_thread_s_own_event_loop_is_left_as_found(pki: DocumentPki) -> None:
    import warnings  # noqa: PLC0415 - one use

    result: list[object] = []

    def work() -> None:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            checker(pki, crl_der(pki)).status(pki.signer.chain_der, BEFORE)
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", DeprecationWarning)
                current = asyncio.get_event_loop_policy().get_event_loop()  # pyright: ignore[reportDeprecated]
            result.append(current is loop)
        finally:
            asyncio.set_event_loop(None)
            loop.close()

    thread = threading.Thread(target=work)
    thread.start()
    thread.join(timeout=120)
    assert result == [True]


def test_a_call_on_a_thread_whose_loop_is_running_is_unknown_without_a_warning(pki: DocumentPki) -> None:
    import warnings  # noqa: PLC0415 - one use

    async def go() -> str:
        return str(checker(pki, crl_der(pki)).status(pki.signer.chain_der, BEFORE))

    with warnings.catch_warnings():
        warnings.simplefilter("error", RuntimeWarning)
        assert asyncio.run(go()) == "unknown"


def test_a_cancellation_inside_the_library_is_unknown_not_a_cancellation(
    pki: DocumentPki, monkeypatch: pytest.MonkeyPatch
) -> None:
    from datum_core.pdf import PdfTrustPolicy  # noqa: PLC0415
    from datum_core.pdf.protocols import PdfTrustVerdict  # noqa: PLC0415

    def cancel(*_a: object, **_k: object) -> None:
        raise asyncio.CancelledError

    monkeypatch.setattr(pyhanko_certvalidator.CertificateValidator, "async_validate_usage", cancel)
    adapter = checker(pki, crl_der(pki, revoked=False))
    assert adapter.status(pki.signer.chain_der, INSTANT) == "unknown"
    policy = PdfTrustPolicy(anchors=(pki.signer.root_der,), revocation=adapter)
    assert policy.judge(pki.signer.chain_der, now=INSTANT) == PdfTrustVerdict("unknown")


# -- unknown, never good -----------------------------------------------------------------------------------------------
def test_a_path_that_is_only_a_trust_root_is_unknown_never_good_as_nothing_was_looked_up(pki: DocumentPki) -> None:
    assert checker(pki).status((pki.signer.root_der,), INSTANT) == "unknown"
    assert checker(pki, roots=(pki.signer.leaf_der,)).status((pki.signer.leaf_der,), INSTANT) == "unknown"


def pem_crls(*crls: bytes) -> bytes:
    from datum_core.testing.tsa_pki import bytes_to_pem  # noqa: PLC0415

    return b"".join(bytes_to_pem(item, "X509 CRL") for item in crls)


@requires_openssl
@pytest.mark.parametrize(
    ("which", "expected"),
    [("clean", "good"), ("intermediate-revoked", "revoked"), ("intermediate-crl-missing", "unknown")],
)
def test_openssl_agrees_on_an_intermediate_path_with_its_untrusted_certificate_and_the_crls(
    tmp_path: Path, which: str, expected: str
) -> None:
    from datum_core.testing.tsa_pki import bytes_to_pem  # noqa: PLC0415

    tiers = Tiers()
    crls = {
        "clean": (tiers.leaf_crl, tiers.root_crl),
        "intermediate-revoked": (tiers.leaf_crl, tiers.root_crl_listing),
        "intermediate-crl-missing": (tiers.leaf_crl,),
    }[which]
    assert tiers.status(*crls) == expected
    (tmp_path / "root.pem").write_bytes(bytes_to_pem(tiers.root_der))
    (tmp_path / "ca.pem").write_bytes(bytes_to_pem(tiers.chain[1]))
    (tmp_path / "leaf.pem").write_bytes(bytes_to_pem(tiers.chain[0]))
    (tmp_path / "crls.pem").write_bytes(pem_crls(*crls))
    done = run_openssl(
        "verify", "-purpose", "any", "-attime", str(int(INSTANT.timestamp())),
        "-crl_check_all", "-CRLfile", str(tmp_path / "crls.pem"),
        "-CAfile", str(tmp_path / "root.pem"), "-untrusted", str(tmp_path / "ca.pem"), str(tmp_path / "leaf.pem"),
    )  # fmt: skip
    assert (done.returncode == 0) is (expected == "good"), done.stdout + done.stderr
