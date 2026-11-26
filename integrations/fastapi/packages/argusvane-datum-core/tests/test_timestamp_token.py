"""What `TimestampAuthority.issue` writes, read by independent readers, and `TimestampToken`'s own checks.

Three oracles bind besides the test's own DER reader: the PDF kernel's `parseTimestampToken` through the real PDF
program (marker `runtime`: `complete` refuses a token over another value, `verify` reports `coversSignature` and
`certificateMatches`), `openssl ts -verify` (marker `openssl`, the root alone as the trust anchor) and `rfc3161-client`
(strict DER, test scope). Negative controls are part of the gate: a flipped imprint bit and a wrong root fail openssl; a
token over another value, a look-alike certificate and a swapped carried leaf fail the kernel.
"""

import datetime as dt
import hashlib
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from cryptography.hazmat.primitives import serialization
from tsa_der import (
    OID_ALGORITHM_PROTECTION,
    OID_CONTENT_TYPE,
    OID_ECDSA_SHA256,
    OID_ESS_CERT_ID_V2,
    OID_MESSAGE_DIGEST,
    OID_RSA_SHA256,
    OID_SIGNING_TIME,
    OID_TST_INFO,
    SHA256,
    generalized_time,
    int_of,
    is_der_set_order,
    oid_of,
    parse,
    parse_reply,
    query_der,
    token_parts,
)
from tsa_kernel import KernelSession, kernel_session
from tsa_support import (
    OTHER_POLICY,
    CountingSerials,
    IdentityKey,
    ListLog,
    make_authority,
    openssl_reply_text,
    openssl_verify,
    run_openssl,
    sha256,
)
from tsa_support import refused as hook_refusal

from datum_core.http.timestamp import refusal_answer
from datum_core.testing import requires_openssl
from datum_core.testing.tsa_pki import INSTANT, TsaIdentity, TsaPki, make_leaf
from datum_core.timestamp import (
    TimestampAuthority,
    TimestampQuery,
    TimestampRefusal,
    TimestampRefusedError,
    TimestampToken,
    _der,
)

DATA = b"hello"
DIGEST = sha256(DATA)
POLICY_OID = "1.3.6.1.4.1.99999.1"


def issue(authority: TimestampAuthority, **fields: Any) -> tuple[bytes, bytes, TimestampQuery]:
    """Issue over DATA; return the whole reply, the token and the query that was answered."""
    query = TimestampQuery.parse(query_der(DIGEST, **fields))
    grant = authority.issue(query)
    return grant.response, grant.token, query


def replaced_once(data: bytes, old: bytes, new: bytes) -> bytes:
    assert data.count(old) == 1, "the bytes to change occur exactly once"
    return data.replace(old, new)


@pytest.fixture(params=["ec", "rsa"])
def identity(request: pytest.FixtureRequest, tsa_pki: TsaPki) -> TsaIdentity:
    return tsa_pki.ec if request.param == "ec" else tsa_pki.rsa


# -- the shape of a granted reply --------------------------------------------------------------------------------------
def test_a_granted_reply_is_a_pki_status_0_and_a_signed_data_token(identity: TsaIdentity) -> None:
    response, token, _ = issue(make_authority(identity), nonce=5)
    read = parse_reply(response)
    assert read.status == 0
    assert read.fail_bits == frozenset()
    assert read.token == token
    parts = token_parts(token)
    assert oid_of(parts.content_info.children[0]) == "1.2.840.113549.1.7.2"
    assert int_of(parts.signed_data.children[0]) == 3  # CMS SignedData version for an eContentType other than data
    assert oid_of(parts.signed_data.children[2].children[0]) == OID_TST_INFO


def test_the_tstinfo_names_version_policy_imprint_serial_time_and_the_certificates_subject(
    identity: TsaIdentity,
) -> None:
    authority = make_authority(identity, serials=CountingSerials(41))
    _, token, _ = issue(authority)
    tst = token_parts(token).tst
    assert tst.version == 1
    assert tst.policy == POLICY_OID
    assert tst.algorithm == SHA256
    assert tst.imprint == DIGEST
    assert tst.serial == 41
    assert tst.gen_time == generalized_time(INSTANT)


def test_the_tsa_field_is_the_certificates_subject_as_a_directory_name(identity: TsaIdentity) -> None:
    _, token, _ = issue(make_authority(identity))
    tsa = parse(token_parts(token).tst.tsa_tlv or b"")
    (general_name,) = tsa.children
    assert general_name.tag == 0xA4  # [4] directoryName
    assert general_name.content == identity.leaf.subject.public_bytes()


def test_a_requested_accepted_policy_is_issued_and_no_request_means_the_servers_policy(tsa_pki: TsaPki) -> None:
    authority = make_authority(tsa_pki.ec)
    _, token, _ = issue(authority, policy="1.3.6.1.4.1.99999.2")
    assert token_parts(token).tst.policy == "1.3.6.1.4.1.99999.2"
    _, token, _ = issue(authority)
    assert token_parts(token).tst.policy == POLICY_OID


@pytest.mark.parametrize("algorithm", ["sha256", "sha384", "sha512"])
def test_the_imprint_is_issued_as_sent_for_each_algorithm(tsa_pki: TsaPki, algorithm: str) -> None:
    import hashlib  # noqa: PLC0415

    digest = hashlib.new(algorithm, DATA).digest()
    grant = make_authority(tsa_pki.ec).issue(TimestampQuery.of(digest, algorithm))
    tst = token_parts(grant.token).tst
    assert tst.imprint == digest
    assert (
        tst.algorithm
        == {"sha256": SHA256, "sha384": "2.16.840.1.101.3.4.2.2", "sha512": "2.16.840.1.101.3.4.2.3"}[algorithm]
    )


def test_the_grant_carries_the_serial_and_the_time_it_wrote(tsa_pki: TsaPki) -> None:
    grant = make_authority(tsa_pki.ec, serials=CountingSerials(1000)).issue(TimestampQuery.parse(query_der(DIGEST)))
    assert grant.serial == 1000
    assert grant.gen_time == INSTANT
    assert token_parts(grant.token).tst.serial == 1000


