"""The seal key, the passwords and the PDF bytes never leave their owners.

Nothing the PDF package, `Datum` or the settings expose may carry the PKCS#12 password, the PEM key's password, the
private key's PEM, its PKCS#8 DER or its numbers, a timestamp credential, or a produced or uploaded PDF's bytes: not in
`repr` or `str`, not in a public attribute (a probe walks every public attribute, slot and container four levels deep),
not in a log record (DEBUG, with message, arguments, extras and traceback), not in an event, the health body, `info()`
or a span, not in the message, hint, arguments, chain or frames of a refusal. The library's key object is opaque and the
only place the key lives. The probe is the timestamp package's (`test_timestamp_secrecy.py`), moved into `pdf_support`.
"""

import copy
import json
import logging
import pickle
from pathlib import Path
from typing import TYPE_CHECKING, Any

import pytest
from cryptography import x509
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec, rsa
from cryptography.hazmat.primitives.serialization import pkcs12
from observe_support import telemetry
from pdf_support import (
    PDF_P12_PASSWORD,
    assert_clean,
    b64,
    chain_text,
    exposed,
    fake_pdf,
    frame_locals,
    log_text,
    pdf_signing,
    pem_signing,
    plain_pdf_datum,
    rsa_pss_files,
    signature_report,
    started_pdf,
    unreadable_curve_chain,
    verify_reply,
)
from tsa_support import KEY_PASSWORD, P12_PASSWORD, leaks, secrets_of

import datum_core
from datum_core.config.models import Signing
from datum_core.pdf import KeyFilePdfSigner, TestSealSigner
from datum_core.pdf.protocols import PdfRequestDraft, PdfResultCandidate
from datum_core.pdf.signer import _HeldKeySigner  # pyright: ignore[reportPrivateUsage]
from datum_core.testing.openssl import openssl_binary
from datum_core.testing.tsa_pki import DocumentPki, TsaIdentity, TsaPki, build_document_pki, make_leaf
from datum_core.timestamp.certificate import TsaSigningKey
from datum_sandbox.checks import DatumConfigurationError
from datum_sandbox.protocol import PdfKernelError

if TYPE_CHECKING:
    from datum_core.events import DatumEvent

WRONG_PASSWORD = "wrong-ZZ-guess-ZZ"
BEARER = "bearer-ZZ-token-ZZ"
BASIC_PASSWORD = "basic-ZZ-password-ZZ"
PDF_BYTES = fake_pdf("document")
PRIVATE_KEYS = (ec.EllipticCurvePrivateKey, rsa.RSAPrivateKey)


@pytest.fixture(scope="module")
def pki() -> DocumentPki:
    return build_document_pki()


@pytest.fixture
def forbidden(pki: DocumentPki) -> list[str | bytes]:
    return [
        *secrets_of(pki.signer, P12_PASSWORD, PDF_P12_PASSWORD, KEY_PASSWORD, WRONG_PASSWORD, BEARER, BASIC_PASSWORD),
        *secrets_of(pki.ec),
    ]


def loaded(tmp_path: Path, identity: TsaIdentity, kind: str) -> KeyFilePdfSigner:
    if kind == "pkcs12":
        return KeyFilePdfSigner.from_settings(pdf_signing(tmp_path, identity, friendly_name="datum-pdf"))
    return KeyFilePdfSigner.from_settings(pem_signing(tmp_path, identity, key_password=KEY_PASSWORD))


# -- the signer --------------------------------------------------------------------------------------------------------
@pytest.mark.parametrize("kind", ["pkcs12", "pem"])
@pytest.mark.parametrize("which", ["signer", "ec"])
def test_the_loaded_signer_shows_no_secret_in_any_public_attribute(
    tmp_path: Path, pki: DocumentPki, forbidden: list[str | bytes], kind: str, which: str
) -> None:
    signer = loaded(tmp_path, getattr(pki, which), kind)
    signer.sign(b"data")
    assert_clean(signer, forbidden, "the signer")
    for text in (repr(signer), str(signer)):
        assert not leaks(text, forbidden)


def test_the_test_seal_shows_no_key_in_any_public_attribute() -> None:
    seal = TestSealSigner()
    seal.sign(b"data")
    text = "\n".join(exposed(seal))
    assert "PRIVATE KEY" not in text


