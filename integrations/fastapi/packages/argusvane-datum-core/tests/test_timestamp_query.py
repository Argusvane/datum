"""`TimestampQuery.parse` and the request rules, one row at a time, over requests the TEST builds as DER bytes.

Every request here is written by `tsa_der.query_der` (no library, no code under test), so a parser mistake cannot be
mirrored by a builder mistake. The rows are the query table, the refusals (SHA-1, an unaccepted policy, an
extension, a 65-byte nonce, a negative nonce, version 2, a 20-byte SHA-256 imprint, truncated DER) and the bounds the
bounds (64 vs 65-byte nonce, OID caps of 64 characters and 16 arcs, trailing bytes, hostile lengths). A refusal
is a `TimestampRefusedError` naming the RFC 3161 failure; the bit, the status and the words are
`test_timestamp_refusal`'s.
"""

import contextlib
import hashlib
import random
import time
from typing import Any

import pytest
from tsa_der import SHA1, SHA256, der_int, der_oid, parse_reply, query_der, raw_int, seq, tlv
from tsa_support import (
    FOREIGN_POLICY,
    OTHER_POLICY,
    POLICY,
    CountingSerials,
    IdentityKey,
    make_authority,
    sha256,
)

from datum_core.testing.tsa_pki import TsaPki
from datum_core.timestamp import TimestampQuery, TimestampRefusedError

DIGEST = sha256(b"hello")
LONG_POLICY_ARCS = ".".join(["1", "3", *["6"] * 15])  # 17 arcs
SIXTEEN_ARCS = ".".join(["1", "3", *["6"] * 14])  # 16 arcs, 30 characters
SIXTY_FOUR_CHARS = "1.3.6.1.4.1.99999" + ".12345" * 6 + "." + "7" * 10  # 64 characters, 14 arcs


def refused(request: bytes) -> str:
    """Parse `request`, which must be refused; return the failure name."""
    with pytest.raises(TimestampRefusedError) as raised:
        TimestampQuery.parse(request)
    return raised.value.failure


# -- what is accepted --------------------------------------------------------------------------------------------------
@pytest.mark.parametrize(
    ("algorithm", "length"), [("sha256", 32), ("sha384", 48), ("sha512", 64)], ids=["sha256", "sha384", "sha512"]
)
def test_an_imprint_over_sha_256_384_or_512_is_taken(algorithm: str, length: int) -> None:
    digest = hashlib.new(algorithm, b"x").digest()
    assert len(digest) == length
    query = TimestampQuery.parse(query_der(digest, algorithm))
    assert query.imprint_algorithm == algorithm
    assert query.imprint == digest


def test_a_bare_request_has_no_policy_no_nonce_and_certreq_false() -> None:
    query = TimestampQuery.parse(query_der(DIGEST, cert_req=False))
    assert query.policy is None
    assert query.nonce is None
    assert query.cert_req is False


def test_certreq_true_policy_and_nonce_are_read() -> None:
    query = TimestampQuery.parse(query_der(DIGEST, policy=OTHER_POLICY, nonce=0x1234567890, cert_req=True))
    assert query.cert_req is True
    assert query.policy == OTHER_POLICY
    assert query.nonce == 0x1234567890


@pytest.mark.parametrize("parameters", [b"\x05\x00", None], ids=["null-parameters", "absent-parameters"])
def test_the_hash_algorithm_identifier_may_carry_null_parameters_or_none(parameters: bytes | None) -> None:
    assert TimestampQuery.parse(query_der(DIGEST, parameters=parameters)).imprint == DIGEST


@pytest.mark.parametrize(
    "parameters", [b"\x04\x00", b"\x02\x01\x00", b"\x30\x00"], ids=["octets", "integer", "sequence"]
)
def test_hash_parameters_other_than_null_are_bad_data_format(parameters: bytes) -> None:
    """SHA-2 identifiers carry NULL or no parameters (RFC 5754); anything else is not a request Datum reads.

    Datum answers `badDataFormat`; openssl's own TSA answers `badAlg` ("superfluous message digest parameter"). Datum
    keeps its answer. No Datum mutant turns this row red: asn1crypto refuses such parameters
    for the SHA-2 OIDs before Datum's own `parameters == "other"` check (kept as defence in depth).
    """
    assert refused(query_der(DIGEST, parameters=parameters)) == "badDataFormat"


def test_a_nonce_of_zero_is_taken_because_it_is_not_negative() -> None:
    assert TimestampQuery.parse(query_der(DIGEST, nonce=0)).nonce == 0