# -- the nonce, the accuracy and genTime -------------------------------------------------------------------------------
def test_the_nonce_is_echoed_by_value_in_its_shortest_form(tsa_pki: TsaPki) -> None:
    """`02 03 00 00 05` is accepted and echoed as `02 01 05`."""
    authority = make_authority(tsa_pki.ec)
    _, token, _ = issue(authority, nonce=b"\x00\x00\x05")
    assert token_parts(token).tst.nonce_tlv == b"\x02\x01\x05"


def test_a_64_byte_nonce_is_echoed_whole_and_no_nonce_is_none(tsa_pki: TsaPki) -> None:
    authority = make_authority(tsa_pki.ec)
    content = b"\x40" + b"\x01" * 63
    _, token, _ = issue(authority, nonce=content)
    assert token_parts(token).tst.nonce_tlv == b"\x02\x40" + content
    _, token, _ = issue(authority)
    assert token_parts(token).tst.nonce_tlv is None


def test_a_nonce_of_zero_is_echoed_as_zero(tsa_pki: TsaPki) -> None:
    _, token, _ = issue(make_authority(tsa_pki.ec), nonce=0)
    assert token_parts(token).tst.nonce_tlv == b"\x02\x01\x00"


@pytest.mark.parametrize(
    ("accuracy", "stated"),
    [
        (1.0, (1, None, None)),
        (60.0, (60, None, None)),
        (0.5, (None, 500, None)),
        (0.25, (None, 250, None)),
        (1.5, (1, 500, None)),
    ],
    ids=["1s", "60s", "500ms", "250ms", "1.5s"],
)
def test_the_stated_accuracy_is_seconds_and_whole_milliseconds(
    tsa_pki: TsaPki, accuracy: float, stated: tuple[int | None, int | None, int | None]
) -> None:
    _, token, _ = issue(make_authority(tsa_pki.ec, accuracy=accuracy))
    assert token_parts(token).tst.accuracy == stated


def test_an_accuracy_of_zero_states_none(tsa_pki: TsaPki) -> None:
    _, token, _ = issue(make_authority(tsa_pki.ec, accuracy=0))
    assert token_parts(token).tst.accuracy is None


@pytest.mark.parametrize("accuracy", [-1, 60.001, 61, 3600])
def test_an_accuracy_outside_0_to_60_seconds_is_refused_at_construction(tsa_pki: TsaPki, accuracy: float) -> None:
    with pytest.raises(ValueError, match="accuracy"):
        make_authority(tsa_pki.ec, accuracy=accuracy)


def test_gentime_has_milliseconds_only_when_the_accuracy_is_under_a_second(tsa_pki: TsaPki) -> None:
    moment = INSTANT + dt.timedelta(milliseconds=250)
    sub_second = make_authority(tsa_pki.ec, accuracy=0.5, now=lambda: moment)
    whole = make_authority(tsa_pki.ec, accuracy=1.0, now=lambda: moment)
    none = make_authority(tsa_pki.ec, accuracy=0, now=lambda: moment)
    assert token_parts(issue(sub_second)[1]).tst.gen_time == generalized_time(INSTANT)[:-1] + ".25Z"
    assert token_parts(issue(whole)[1]).tst.gen_time == generalized_time(INSTANT)
    assert token_parts(issue(none)[1]).tst.gen_time == generalized_time(INSTANT)


# -- certificates ------------------------------------------------------------------------------------------------------
def test_the_chain_is_carried_leaf_first_only_when_the_request_asks(identity: TsaIdentity) -> None:
    authority = make_authority(identity)
    _, with_chain, _ = issue(authority, cert_req=True)
    _, without, _ = issue(authority, cert_req=False)
    assert token_parts(with_chain).certificates in (identity.chain_der, tuple(sorted(identity.chain_der)))
    assert token_parts(without).certificates == ()


def test_a_carried_certificate_stays_byte_for_byte_a_ber_one_included(tsa_pki: TsaPki) -> None:
    chain = (tsa_pki.ber_leaf, tsa_pki.rsa.root_der)
    authority = make_authority(tsa_pki.rsa, key=IdentityKey(tsa_pki.rsa, chain=chain))
    _, token, _ = issue(authority)
    carried = token_parts(token).certificates
    assert tsa_pki.ber_leaf in carried
    assert tsa_pki.rsa.root_der in carried


def test_the_certificate_set_is_in_der_set_order(identity: TsaIdentity) -> None:
    _, token, _ = issue(make_authority(identity))
    assert is_der_set_order(token_parts(token).certificates)


# -- signed attributes and the signer ----------------------------------------------------------------------------------
def test_the_signed_attributes_hold_the_four_required_ones_in_der_set_order(identity: TsaIdentity) -> None:
    _, token, _ = issue(make_authority(identity))
    parts = token_parts(token)
    oids = [oid_of(a.children[0]) for a in parts.signed_attributes.children]
    assert {OID_CONTENT_TYPE, OID_SIGNING_TIME, OID_MESSAGE_DIGEST, OID_ESS_CERT_ID_V2} <= set(oids)
    assert len(oids) == len(set(oids))
    assert set(oids) - {OID_CONTENT_TYPE, OID_SIGNING_TIME, OID_MESSAGE_DIGEST, OID_ESS_CERT_ID_V2} <= {
        OID_ALGORITHM_PROTECTION
    }
    assert is_der_set_order([a.raw for a in parts.signed_attributes.children])
    assert parts.signed_attributes.tag == 0xA0  # [0] IMPLICIT SET OF


def test_the_content_type_time_and_message_digest_attributes_say_what_they_must(identity: TsaIdentity) -> None:
    _, token, _ = issue(make_authority(identity))
    parts = token_parts(token)
    by_oid = {oid_of(a.children[0]): a.children[1] for a in parts.signed_attributes.children}
    assert oid_of(by_oid[OID_CONTENT_TYPE].children[0]) == OID_TST_INFO
    assert by_oid[OID_MESSAGE_DIGEST].children[0].content == sha256(parts.tst_der)
    signing_time = by_oid[OID_SIGNING_TIME].children[0]
    assert signing_time.tag == 0x17  # UTCTime
    assert signing_time.content.decode() == INSTANT.strftime("%y%m%d%H%M%SZ")