def test_the_test_seal_carries_its_private_scalar_in_no_text_and_refuses_pickling_and_copying() -> None:
    seal = TestSealSigner()
    seal.sign(b"data")
    held: Any = seal._key  # pyright: ignore[reportPrivateUsage]
    key = held._key
    assert isinstance(key, ec.EllipticCurvePrivateKey)
    scalar = key.private_numbers().private_value
    forbidden: list[str | bytes] = [scalar.to_bytes(32, "big"), format(scalar, "064x"), str(scalar), hex(scalar)]
    assert not leaks("\n".join(exposed(seal)), forbidden)
    for text in (repr(seal), str(seal), repr(held), str(held), seal.certificate_chain_pem()):
        assert not leaks(text, forbidden)
        assert "PRIVATE KEY" not in text
    assert "TestSealSigner" in repr(seal)
    assert repr(seal) == str(seal)
    for refuse in (pickle.dumps, copy.copy, copy.deepcopy):
        with pytest.raises(TypeError, match="cannot be pickled or copied"):
            refuse(seal)


@pytest.mark.parametrize("kind", ["pkcs12", "pem"])
def test_the_signer_keeps_the_key_only_as_the_librarys_object_and_no_password(
    tmp_path: Path, pki: DocumentPki, kind: str
) -> None:
    signer = loaded(tmp_path, pki.signer, kind)
    held = list(getattr(signer, "__dict__", {}).values())
    for klass in type(signer).__mro__:
        slots = getattr(klass, "__slots__", ())
        held += [
            getattr(signer, name) for name in ([slots] if isinstance(slots, str) else slots) if hasattr(signer, name)
        ]
    assert not [
        value for value in held if isinstance(value, str) and value in (P12_PASSWORD, PDF_P12_PASSWORD, KEY_PASSWORD)
    ]
    assert not [value for value in held if isinstance(value, bytes | bytearray) and b"PRIVATE KEY" in bytes(value)]
    assert not [value for value in held if isinstance(value, bytes | bytearray) and len(value) > 1000]


def test_pickling_the_signer_is_refused_or_carries_no_key(
    tmp_path: Path, pki: DocumentPki, forbidden: list[str | bytes]
) -> None:
    signer = loaded(tmp_path, pki.signer, "pkcs12")
    try:
        dumped = pickle.dumps(signer)
    except (TypeError, pickle.PicklingError):
        return
    assert not leaks(dumped.decode("latin-1"), forbidden)


def test_the_drafts_and_candidates_hide_the_files_they_carry() -> None:
    candidate = PdfResultCandidate("render", "contact", None, None, PDF_BYTES, 1)
    assert PDF_BYTES.decode("latin-1") not in repr(candidate)
    assert b64(PDF_BYTES) not in repr(candidate)
    draft = PdfRequestDraft(
        "render",
        "contact",
        None,
        None,
        {},
        {},
        {},
        attachments=[{"data": b64(PDF_BYTES)}],
        fonts=[{"data": b64(b"font-bytes")}],
    )
    assert b64(PDF_BYTES) not in repr(draft)
    assert b64(b"font-bytes") not in repr(draft)


# -- refusals ---------------------------------------------------------------------------------------------------------
SRC = Path(datum_core.__file__ or "").parent


def source_frame_locals(error: BaseException) -> list[object]:
    """The locals of every `datum_core` frame of `error`'s traceback chain (the test's own frame holds the fixtures).

    `frame_locals` takes every frame, the test's included, whose locals are the very file bytes being looked for.
    """
    found: list[object] = []
    current: BaseException | None = error
    for _ in range(10):
        if current is None:
            break
        trace = current.__traceback__
        while trace is not None:
            if Path(trace.tb_frame.f_code.co_filename).is_relative_to(SRC):
                found.extend(trace.tb_frame.f_locals.values())
            trace = trace.tb_next
        current = current.__cause__ or current.__context__
    assert len(found) < len(frame_locals(error)), "the test's own frame is left out, nothing else"
    return found


def holds_a_key(local: object) -> bool:
    """Whether a frame local is the private key object, or a library record that carries one."""
    if isinstance(local, (*PRIVATE_KEYS, TsaSigningKey, _HeldKeySigner)):
        return True
    return isinstance(local, pkcs12.PKCS12KeyAndCertificates) and local.key is not None