def test_a_nonce_of_64_bytes_is_taken() -> None:
    content = b"\x40" + b"\x01" * 63  # 64 octets, the first below 0x80: positive
    query = TimestampQuery.parse(query_der(DIGEST, nonce=content))
    assert query.nonce == int.from_bytes(content, "big")


def test_a_non_minimal_nonce_is_taken_by_value() -> None:
    """`02 03 00 00 05` is read as 5; openssl cannot parse it, parity with the other reader is kept."""
    request = query_der(DIGEST, nonce=b"\x00\x00\x05")
    assert b"\x02\x03\x00\x00\x05" in request
    assert TimestampQuery.parse(request).nonce == 5


def test_a_policy_of_16_arcs_and_one_of_64_characters_are_taken() -> None:
    assert len(SIXTY_FOUR_CHARS) == 64
    assert SIXTEEN_ARCS.count(".") + 1 == 16
    for policy in (SIXTEEN_ARCS, SIXTY_FOUR_CHARS):
        assert TimestampQuery.parse(query_der(DIGEST, policy=policy)).policy == policy


def test_a_request_the_test_builds_survives_parse_and_to_der_unchanged_in_meaning() -> None:
    first = TimestampQuery.parse(query_der(DIGEST, policy=POLICY, nonce=77, cert_req=True))
    again = TimestampQuery.parse(first.to_der())
    assert again == first


def test_to_der_writes_the_nonce_in_its_shortest_form() -> None:
    parsed = TimestampQuery.parse(query_der(DIGEST, nonce=b"\x00\x00\x05"))
    assert b"\x02\x01\x05" in parsed.to_der()
    assert b"\x02\x03\x00\x00\x05" not in parsed.to_der()


def test_of_builds_a_query_a_reader_without_the_library_takes() -> None:
    built = TimestampQuery.of(DIGEST, "sha256", policy=POLICY, nonce=9, cert_req=True)
    der = built.to_der()
    assert der == query_der(DIGEST, policy=POLICY, nonce=9, cert_req=True)


# -- what is refused: algorithm ----------------------------------------------------------------------------------------
@pytest.mark.parametrize(
    ("algorithm", "oid", "length"),
    [
        ("sha1", SHA1, 20),
        ("md5", "1.2.840.113549.2.5", 16),
        ("sha224", "2.16.840.1.101.3.4.2.4", 28),
        ("unknown", "1.2.3.4.5.6", 32),
    ],
)
def test_an_imprint_over_any_other_algorithm_is_bad_alg(algorithm: str, oid: str, length: int) -> None:
    assert refused(query_der(b"\x01" * length, algorithm_oid=oid)) == "badAlg"


def test_an_algorithm_oid_past_the_caps_is_bad_alg() -> None:
    assert refused(query_der(b"\x01" * 32, algorithm_oid=LONG_POLICY_ARCS)) == "badAlg"
    assert refused(query_der(b"\x01" * 32, algorithm_oid="1.3." + ".".join(["9" * 20] * 4))) == "badAlg"


# -- what is refused: shape --------------------------------------------------------------------------------------------
@pytest.mark.parametrize(
    ("algorithm", "length"),
    [("sha256", 20), ("sha256", 31), ("sha256", 33), ("sha256", 0), ("sha384", 32), ("sha512", 48)],
)
def test_an_imprint_of_the_wrong_length_for_its_algorithm_is_bad_data_format(algorithm: str, length: int) -> None:
    assert refused(query_der(b"\x01" * length, algorithm)) == "badDataFormat"


@pytest.mark.parametrize("version", [0, 2, 3, 255])
def test_a_version_other_than_1_is_bad_data_format(version: int) -> None:
    assert refused(query_der(DIGEST, version=version)) == "badDataFormat"


def test_a_negative_nonce_is_bad_data_format() -> None:
    assert refused(query_der(DIGEST, nonce=-1)) == "badDataFormat"
    assert refused(query_der(DIGEST, nonce=-(2**100))) == "badDataFormat"


def test_a_nonce_of_65_bytes_is_bad_data_format_and_one_of_64_is_not() -> None:
    assert refused(query_der(DIGEST, nonce=b"\x01" + b"\x07" * 64)) == "badDataFormat"
    assert (
        refused(query_der(DIGEST, nonce=b"\x00" + b"\x80" + b"\x07" * 63)) == "badDataFormat"
    )  # 65 octets: a pad and 64 more
    assert TimestampQuery.parse(query_der(DIGEST, nonce=b"\x7f" + b"\x07" * 63)).nonce is not None


def test_a_nonce_with_no_content_octets_is_bad_data_format() -> None:
    assert refused(query_der(DIGEST, nonce=b"")) == "badDataFormat"