def test_the_ess_cert_id_v2_names_the_signer_and_omits_its_default_hash_algorithm(identity: TsaIdentity) -> None:
    _, token, _ = issue(make_authority(identity))
    ess = token_parts(token).ess
    first = ess.children[0]
    assert first.tag == 0x04, "hashAlgorithm is DEFAULT sha256 and DER omits a default"
    assert first.content == sha256(identity.leaf_der)
    issuer_serial = ess.children[1]
    names = issuer_serial.children[0]
    assert names.children[0].tag == 0xA4
    assert names.children[0].content == identity.leaf.issuer.public_bytes()
    assert int_of(issuer_serial.children[1]) == identity.leaf.serial_number


def test_the_signer_info_names_the_leaf_by_issuer_and_serial_and_signs_with_sha256(identity: TsaIdentity) -> None:
    _, token, _ = issue(make_authority(identity))
    parts = token_parts(token)
    signer = parts.signer
    assert int_of(signer.children[0]) == 1
    assert signer.children[1].tag == 0x30  # IssuerAndSerialNumber, not a [0] subject key identifier
    assert signer.children[1].children[0].raw == identity.leaf.issuer.public_bytes()
    assert int_of(signer.children[1].children[1]) == identity.leaf.serial_number
    assert oid_of(signer.children[2].children[0]) == SHA256
    algorithm = signer.children[-2]
    expected = OID_ECDSA_SHA256 if identity.algorithm == "ecdsa-sha256" else OID_RSA_SHA256
    assert oid_of(algorithm.children[0]) == expected
    if identity.algorithm == "ecdsa-sha256":
        assert len(algorithm.children) == 1  # RFC 5758: the parameters are absent
    else:
        assert algorithm.children[1].tag == 0x05  # RFC 8017: NULL


# -- TimestampToken ----------------------------------------------------------------------------------------------------
def test_a_token_parses_and_reports_what_it_holds(identity: TsaIdentity) -> None:
    _, token, _ = issue(make_authority(identity, serials=CountingSerials(7)), nonce=99)
    parsed = TimestampToken.parse(token)
    assert parsed.serial == 7
    assert parsed.policy == POLICY_OID
    assert parsed.imprint_algorithm == "sha256"
    assert parsed.imprint == DIGEST
    assert parsed.nonce == 99
    assert parsed.gen_time == INSTANT
    assert parsed.accuracy == 1.0
    assert parsed.certificates == identity.chain_der or set(parsed.certificates) == set(identity.chain_der)


@pytest.mark.parametrize("garbage", [b"", b"nope", b"\x30\x00", b"\x30\x03\x02\x01\x01"])
def test_a_token_that_is_not_a_token_does_not_parse(garbage: bytes) -> None:
    with pytest.raises(ValueError):  # noqa: PT011 - any message: the type is the contract
        TimestampToken.parse(garbage)


def test_a_good_token_has_no_problems(identity: TsaIdentity) -> None:
    _, token, _ = issue(make_authority(identity))
    parsed = TimestampToken.parse(token)
    assert parsed.check() == ()
    assert parsed.verify_over(DATA) == ()


def test_verify_over_another_value_reports_the_imprint(identity: TsaIdentity) -> None:
    _, token, _ = issue(make_authority(identity))
    assert TimestampToken.parse(token).verify_over(b"another value") == ("imprint",)


def test_a_token_whose_imprint_bit_is_flipped_fails_its_check(tsa_pki: TsaPki) -> None:
    response, _, _ = issue(make_authority(tsa_pki.rsa))
    flipped = bytes([DIGEST[0] ^ 0x01]) + DIGEST[1:]
    broken = replaced_once(response, DIGEST, flipped)
    token = parse_reply(broken).token
    assert token is not None
    assert TimestampToken.parse(token).check() == ("signature",)


def test_a_signature_with_a_flipped_bit_fails_its_check(tsa_pki: TsaPki) -> None:
    _, token, _ = issue(make_authority(tsa_pki.rsa))
    signature = token_parts(token).signature
    flipped = signature[:-1] + bytes([signature[-1] ^ 0x01])
    assert TimestampToken.parse(replaced_once(token, signature, flipped)).check() == ("signature",)


def test_a_token_outside_its_certificates_validity_reports_the_time(tsa_pki: TsaPki) -> None:
    before = make_authority(tsa_pki.ec, now=lambda: dt.datetime(2025, 6, 1, tzinfo=dt.UTC))
    after = make_authority(tsa_pki.ec, now=lambda: dt.datetime(2040, 6, 1, tzinfo=dt.UTC))
    for authority in (before, after):
        _, token, _ = issue(authority)
        assert TimestampToken.parse(token).verify_over(DATA) == ("time",)


def test_a_token_without_certificates_is_checked_against_the_known_ones(tsa_pki: TsaPki) -> None:
    _, token, _ = issue(make_authority(tsa_pki.ec), cert_req=False)
    parsed = TimestampToken.parse(token)
    assert parsed.verify_over(DATA, known_certificates=[tsa_pki.ec.leaf_der]) == ()
    assert parsed.check() != ()  # no certificate to check the signature against


def test_a_look_alike_certificate_reports_the_binding_and_nothing_else(tsa_pki: TsaPki) -> None:
    _, token, _ = issue(make_authority(tsa_pki.rsa), cert_req=False)
    alike = tsa_pki.look_alike(tsa_pki.rsa)
    assert alike != tsa_pki.rsa.leaf_der
    assert TimestampToken.parse(token).verify_over(DATA, known_certificates=[alike]) == ("binding",)


def test_the_signer_is_found_by_issuer_and_serial_never_by_the_serial_alone(tsa_pki: TsaPki) -> None:
    """A certificate with the leaf's key and serial under ANOTHER issuer is not the signer.

    A lookup by serial alone would take the impostor (listed first), see the signature verify (same key) and report
    only the binding; the signer is named by issuer and serial together, so the impostor is no signer at all.
    """
    leaf = tsa_pki.ec.leaf
    impostor = make_leaf(
        "Test EC TSA", tsa_pki.ec.key, tsa_pki.rsa.root, tsa_pki.rsa.root_key, serial=leaf.serial_number
    ).public_bytes(serialization.Encoding.DER)
    assert impostor != tsa_pki.ec.leaf_der
    _, token, _ = issue(make_authority(tsa_pki.ec), cert_req=False)
    parsed = TimestampToken.parse(token)
    assert parsed.verify_over(DATA, known_certificates=[impostor]) == ("signature",)
    assert parsed.check(known_certificates=[impostor, tsa_pki.ec.leaf_der]) == ()
    assert parsed.verify_over(DATA, known_certificates=[impostor, tsa_pki.ec.leaf_der]) == ()