def hard_refusals(directory: Path, pki: DocumentPki) -> list[Signing]:
    """Settings that fail late in the loader: an RSA-PSS key (when openssl is there) and a negative serial."""
    cases: list[Signing] = []
    if openssl_binary() is not None:
        (directory / "pss").mkdir()
        key_file, cert_file = rsa_pss_files(directory / "pss")
        cases.append(Signing.model_validate({"type": "PEM", "key_file": str(key_file), "cert_file": str(cert_file)}))
    identity = pki.signer
    leaf = make_leaf(
        "negative serial", identity.key, identity.root, identity.root_key, serial=0x7F, eku=(), eku_critical=False
    )
    der = leaf.public_bytes(serialization.Encoding.DER)
    negative = x509.load_der_x509_certificate(der.replace(bytes.fromhex("02017f"), bytes.fromhex("0201ff"), 1))
    (directory / "neg").mkdir()
    key_file, chain_file = directory / "neg" / "key.pem", directory / "neg" / "chain.pem"
    key_file.write_bytes(identity.key_pem())
    chain_file.write_bytes(negative.public_bytes(serialization.Encoding.PEM) + identity.root_pem)
    cases.append(Signing.model_validate({"type": "PEM", "key_file": str(key_file), "cert_file": str(chain_file)}))
    return cases


@pytest.mark.filterwarnings("ignore::cryptography.utils.CryptographyDeprecationWarning")
def test_a_failed_load_writes_no_secret_to_any_log_and_its_error_and_frames_carry_none(
    tmp_path: Path, pki: DocumentPki, forbidden: list[str | bytes], caplog: pytest.LogCaptureFixture
) -> None:
    """No refusal's `datum_core` frame holds the file's bytes, a password, or the key object once it was opened."""
    good = pdf_signing(tmp_path, pki.signer)
    fields = {name: getattr(good, name) for name in Signing.model_fields}
    (tmp_path / "pem").mkdir()
    pem = pem_signing(tmp_path / "pem", pki.signer, key_password=KEY_PASSWORD)
    foreign_chain = tmp_path / "foreign.pem"
    foreign_chain.write_bytes(pki.email.leaf_pem + pki.signer.root_pem)
    no_cert = tmp_path / "no-cert.pem"
    no_cert.write_bytes(b"not a certificate")
    unreadable = tmp_path / "unreadable-curve.pem"
    unreadable.write_bytes(unreadable_curve_chain(pki.ec))
    (tmp_path / "ec").mkdir()
    ec_pem = pem_signing(tmp_path / "ec", pki.ec)
    password_bytes = {value.encode() for value in (P12_PASSWORD, PDF_P12_PASSWORD, WRONG_PASSWORD, KEY_PASSWORD)}
    cases = [
        Signing.model_validate({**ec_pem.model_dump(mode="python"), "cert_file": str(unreadable)}),
        Signing.model_validate({**pem.model_dump(mode="python"), "cert_file": str(no_cert)}),
        Signing.model_validate({**fields, "pkcs12_password": WRONG_PASSWORD}),
        Signing.model_validate({**fields, "pkcs12_password": None}),
        Signing.model_validate({**fields, "pkcs12_file": str(tmp_path / "gone.p12")}),
        Signing.model_validate({**fields, "friendly_name": "not-this-one"}),
        pdf_signing(tmp_path, pki.signer, key_name="a", ca_names=("b",), file_name="two-names.p12"),
        Signing.model_validate(
            {"type": "PEM", "key_file": str(tmp_path / "gone.pem"), "cert_file": str(tmp_path / "gone2.pem")}
        ),
        Signing.model_validate({**pem.model_dump(mode="python"), "cert_file": str(tmp_path / "gone2.pem")}),
        Signing.model_validate({**pem.model_dump(mode="python"), "cert_file": str(foreign_chain)}),
    ]
    cases += hard_refusals(tmp_path, pki)
    p12_bytes = Path(str(good.pkcs12_file)).read_bytes()
    key_bytes = Path(str(pem.key_file)).read_bytes()
    with caplog.at_level(logging.DEBUG):
        for signing in cases:
            with pytest.raises(DatumConfigurationError) as raised:
                KeyFilePdfSigner.from_settings(signing)
            assert not leaks(chain_text(raised.value), forbidden)
            locals_ = source_frame_locals(raised.value)
            assert locals_, "the refusal was raised inside datum_core"
            for local in locals_:
                assert local != p12_bytes, "a frame of the refusal holds the file's bytes"
                assert local != key_bytes, "a frame of the refusal holds the key file's bytes"
                assert not (
                    isinstance(local, str) and local in (P12_PASSWORD, PDF_P12_PASSWORD, WRONG_PASSWORD, KEY_PASSWORD)
                )
                assert not (isinstance(local, bytes | bytearray) and bytes(local) in password_bytes)
                assert not (isinstance(local, bytes | bytearray) and any(p in bytes(local) for p in password_bytes))
                assert not holds_a_key(local), f"a frame of the refusal holds the key: {type(local).__name__}"
    assert not leaks(log_text(caplog), forbidden)