def test_any_request_extension_is_unaccepted_extension() -> None:
    assert refused(query_der(DIGEST, extension=True)) == "unacceptedExtension"


def test_a_policy_past_64_characters_or_16_arcs_is_bad_request() -> None:
    too_long = "1.3." + ".".join(["9" * 5] * 11)
    assert len(too_long) > 64
    assert refused(query_der(DIGEST, policy=too_long)) == "badRequest"
    assert refused(query_der(DIGEST, policy=LONG_POLICY_ARCS)) == "badRequest"


@pytest.mark.parametrize(
    "request_bytes",
    [
        b"",
        b"not a TimeStampReq",
        b"\x30",
        b"\x30\x00",
        b"\x30\x03\x02\x01",
        b"\x04\x01\x00",
        query_der(DIGEST)[:-3],
        query_der(DIGEST)[:20],
        seq(tlv(0x04, b"x")),
        seq(raw_int(b"\x01"), tlv(0x04, b"not an imprint")),
    ],
    ids=[
        "empty",
        "text",
        "tag-only",
        "empty-sequence",
        "short-version",
        "not-a-sequence",
        "truncated-end",
        "truncated-middle",
        "wrong-first-field",
        "imprint-is-not-a-sequence",
    ],
)
def test_bytes_that_are_not_a_timestamp_request_are_bad_data_format(request_bytes: bytes) -> None:
    assert refused(request_bytes) == "badDataFormat"


def test_trailing_bytes_after_the_request_are_bad_data_format() -> None:
    good = query_der(DIGEST)
    assert refused(good + b"\x00") == "badDataFormat"
    assert refused(good + good) == "badDataFormat"


@pytest.mark.parametrize(
    "request_bytes",
    [
        b"\x30\x84\xff\xff\xff\xff" + b"\x00" * 10,
        b"\x30" * 1_048_576,
        b"\x30\x82\x04\x00" + b"\x30\x82\x03\xfc" * 20,
        b"\xff" * 4096,
    ],
    ids=["huge-claimed-length", "one-mib-of-0x30", "claimed-nesting", "all-ff"],
)
def test_hostile_der_is_refused_quickly_as_bad_data_format_and_nothing_else_escapes(request_bytes: bytes) -> None:
    started = time.monotonic()
    assert refused(request_bytes) == "badDataFormat"
    assert time.monotonic() - started < 5


def test_an_indefinite_length_request_is_read_or_refused_but_never_crashes() -> None:
    """DER has no indefinite length; a reader may take the BER form or refuse it, and a missing end is a refusal."""
    body = query_der(DIGEST)[2:]
    with contextlib.suppress(TimestampRefusedError):  # refusing is as good as reading, as long as nothing else escapes
        TimestampQuery.parse(b"\x30\x80" + body + b"\x00\x00")
    assert refused(b"\x30\x80" + body) == "badDataFormat"


def test_deep_nesting_is_refused_as_bad_data_format() -> None:
    nested = b"\x05\x00"
    for _ in range(2000):
        nested = tlv(0x30, nested)
    assert refused(nested) == "badDataFormat"


def test_the_refusals_message_echoes_no_request_byte() -> None:
    marker = "ZZ-REQUEST-MARKER-ZZ"
    for request in (marker.encode(), query_der(DIGEST, policy="1.3.6.1.4.1.999999999.1.2.3", algorithm_oid=SHA1)):
        with pytest.raises(TimestampRefusedError) as raised:
            TimestampQuery.parse(request)
        text = f"{raised.value} {raised.value.message}"
        assert marker not in text
        assert "999999999" not in text
        assert "ZZ" not in text


# -- the policy rule: the accepted ones and the issuing one -------------------------------------------------------
def test_a_policy_the_server_does_not_issue_under_is_unaccepted_policy_and_the_text_lists_the_accepted_ones(
    tsa_pki: TsaPki,
) -> None:
    authority = make_authority(tsa_pki.ec)
    query = TimestampQuery.parse(query_der(DIGEST, policy=FOREIGN_POLICY))
    with pytest.raises(TimestampRefusedError) as raised:
        authority.issue(query)
    assert raised.value.failure == "unacceptedPolicy"
    assert POLICY in raised.value.message
    assert OTHER_POLICY in raised.value.message
    assert FOREIGN_POLICY not in raised.value.message


@pytest.mark.parametrize("policy", [None, POLICY, OTHER_POLICY], ids=["none-named", "issuing", "accepted"])
def test_no_policy_the_issuing_one_and_an_accepted_one_are_all_taken(tsa_pki: TsaPki, policy: str | None) -> None:
    authority = make_authority(tsa_pki.ec)
    grant = authority.issue(TimestampQuery.parse(query_der(DIGEST, policy=policy)))
    assert grant.response