def test_a_swapped_carried_leaf_reports_the_binding(tsa_pki: TsaPki) -> None:
    _, token, _ = issue(make_authority(tsa_pki.rsa))
    alike = tsa_pki.look_alike(tsa_pki.rsa)
    assert len(alike) == len(tsa_pki.rsa.leaf_der)
    swapped = replaced_once(token, tsa_pki.rsa.leaf_der, alike)
    assert TimestampToken.parse(swapped).verify_over(DATA) == ("binding",)


def test_a_key_that_signs_under_another_certificate_yields_no_token(tsa_pki: TsaPki) -> None:
    """The reply is read back before it leaves: a key whose certificate is not its own is a system failure."""

    class WrongSigner(IdentityKey):
        def sign(self, data: bytes) -> bytes:
            return tsa_pki.ec.sign(data)  # an ECDSA signature under an RSA certificate

    wrong = make_authority(tsa_pki.rsa, key=WrongSigner(tsa_pki.rsa))
    with pytest.raises(TimestampRefusedError) as raised:
        wrong.issue(TimestampQuery.parse(query_der(DIGEST)))
    assert raised.value.failure == "systemFailure"


@pytest.mark.parametrize("part", ["tstinfo", "signature", "certificates"])
def test_the_read_back_refuses_a_reply_the_builder_got_wrong_and_no_row_is_logged(
    tsa_pki: TsaPki, monkeypatch: pytest.MonkeyPatch, part: str
) -> None:
    """A reply corrupted between signing and leaving is never answered: `systemFailure`, serial burnt, no log row."""
    real = _der.granted_reply

    def corrupted(
        fixed: Any, *, tst_der: bytes, attributes: bytes, signature: bytes, cert_req: bool
    ) -> tuple[bytes, bytes]:
        if part == "tstinfo":
            tst_der = tst_der[:-1] + bytes([tst_der[-1] ^ 0x01])
        elif part == "signature":
            signature = signature[:-1] + bytes([signature[-1] ^ 0x01])
        else:
            cert_req = not cert_req
        return real(fixed, tst_der=tst_der, attributes=attributes, signature=signature, cert_req=cert_req)

    monkeypatch.setattr(_der, "granted_reply", corrupted)
    serials = CountingSerials()
    log = ListLog()
    authority = make_authority(tsa_pki.rsa, serials=serials, log=log)
    with pytest.raises(TimestampRefusedError) as raised:
        authority.issue(TimestampQuery.parse(query_der(DIGEST)))
    assert raised.value.failure == "systemFailure"
    assert isinstance(raised.value.__cause__, ValueError)
    assert serials.allocations == 1
    assert log.entries == []


# -- openssl ts -verify ------------------------------------------------------------------------------------------------
@requires_openssl
def test_openssl_verifies_the_reply_against_the_query_and_against_the_data(
    tmp_path: Path, identity: TsaIdentity
) -> None:
    request = query_der(DIGEST, nonce=0x1234567890ABCDEF, cert_req=True)
    grant = make_authority(identity).issue(TimestampQuery.parse(request))
    by_query = openssl_verify(tmp_path, grant.response, root_pem=identity.root_pem, query=request)
    assert by_query.returncode == 0, by_query.stderr
    assert b"Verification: OK" in by_query.stdout + by_query.stderr
    by_data = openssl_verify(tmp_path, grant.response, root_pem=identity.root_pem, data=DATA)
    assert by_data.returncode == 0, by_data.stderr


@requires_openssl
def test_openssl_verifies_a_bare_token_and_a_token_without_certificates_given_the_leaf(
    tmp_path: Path, identity: TsaIdentity
) -> None:
    authority = make_authority(identity)
    _, token, _ = issue(authority)
    bare = openssl_verify(tmp_path, token, root_pem=identity.root_pem, data=DATA, token_in=True)
    assert bare.returncode == 0, bare.stderr
    _, no_chain, _ = issue(authority, cert_req=False)
    refused = openssl_verify(tmp_path, no_chain, root_pem=identity.root_pem, data=DATA, token_in=True)
    assert refused.returncode != 0
    given = openssl_verify(
        tmp_path, no_chain, root_pem=identity.root_pem, data=DATA, token_in=True, untrusted_pem=identity.leaf_pem
    )
    assert given.returncode == 0, given.stderr


@requires_openssl
def test_openssl_verifies_a_token_whose_carried_leaf_is_ber(tmp_path: Path, tsa_pki: TsaPki) -> None:
    authority = make_authority(
        tsa_pki.rsa, key=IdentityKey(tsa_pki.rsa, chain=(tsa_pki.ber_leaf, tsa_pki.rsa.root_der))
    )
    grant = authority.issue(TimestampQuery.parse(query_der(DIGEST)))
    done = openssl_verify(tmp_path, grant.response, root_pem=tsa_pki.rsa.root_pem, data=DATA)
    assert done.returncode == 0, done.stderr


@requires_openssl
def test_openssl_refuses_the_reply_when_the_data_differs_by_one_bit(tmp_path: Path, tsa_pki: TsaPki) -> None:
    grant = make_authority(tsa_pki.ec).issue(TimestampQuery.parse(query_der(DIGEST)))
    flipped = bytes([DATA[0] ^ 0x01]) + DATA[1:]
    done = openssl_verify(tmp_path, grant.response, root_pem=tsa_pki.ec.root_pem, data=flipped)
    assert done.returncode != 0


@requires_openssl
def test_openssl_refuses_a_reply_whose_imprint_bit_was_flipped(tmp_path: Path, tsa_pki: TsaPki) -> None:
    grant = make_authority(tsa_pki.ec).issue(TimestampQuery.parse(query_der(DIGEST)))
    broken = replaced_once(grant.response, DIGEST, bytes([DIGEST[0] ^ 0x01]) + DIGEST[1:])
    done = openssl_verify(tmp_path, broken, root_pem=tsa_pki.ec.root_pem, data=DATA)
    assert done.returncode != 0