def test_starting_a_datum_over_a_pkcs12_key_writes_no_secret_to_any_log_and_a_failed_start_none_either(
    tmp_path: Path, pki: DocumentPki, forbidden: list[str | bytes], caplog: pytest.LogCaptureFixture
) -> None:
    signing = pdf_signing(tmp_path, pki.signer, friendly_name="datum-pdf")
    config = {"pdf": {"seal": {"enabled": True, "timestamp": False}, "signing": signing.model_dump(mode="python")}}
    with caplog.at_level(logging.DEBUG):
        datum = plain_pdf_datum(config)
        datum.start()
        datum.stop()
        bad = {name: getattr(signing, name) for name in Signing.model_fields}
        bad["pkcs12_password"] = WRONG_PASSWORD
        failing = plain_pdf_datum({"pdf": {"seal": {"enabled": True}, "signing": bad}})
        with pytest.raises(DatumConfigurationError) as raised:
            failing.start()
    assert not leaks(chain_text(raised.value), forbidden)
    assert not leaks(log_text(caplog), forbidden)


# -- the running Datum -------------------------------------------------------------------------------------------------
def test_health_info_and_the_datum_itself_show_no_secret_and_no_pdf_bytes(
    tmp_path: Path, pki: DocumentPki, forbidden: list[str | bytes]
) -> None:
    signing = pdf_signing(tmp_path, pki.signer, friendly_name="datum-pdf")
    config = {"pdf": {"seal": {"enabled": True, "timestamp": False}, "signing": signing.model_dump(mode="python")}}
    with started_pdf(config) as rig:
        rig.render()
        rig.sign()
        bodies = [
            json.dumps(rig.datum.health().to_json()),
            json.dumps(rig.datum.info()),
            repr(rig.datum),
            str(rig.datum.config),
        ]
        for text in bodies:
            assert not leaks(text, forbidden)
            assert b64(PDF_BYTES) not in text
        assert_clean(rig.service, forbidden, "the PDF service")
        assert_clean(rig.datum.health().to_json(), [PDF_BYTES, b64(PDF_BYTES)], "health")


def test_rendering_signing_and_verifying_write_no_secret_and_no_pdf_to_any_log(
    tmp_path: Path, pki: DocumentPki, tsa_pki: TsaPki, forbidden: list[str | bytes], caplog: pytest.LogCaptureFixture
) -> None:
    signing = pdf_signing(tmp_path, pki.signer, friendly_name="datum-pdf")
    config = {"pdf": {"seal": {"enabled": True, "timestamp": True}, "signing": signing.model_dump(mode="python")}}
    with started_pdf(config, tsa=tsa_pki.rsa) as rig, caplog.at_level(logging.DEBUG):
        rig.render()
        rig.sign()
        rig.render_submission()
        rig.runtime.on("verify", lambda _r: verify_reply(signature_report(pki.signer)))
        rig.verify(PDF_BYTES)
        rig.runtime.fail("document", "internal", "the program refused the document")
        with pytest.raises(PdfKernelError):
            rig.render()
    text = log_text(caplog)
    assert not leaks(text, [*forbidden, "PRIVATE KEY"])
    assert PDF_BYTES.decode("latin-1") not in text
    assert b64(PDF_BYTES) not in text