# -- the eight refusals, as the server answers them ---------------------------------------------------------------
REFUSALS = [
    ("sha1-imprint", query_der(b"\x01" * 20, algorithm_oid=SHA1), 0),
    ("unaccepted-policy", query_der(DIGEST, policy="1.2.3.4"), 15),
    ("extension", query_der(DIGEST, extension=True), 16),
    ("nonce-65-bytes", query_der(DIGEST, nonce=b"\x01" + b"\x07" * 64), 5),
    ("negative-nonce", query_der(DIGEST, nonce=-1), 5),
    ("version-2", query_der(DIGEST, version=2), 5),
    ("imprint-20-bytes", query_der(b"\x01" * 20, "sha256"), 5),
    ("truncated-der", query_der(DIGEST)[:-5], 5),
]


@pytest.mark.parametrize(("name", "request_bytes", "bit"), REFUSALS, ids=[row[0] for row in REFUSALS])
def test_each_refused_request_is_answered_as_a_rejection_with_its_failure_bit_and_no_token(
    tsa_pki: TsaPki, name: str, request_bytes: bytes, bit: int
) -> None:
    authority = make_authority(tsa_pki.ec)
    answer = authority.answer(request_bytes)
    read = parse_reply(answer.response)
    assert answer.refusal is not None
    assert answer.grant is None
    assert read.status == 2, name
    assert read.fail_bits == {bit}, name
    assert read.token is None
    assert read.texts
    assert all(text.isascii() for text in read.texts)


# -- what the structure does not define is refused, never dropped ------------------------------------------------------
def oid_of_octets(count: int) -> bytes:
    """An OBJECT IDENTIFIER TLV with `count` content octets: `2b`, continuation octets, a last arc."""
    return tlv(0x06, b"\x2b" + b"\x81" * (count - 2) + b"\x01")


def request_around(
    *, hash_oid: bytes | None = None, policy_oid: bytes | None = None, parameters: bytes = b"\x05\x00"
) -> bytes:
    """A TimeStampReq whose hash OID (and policy OID) are the given TLVs, built without any library."""
    hash_oid = hash_oid or der_oid(SHA256)
    parts = [der_int(1), seq(seq(hash_oid, parameters), tlv(0x04, DIGEST))]
    if policy_oid is not None:
        parts.append(policy_oid)
    return seq(*parts)


def imprint_with(*extra: bytes) -> bytes:
    return seq(seq(der_oid(SHA256), b"\x05\x00"), tlv(0x04, DIGEST), *extra)


EXTRAS = {
    "policy-after-nonce": seq(der_int(1), imprint_with(), der_int(5), der_oid("1.2.3")),
    "nonce-after-certreq": seq(der_int(1), imprint_with(), tlv(0x01, b"\xff"), der_int(5)),
    "two-policies": seq(der_int(1), imprint_with(), der_oid("1.2.3"), der_oid("1.2.4")),
    "context-1-element": seq(der_int(1), imprint_with(), tlv(0xA1, b"")),
    "untagged-sequence": seq(der_int(1), imprint_with(), seq(der_oid("1.2.3"), tlv(0x04, b"\x05\x00"))),
    "extra-in-message-imprint": seq(der_int(1), imprint_with(tlv(0x04, b"extra"))),
    "extra-in-algorithm-identifier": seq(
        der_int(1), seq(seq(der_oid(SHA256), b"\x05\x00", tlv(0x04, b"extra")), tlv(0x04, DIGEST))
    ),
}


@pytest.mark.parametrize("name", sorted(EXTRAS))
def test_an_element_the_structure_does_not_define_is_bad_data_format(name: str) -> None:
    assert refused(EXTRAS[name]) == "badDataFormat"


# -- OID content caps, with the cost of a long OID ---------------------------------------------------------------------
@pytest.mark.parametrize("octets", [65, 100, 4000, 16_000, 256_000])
def test_a_hash_oid_past_64_content_octets_is_bad_alg_and_costs_nothing(octets: int) -> None:
    started = time.monotonic()
    assert refused(request_around(hash_oid=oid_of_octets(octets))) == "badAlg"
    assert time.monotonic() - started < 3


@pytest.mark.parametrize("octets", [100, 4000, 256_000])
def test_a_policy_oid_past_64_content_octets_is_bad_request_and_costs_nothing(octets: int) -> None:
    started = time.monotonic()
    assert refused(request_around(policy_oid=oid_of_octets(octets))) == "badRequest"
    assert time.monotonic() - started < 3