@requires_openssl
def test_openssl_refuses_the_reply_under_the_wrong_root(tmp_path: Path, tsa_pki: TsaPki) -> None:
    grant = make_authority(tsa_pki.ec).issue(TimestampQuery.parse(query_der(DIGEST)))
    done = openssl_verify(tmp_path, grant.response, root_pem=tsa_pki.rsa.root_pem, data=DATA)
    assert done.returncode != 0


# -- rfc3161-client (strict DER, test scope) ---------------------------------------------------------------------------
def rfc3161_verify(response: bytes, identity: TsaIdentity, nonce: int | None) -> bool:
    from cryptography import x509  # noqa: PLC0415
    from rfc3161_client import VerifierBuilder, decode_timestamp_response  # noqa: PLC0415

    decoded = decode_timestamp_response(response)
    builder = VerifierBuilder().add_root_certificate(x509.load_der_x509_certificate(identity.root_der))
    if nonce is not None:
        builder = builder.nonce(nonce)
    builder = builder.tsa_certificate(x509.load_der_x509_certificate(identity.leaf_der))
    return bool(builder.build().verify_message(decoded, DATA))


def test_rfc3161_client_cross_parses_and_verifies_a_granted_reply(identity: TsaIdentity) -> None:
    request = query_der(DIGEST, nonce=0x77, cert_req=True)
    grant = make_authority(identity).issue(TimestampQuery.parse(request))
    assert rfc3161_verify(grant.response, identity, 0x77) is True


def test_rfc3161_client_reads_the_policy_and_time_it_was_given(identity: TsaIdentity) -> None:
    from rfc3161_client import decode_timestamp_response  # noqa: PLC0415

    grant = make_authority(identity).issue(TimestampQuery.parse(query_der(DIGEST)))
    decoded = decode_timestamp_response(grant.response)
    assert decoded.tst_info.policy.dotted_string == POLICY_OID
    assert decoded.tst_info.gen_time == INSTANT


def test_rfc3161_client_refuses_a_ber_certificate_as_expected_and_the_token_is_still_ours(tsa_pki: TsaPki) -> None:
    from rfc3161_client import decode_timestamp_response  # noqa: PLC0415

    authority = make_authority(
        tsa_pki.rsa, key=IdentityKey(tsa_pki.rsa, chain=(tsa_pki.ber_leaf, tsa_pki.rsa.root_der))
    )
    grant = authority.issue(TimestampQuery.parse(query_der(DIGEST)))
    with pytest.raises(Exception, match=r"(?i)critical|invalid|value|certificate"):
        decode_timestamp_response(grant.response)
    assert tsa_pki.ber_leaf in token_parts(grant.token).certificates


def test_rfc3161_client_reads_the_status_of_a_rejection_but_has_no_failure_info(tsa_pki: TsaPki) -> None:
    from rfc3161_client import decode_timestamp_response  # noqa: PLC0415

    answer = make_authority(tsa_pki.ec).answer(query_der(b"\x01" * 20, algorithm_oid="1.3.14.3.2.26"))
    decoded = decode_timestamp_response(answer.response)
    assert int(decoded.status) == 2
    assert not hasattr(decoded, "fail_info")


# -- the PDF kernel's parseTimestampToken ------------------------------------------------------------------------------
@pytest.fixture(scope="module")
def kernel(tsa_pki: TsaPki) -> Iterator[KernelSession]:
    with kernel_session(tsa_pki) as session:
        yield session


@pytest.mark.runtime
@pytest.mark.parametrize(
    ("failure", "status"),
    [
        ("badAlg", 400),
        ("badDataFormat", 400),
        ("unacceptedPolicy", 400),
        ("timeNotAvailable", 503),
        ("systemFailure", 503),
    ],
)
def test_the_kernel_reads_every_rejection_reply_as_a_refusal(kernel: KernelSession, failure: str, status: int) -> None:
    answer = refusal_answer(TimestampRefusal.of(hook_refusal(failure)), retry_after=5)
    assert answer.status == status
    out = kernel.complete(kernel.prepare(), answer.body)
    assert out["ok"] is False
    assert out["error"]["code"] == "signature"
    assert "PKIStatus 2" in out["error"]["message"]


@pytest.mark.runtime
@pytest.mark.parametrize("whole", [True, False], ids=["whole-reply", "bare-token"])
def test_the_kernel_accepts_every_issued_token_and_reports_it_covers_the_signature(
    kernel: KernelSession, identity: TsaIdentity, whole: bool
) -> None:
    signing = kernel.prepare()
    grant = make_authority(identity).issue(TimestampQuery.parse(signing.request))
    completed = kernel.complete(signing, grant.response if whole else grant.token)
    assert completed["ok"], completed
    assert completed.get("timestamped") is True
    report = kernel.verify(completed)
    assert report["coversSignature"] is True
    assert report["certificateMatches"] is True
    assert report["messageDigestMatches"] is True


@pytest.mark.runtime
def test_the_kernel_finds_the_signer_among_known_certificates_when_the_token_carries_none(
    kernel: KernelSession, tsa_pki: TsaPki
) -> None:
    signing = kernel.prepare()
    parsed = TimestampQuery.parse(signing.request)
    query = TimestampQuery.of(parsed.imprint, parsed.imprint_algorithm, cert_req=False)
    grant = make_authority(tsa_pki.ec).issue(query)
    completed = kernel.complete(signing, grant.response)
    assert completed["ok"], completed
    real = kernel.verify(completed, known=[tsa_pki.ec.leaf_der])
    assert real["coversSignature"] is True
    assert real["certificateMatches"] is True
    alike = kernel.verify(completed, known=[tsa_pki.look_alike(tsa_pki.ec)])
    assert alike["certificateMatches"] is False


@pytest.mark.runtime
def test_the_kernel_refuses_a_token_over_another_value(kernel: KernelSession, tsa_pki: TsaPki) -> None:
    signing = kernel.prepare()
    other = TimestampQuery.of(sha256(b"another value"), "sha256")
    grant = make_authority(tsa_pki.ec).issue(other)
    completed = kernel.complete(signing, grant.response)
    assert completed["ok"] is False, completed