def test_a_timestamp_credential_is_in_no_dump_no_log_no_health_no_info_and_no_event(
    tmp_path: Path, pki: DocumentPki, caplog: pytest.LogCaptureFixture
) -> None:
    signing = pdf_signing(
        tmp_path,
        pki.signer,
        tsa={
            "url": "https://tsa.example.invalid/ts",
            "bearer_token": BEARER,
            "basic_user": "user",
            "basic_password": BASIC_PASSWORD,
        },
    )
    config = {"pdf": {"seal": {"enabled": True, "timestamp": True}, "signing": signing.model_dump(mode="python")}}
    credentials: list[str | bytes] = [BEARER, BASIC_PASSWORD]
    with caplog.at_level(logging.DEBUG):
        datum = plain_pdf_datum(config)
        datum.start()
        try:
            for text in (
                json.dumps(datum.health().to_json()),
                json.dumps(datum.info()),
                repr(datum),
                str(datum.config),
                repr(signing),
                signing.model_dump_json(),
            ):
                assert not leaks(text, credentials)
            assert_clean(datum.pdf_service, credentials, "the PDF service")
        finally:
            datum.stop()
    assert not leaks(log_text(caplog), credentials)


def test_events_carry_scalars_and_no_secret_no_bytes_and_no_certificate(
    tmp_path: Path, pki: DocumentPki, forbidden: list[str | bytes]
) -> None:
    signing = pdf_signing(tmp_path, pki.signer, friendly_name="datum-pdf")
    config = {"pdf": {"seal": {"enabled": True, "timestamp": False}, "signing": signing.model_dump(mode="python")}}
    with started_pdf(config) as rig:
        rig.render()
        rig.runtime.on("verify", lambda _r: verify_reply(signature_report(pki.signer)))
        rig.verify(PDF_BYTES)
        seen: list[DatumEvent] = list(rig.events)
    assert {type(event).__name__ for event in seen} >= {"PdfRenderedEvent", "PdfVerifiedEvent"}
    for event in seen:
        assert_clean(event, [*forbidden, PDF_BYTES, b64(PDF_BYTES), pki.signer.leaf_der], type(event).__name__)
        for name in getattr(type(event), "__slots__", ()):
            assert isinstance(getattr(event, name), str | int | float | bool | type(None)), (type(event).__name__, name)


def test_spans_carry_no_bytes_no_digest_no_key_and_no_certificate(tmp_path: Path, pki: DocumentPki) -> None:
    probe = telemetry()
    signing = pdf_signing(tmp_path, pki.signer, friendly_name="datum-pdf")
    config = {"pdf": {"seal": {"enabled": True, "timestamp": False}, "signing": signing.model_dump(mode="python")}}
    with started_pdf(config) as rig:
        probe.exporter.clear()
        rig.render()
        rig.runtime.on("verify", lambda _r: verify_reply(signature_report(pki.signer)))
        rig.verify(PDF_BYTES)
    spans = [s for s in probe.spans() if s.name in {"datum.pdf", "datum.pdf.run"}]
    assert {s.name for s in spans} == {"datum.pdf", "datum.pdf.run"}
    text = "\n".join(f"{s.name} {dict(s.attributes or {})} {s.status}" for s in spans)
    assert not leaks(text, [P12_PASSWORD, "PRIVATE KEY", b64(PDF_BYTES), PDF_BYTES.hex(), pki.signer.leaf_der.hex()])
    import hashlib  # noqa: PLC0415 - one use

    assert hashlib.sha256(PDF_BYTES).hexdigest() not in text
    assert all(str(key).startswith("datum.") for s in spans for key in (s.attributes or {}))


def test_the_probe_itself_finds_a_leak_so_a_clean_result_means_something() -> None:
    class Leaky:
        def __init__(self) -> None:
            self.token = "hunter2-ZZ"

        @property
        def public(self) -> str:
            return "prefix hunter2-ZZ suffix"

    assert leaks("\n".join(exposed(Leaky())), ["hunter2-ZZ"])
    assert not leaks("\n".join(exposed(object())), ["hunter2-ZZ"])
    assert leaks("\n".join(exposed({"a": [PDF_BYTES]})), [PDF_BYTES])