# -- a query built directly meets the same rules -----------------------------------------------------------------------
DIRECT: list[tuple[str, tuple[str, bytes, dict[str, Any]], str]] = [
    ("unknown-algorithm", ("md5", b"\x01" * 16, {}), "badAlg"),
    ("short-imprint", ("sha256", b"x" * 5, {}), "badDataFormat"),
    ("negative-nonce", ("sha256", DIGEST, {"nonce": -7}), "badDataFormat"),
    ("huge-nonce", ("sha256", DIGEST, {"nonce": 1 << 4000}), "badDataFormat"),
    ("nonce-of-512-bits", ("sha256", DIGEST, {"nonce": 1 << 511}), "badDataFormat"),
    ("long-policy", ("sha256", DIGEST, {"policy": LONG_POLICY_ARCS}), "badRequest"),
    ("not-an-oid", ("sha256", DIGEST, {"policy": "banana"}), "badRequest"),
]


@pytest.mark.parametrize(("name", "args", "failure"), DIRECT, ids=[row[0] for row in DIRECT])
def test_a_directly_built_query_that_breaks_a_rule_is_refused_before_the_key_or_a_serial(
    tsa_pki: TsaPki, name: str, args: tuple[str, bytes, dict[str, Any]], failure: str
) -> None:
    algorithm, imprint, fields = args
    key = IdentityKey(tsa_pki.ec)
    serials = CountingSerials()
    authority = make_authority(tsa_pki.ec, key=key, serials=serials)
    with pytest.raises(TimestampRefusedError) as raised:
        authority.issue(TimestampQuery(algorithm, imprint, **fields))
    assert raised.value.failure == failure, name
    assert key.signs == 0
    assert serials.allocations == 0


def test_the_largest_nonce_a_query_takes_is_511_bits() -> None:
    assert TimestampQuery("sha256", DIGEST, nonce=(1 << 511) - 1).nonce == (1 << 511) - 1
    assert TimestampQuery("sha256", DIGEST, nonce=0).nonce == 0


# -- a seeded fuzz through the authority: only typed answers come back ------------------------------------------------
FUZZ_SEED = 61_2026
FUZZ_ROUNDS = 2_000
REQUEST_FAILURES = {"badAlg", "badRequest", "badDataFormat", "unacceptedPolicy", "unacceptedExtension"}


def mutated(rng: random.Random, base: bytes) -> bytes:
    """One random change to `base`: a byte replaced, inserted or removed, a cut, a slice repeated or a length bumped."""
    data = bytearray(base)
    at = rng.randrange(len(data))
    kind = rng.randrange(6)
    if kind == 0:
        data[at] = rng.randrange(256)
    elif kind == 1:
        data.insert(at, rng.randrange(256))
    elif kind == 2:
        del data[at]
    elif kind == 3:
        del data[at:]
    elif kind == 4:
        end = min(len(data), at + rng.randrange(1, 9))
        data[at:at] = data[at:end]
    else:
        data[at] = rng.choice([0x00, 0x7F, 0x80, 0x81, 0x82, 0x84, 0xFF])
    return bytes(data)


def test_a_seeded_fuzz_of_2000_mutated_requests_answers_each_with_a_reply_and_never_raises(tsa_pki: TsaPki) -> None:
    """Every mutation of a full request is answered: a grant, or a rejection naming a request failure; nothing escapes
    `answer()` and no parse problem becomes `systemFailure`. Red against the mutant whose `TimestampQuery.parse`
    stops turning the reader's `ValueError` into a refusal. (Narrowing `read_request`'s `except Exception` to
    `ValueError` survives: asn1crypto raised nothing else here, nor in 200,000 mutations.)"""
    authority = make_authority(tsa_pki.ec)
    base = query_der(DIGEST, policy=OTHER_POLICY, nonce=0x1234567, cert_req=True)
    rng = random.Random(FUZZ_SEED)  # noqa: S311 - a reproducible fuzz, not a secret
    granted = refused_count = 0
    for _ in range(FUZZ_ROUNDS):
        request = mutated(rng, base)
        answer = authority.answer(request)
        reply = parse_reply(answer.response)
        if answer.refusal is None:
            assert answer.grant is not None
            assert reply.status == 0
            granted += 1
        else:
            assert answer.refusal.failure in REQUEST_FAILURES, (request.hex(), answer.refusal.failure)
            assert reply.status == 2
            refused_count += 1
    assert granted > 0
    assert refused_count > FUZZ_ROUNDS // 2