@pytest.mark.runtime
def test_the_kernel_reports_no_match_when_the_carried_leaf_is_swapped_for_a_look_alike(
    kernel: KernelSession, tsa_pki: TsaPki
) -> None:
    signing = kernel.prepare()
    grant = make_authority(tsa_pki.rsa).issue(TimestampQuery.parse(signing.request))
    alike = tsa_pki.look_alike(tsa_pki.rsa)
    swapped = replaced_once(grant.response, tsa_pki.rsa.leaf_der, alike)
    completed = kernel.complete(signing, swapped)
    assert completed["ok"], completed
    report = kernel.verify(completed)
    assert report["coversSignature"] is True
    assert report["certificateMatches"] is False


@pytest.mark.runtime
def test_the_kernel_reads_the_token_we_issued_byte_for_byte(kernel: KernelSession, tsa_pki: TsaPki) -> None:
    import base64  # noqa: PLC0415

    signing = kernel.prepare()
    grant = make_authority(tsa_pki.rsa).issue(TimestampQuery.parse(signing.request))
    completed = kernel.complete(signing, grant.response)
    report = kernel.verify(completed)
    assert base64.b64decode(report["token"]) == grant.token


# -- the imprint is echoed as sent -------------------------------------------------------------------------------------
@pytest.mark.parametrize("parameters", [b"\x05\x00", None], ids=["null-parameters", "absent-parameters"])
def test_the_imprint_algorithm_parameters_are_echoed_as_sent(tsa_pki: TsaPki, parameters: bytes | None) -> None:
    _, token, _ = issue(make_authority(tsa_pki.ec), parameters=parameters)
    algorithm = parse(token_parts(token).tst_der).children[2].children[0]
    assert [child.raw for child in algorithm.children[1:]] == ([] if parameters is None else [parameters])


# -- the read-back, field by field -------------------------------------------------------------------------------------
def altered_tst_info(change: str, tsa_pki: TsaPki) -> Any:
    """A replacement for `_der.tst_info` that writes one field wrong, the way a builder bug would."""
    real = _der.tst_info

    def wrong(**fields: Any) -> bytes:
        if change == "serial":
            fields["serial"] += 1
        elif change == "policy":
            fields["policy"] = _der.oid("1.2.3.4")
        elif change == "nonce":
            fields["nonce"] += 1
        elif change == "no-nonce":
            fields["nonce"] = None
        elif change == "gen-time":
            fields["gen_time"] += dt.timedelta(seconds=1)
        elif change == "imprint-bit":
            imprint = fields["imprint"]
            fields["imprint"] = imprint[:-1] + bytes([imprint[-1] ^ 0x01])
        elif change == "imprint-parameters":
            fields["imprint"] = _der.message_imprint(_der.OID_SHA256, DIGEST, null_parameters=False)
        elif change == "accuracy":
            fields["accuracy_millis"] += 1
        elif change == "no-accuracy":
            fields["accuracy_millis"] = 0
        elif change == "accuracy-micros":
            node = parse(real(**fields))
            stated = node.children[5]  # version, policy, imprint, serial, genTime, then the Accuracy SEQUENCE
            assert stated.tag == 0x30
            widened = _der.tlv(0x30, b"".join(child.raw for child in stated.children) + _der.tlv(0x81, b"\x01"))
            return _der.tlv(
                0x30, b"".join(widened if index == 5 else child.raw for index, child in enumerate(node.children))
            )
        else:
            fields["tsa"] = _der.tlv(0xA0, _der.tlv(0xA4, _der.read_certificate(tsa_pki.ec.root_der).subject))
        return real(**fields)

    return wrong


READ_BACK_ROWS = {
    "serial": "serial",
    "policy": "policy",
    "nonce": "nonce",
    "no-nonce": "nonce",
    "gen-time": "genTime",
    "imprint-bit": "imprint",
    "imprint-parameters": "imprint",
    "tsa-name": "TSA name",
    "message-digest": "messageDigest",
    "accuracy": "accuracy",
    "no-accuracy": "accuracy",
    "accuracy-micros": "accuracy",
    "signing-time": "signingTime",
    "no-signing-time": "signingTime",
}
"""The read-back checks `accuracy`, `no-accuracy` and `signing-time`."""


@pytest.mark.parametrize("change", sorted(READ_BACK_ROWS))
def test_the_read_back_names_each_field_a_builder_bug_would_get_wrong(
    tsa_pki: TsaPki, monkeypatch: pytest.MonkeyPatch, change: str
) -> None:
    if change == "no-signing-time":
        real_set = _der.signed_attributes

        def without_signing_time(fixed: Any, *, tst_der: bytes, signing_time: dt.datetime) -> bytes:
            node = parse(real_set(fixed, tst_der=tst_der, signing_time=signing_time))
            marker = _der.oid(OID_SIGNING_TIME)
            kept = [c.raw for c in node.children if c.children[0].raw != marker]
            return _der.tlv(0x31, b"".join(kept))

        monkeypatch.setattr(_der, "signed_attributes", without_signing_time)
    elif change in {"message-digest", "signing-time"}:
        real_attributes = _der.signed_attributes
        later = dt.timedelta(seconds=1 if change == "signing-time" else 0)
        extra = b"x" if change == "message-digest" else b""

        def over_other_bytes(fixed: Any, *, tst_der: bytes, signing_time: dt.datetime) -> bytes:
            return real_attributes(fixed, tst_der=tst_der + extra, signing_time=signing_time + later)

        monkeypatch.setattr(_der, "signed_attributes", over_other_bytes)
    else:
        monkeypatch.setattr(_der, "tst_info", altered_tst_info(change, tsa_pki))
    serials = CountingSerials()
    log = ListLog()
    authority = make_authority(tsa_pki.ec, serials=serials, log=log)
    with pytest.raises(TimestampRefusedError) as raised:
        authority.issue(TimestampQuery.parse(query_der(DIGEST, nonce=5)))
    assert raised.value.failure == "systemFailure"
    assert isinstance(raised.value.__cause__, ValueError)
    assert READ_BACK_ROWS[change] in str(raised.value.__cause__)
    assert serials.allocations == 1
    assert log.entries == []


# -- the same shapes through the other readers -------------------------------------------------------------------------
HALF_SECOND = INSTANT + dt.timedelta(milliseconds=250)
OVER_64 = b"\x40" + b"\x01" * 63
"""A 64-octet nonce with its top bit clear."""


def ber_leaf_authority(tsa_pki: TsaPki) -> TimestampAuthority:
    return make_authority(tsa_pki.rsa, key=IdentityKey(tsa_pki.rsa, chain=(tsa_pki.ber_leaf, tsa_pki.rsa.root_der)))


@pytest.mark.runtime
def test_the_kernel_accepts_a_token_whose_carried_leaf_is_ber(kernel: KernelSession, tsa_pki: TsaPki) -> None:
    signing = kernel.prepare()
    grant = ber_leaf_authority(tsa_pki).issue(TimestampQuery.parse(signing.request))
    completed = kernel.complete(signing, grant.response)
    assert completed["ok"], completed
    report = kernel.verify(completed)
    assert report["coversSignature"] is True
    assert report["certificateMatches"] is True


@pytest.mark.runtime
def test_the_kernel_accepts_a_500_ms_accuracy_token_with_a_fractional_gen_time(
    kernel: KernelSession, tsa_pki: TsaPki
) -> None:
    signing = kernel.prepare()
    authority = make_authority(tsa_pki.ec, accuracy=0.5, now=lambda: HALF_SECOND)
    grant = authority.issue(TimestampQuery.parse(signing.request))
    completed = kernel.complete(signing, grant.response)
    assert completed["ok"], completed
    report = kernel.verify(completed)
    assert report["coversSignature"] is True
    assert report["certificateMatches"] is True


@pytest.mark.runtime
def test_the_kernel_accepts_a_non_minimal_nonce_and_a_second_policy(kernel: KernelSession, tsa_pki: TsaPki) -> None:
    signing = kernel.prepare()
    request = query_der(sha256(signing.value), nonce=b"\x00\x00\x05", policy=OTHER_POLICY)
    grant = make_authority(tsa_pki.rsa).issue(TimestampQuery.parse(request))
    completed = kernel.complete(signing, grant.response)
    assert completed["ok"], completed
    report = kernel.verify(completed)
    assert report["coversSignature"] is True
    assert report["certificateMatches"] is True


@pytest.mark.runtime
def test_the_kernel_accepts_a_token_with_no_certificates_a_64_octet_nonce_and_250_ms(
    kernel: KernelSession, tsa_pki: TsaPki
) -> None:
    signing = kernel.prepare()
    request = query_der(sha256(signing.value), nonce=OVER_64, cert_req=False)
    grant = make_authority(tsa_pki.ec, accuracy=0.25, now=lambda: HALF_SECOND).issue(TimestampQuery.parse(request))
    completed = kernel.complete(signing, grant.response)
    assert completed["ok"], completed
    report = kernel.verify(completed, known=[tsa_pki.ec.leaf_der])
    assert report["coversSignature"] is True
    assert report["certificateMatches"] is True


@requires_openssl
def test_openssl_verifies_a_500_ms_token_and_prints_its_accuracy(tmp_path: Path, tsa_pki: TsaPki) -> None:
    request = query_der(DIGEST, nonce=9)
    authority = make_authority(tsa_pki.ec, accuracy=0.5, now=lambda: HALF_SECOND)
    grant = authority.issue(TimestampQuery.parse(request))
    root = tsa_pki.ec.root_pem
    assert openssl_verify(tmp_path, grant.response, root_pem=root, query=request).returncode == 0
    assert openssl_verify(tmp_path, grant.response, root_pem=root, data=DATA).returncode == 0
    assert openssl_verify(tmp_path, grant.token, root_pem=root, data=DATA, token_in=True).returncode == 0
    text = openssl_reply_text(tmp_path, grant.response)
    assert ".25" in text
    assert "0x01F4 millis" in text


@requires_openssl
def test_openssl_verifies_a_non_minimal_nonce_reply_by_data_and_token_but_not_against_the_query(
    tmp_path: Path, tsa_pki: TsaPki
) -> None:
    """Parity with the other reader: openssl cannot parse `02 03 00 00 05` in the query it is asked to compare with."""
    request = query_der(DIGEST, nonce=b"\x00\x00\x05")
    grant = make_authority(tsa_pki.ec).issue(TimestampQuery.parse(request))
    root = tsa_pki.ec.root_pem
    assert openssl_verify(tmp_path, grant.response, root_pem=root, data=DATA).returncode == 0
    assert openssl_verify(tmp_path, grant.token, root_pem=root, data=DATA, token_in=True).returncode == 0
    assert openssl_verify(tmp_path, grant.response, root_pem=root, query=request).returncode != 0


@requires_openssl
def test_a_request_openssl_built_with_sha512_a_policy_and_certificates_is_answered_and_verifies(
    tmp_path: Path, tsa_pki: TsaPki
) -> None:
    data = tmp_path / "data.bin"
    data.write_bytes(DATA)
    queryfile = tmp_path / "built.tsq"
    built = run_openssl(
        "ts", "-query", "-data", str(data), "-sha512", "-cert", "-tspolicy", OTHER_POLICY, "-out", str(queryfile)
    )
    assert built.returncode == 0, built.stderr
    answer = make_authority(tsa_pki.ec).answer(queryfile.read_bytes())
    assert answer.grant is not None
    root = tsa_pki.ec.root_pem
    assert openssl_verify(tmp_path, answer.response, root_pem=root, query=queryfile.read_bytes()).returncode == 0
    assert openssl_verify(tmp_path, answer.response, root_pem=root, data=DATA).returncode == 0


def test_rfc3161_client_verifies_a_500_ms_token(tsa_pki: TsaPki) -> None:
    request = query_der(DIGEST, nonce=9)
    grant = make_authority(tsa_pki.ec, accuracy=0.5, now=lambda: HALF_SECOND).issue(TimestampQuery.parse(request))
    assert rfc3161_verify(grant.response, tsa_pki.ec, 9) is True


def test_rfc3161_client_verifies_a_non_minimal_nonce_reply_by_its_value(tsa_pki: TsaPki) -> None:
    grant = make_authority(tsa_pki.rsa).issue(TimestampQuery.parse(query_der(DIGEST, nonce=b"\x00\x00\x05")))
    assert rfc3161_verify(grant.response, tsa_pki.rsa, 5) is True


def test_rfc3161_client_verifies_a_64_octet_nonce_reply_without_certificates_given_the_leaf(tsa_pki: TsaPki) -> None:
    request = query_der(DIGEST, nonce=OVER_64, cert_req=False)
    grant = make_authority(tsa_pki.ec, accuracy=0.25, now=lambda: HALF_SECOND).issue(TimestampQuery.parse(request))
    assert token_parts(grant.token).certificates == ()
    assert rfc3161_verify(grant.response, tsa_pki.ec, int.from_bytes(OVER_64, "big")) is True


def test_a_request_rfc3161_client_built_with_a_nonce_is_answered_and_verified_with_it(tsa_pki: TsaPki) -> None:
    from rfc3161_client import TimestampRequestBuilder  # noqa: PLC0415

    built = TimestampRequestBuilder().data(DATA).nonce(nonce=True).build()
    assert built.nonce is not None
    grant = make_authority(tsa_pki.ec).issue(TimestampQuery.parse(built.as_bytes()))
    assert rfc3161_verify(grant.response, tsa_pki.ec, built.nonce) is True


# -- genTime's fraction under sub-second accuracy ----------------------------------------------------------------------
def test_gentime_at_a_whole_second_under_sub_second_accuracy_writes_no_fraction_and_100_ms_writes_point_1(
    tsa_pki: TsaPki,
) -> None:
    """DER drops trailing zeros and a bare point (X.690 11.7.3): never `.0Z`, `.000Z` or `.100Z`.

    Red against the mutant that writes the three digits as they are (`.000Z`, `.100Z`) or `.0Z` for a whole second.
    """
    whole = make_authority(tsa_pki.ec, accuracy=0.5, now=lambda: INSTANT)
    tenth = make_authority(tsa_pki.ec, accuracy=0.5, now=lambda: INSTANT + dt.timedelta(milliseconds=100))
    assert token_parts(issue(whole)[1]).tst.gen_time == generalized_time(INSTANT)
    assert token_parts(issue(tenth)[1]).tst.gen_time == generalized_time(INSTANT)[:-1] + ".1Z"
    assert _der.generalized_time(INSTANT, millis=True)[2:] == generalized_time(INSTANT).encode()


# -- the readers keep no asn1crypto exception, and write no negative INTEGER -------------------------------------------
NOT_IT = b"\x30\x03\x02\x01\x01"
"""A well-formed DER SEQUENCE that is none of the structures: asn1crypto itself raises on it."""

READERS = {
    "token": _der.read_token,
    "reply": _der.read_reply,
    "certificate": _der.read_certificate,
    "request": _der.read_request,
}


@pytest.mark.parametrize("reader", sorted(READERS))
def test_a_reader_refusal_carries_no_asn1crypto_exception_in_its_context(reader: str) -> None:
    """The refusal is raised after the except block. Red against `raise ... from None` inside it, which suppresses
    the display but keeps asn1crypto's exception (whose words can quote structure) in `__context__`."""
    with pytest.raises(ValueError, match=r"^not a ") as raised:
        READERS[reader](NOT_IT)
    assert raised.value.__context__ is None
    assert raised.value.__cause__ is None


def test_a_refused_query_reaches_no_asn1crypto_exception_through_its_chain() -> None:
    with pytest.raises(TimestampRefusedError) as raised:
        TimestampQuery.parse(NOT_IT)
    chain: list[BaseException] = []
    current: BaseException | None = raised.value
    while current is not None:
        chain.append(current)
        current = current.__cause__ or current.__context__
    assert [type(error).__name__ for error in chain] in (
        ["TimestampRefusedError"],
        ["TimestampRefusedError", "ValueError"],
    )
    assert all(str(error).startswith(("not a ", "The request")) for error in chain)


@pytest.mark.parametrize("value", [-1, -128, -(1 << 64)])
def test_a_negative_integer_is_refused_by_the_writer(value: int) -> None:
    """Red against the pre-change writer, which wrote -128 as `FF 80` (not minimal)."""
    with pytest.raises(ValueError, match="negative"):
        _der.integer(value)
    assert _der.integer(0) == b"\x02\x01\x00"
    assert _der.integer(128) == b"\x02\x02\x00\x80"


# -- the SubjectKeyIdentifier is read from the bytes -------------------------------------------------------------------
def test_the_subject_key_identifier_is_read_without_asn1cryptos_extension_walk(
    tsa_pki: TsaPki, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Red against the pre-change reader, which asked `Certificate.key_identifier` (every extension's OID decoded)."""
    from cryptography import x509  # noqa: PLC0415

    def forbidden(self: object) -> object:
        raise AssertionError("Certificate.key_identifier was read")

    monkeypatch.setattr(_der.x509.Certificate, "key_identifier", property(forbidden))
    for identity in (tsa_pki.ec, tsa_pki.rsa):
        expected = identity.leaf.extensions.get_extension_for_class(x509.SubjectKeyIdentifier).value.digest
        assert _der.read_certificate(identity.leaf_der).key_identifier == expected
    assert _der.read_certificate(tsa_pki.ber_leaf).key_identifier is not None


def test_verify_digest_judges_a_token_over_a_digest_the_way_verify_over_judges_it_over_data(tsa_pki: TsaPki) -> None:
    _, token, _ = issue(make_authority(tsa_pki.rsa))
    parsed = TimestampToken.parse(token)
    digest = hashlib.sha256(DATA).digest()
    assert parsed.verify_digest(digest, "sha256") == parsed.verify_over(DATA) == ()
    assert parsed.verify_digest(digest, "sha384") == ("imprint",)
    assert parsed.verify_digest(hashlib.sha256(b"other").digest(), "sha256") == ("imprint",)
    alike = tsa_pki.look_alike(tsa_pki.rsa)
    assert parsed.verify_digest(digest, "sha256", known_certificates=[alike]) == ()  # the carried leaf is found first


def test_signer_certificate_is_the_carried_one_else_the_known_one_else_none(tsa_pki: TsaPki) -> None:
    _, carried, _ = issue(make_authority(tsa_pki.ec))
    assert TimestampToken.parse(carried).signer_certificate() == tsa_pki.ec.leaf_der
    _, bare, _ = issue(make_authority(tsa_pki.ec), cert_req=False)
    parsed = TimestampToken.parse(bare)
    assert parsed.signer_certificate() is None
    assert parsed.signer_certificate([tsa_pki.ec.leaf_der]) == tsa_pki.ec.leaf_der
