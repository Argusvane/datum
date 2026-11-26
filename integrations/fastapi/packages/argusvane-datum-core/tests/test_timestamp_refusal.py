"""The refusal table (failInfo bit, HTTP status, Datum's words), the DER of a rejection and what a refusal costs.

The seven failures and their bits bind (RFC 3161 section 2.4.2; the catalog's statuses); the words are Datum's own and
echo no request byte. A rejection is read here with the test's own DER reader and, when the binary is present, by
`openssl ts -reply -text`, which prints the failure it decodes. A refused request costs no key use and no serial.
"""

from pathlib import Path

import pytest
from test_timestamp_query import REFUSALS
from tsa_der import BAD_ALG, parse, parse_reply, query_der
from tsa_support import CountingSerials, IdentityKey, make_authority, openssl_reply_text, refused, sha256

from datum_core.testing import requires_openssl
from datum_core.testing.tsa_pki import TsaPki
from datum_core.timestamp import TimestampRefusal

# failure name: (failInfo bit, HTTP status, what `openssl ts -reply -text` says for the bit)
TABLE = {
    "badAlg": (0, 400, "unrecognized or unsupported algorithm identifier"),
    "badRequest": (2, 400, "transaction not permitted or supported"),
    "badDataFormat": (5, 400, "the data submitted has the wrong format"),
    "timeNotAvailable": (14, 503, "the TSA's time source is not available"),
    "unacceptedPolicy": (15, 400, "the requested TSA policy is not supported by the TSA"),
    "unacceptedExtension": (16, 400, "the requested extension is not supported by the TSA"),
    "systemFailure": (25, 503, "the request cannot be handled due to system failure"),
}


@pytest.mark.parametrize("failure", sorted(TABLE))
def test_each_failure_has_its_bit_and_its_http_status(failure: str) -> None:
    bit, status, _ = TABLE[failure]
    refusal = TimestampRefusal.of(refused(failure))
    assert refusal.failure == failure
    assert refusal.bit == bit
    assert refusal.http_status == status


def test_the_table_is_exactly_the_seven_failures() -> None:
    assert sorted(TABLE) == sorted(
        [
            "badAlg",
            "badRequest",
            "badDataFormat",
            "timeNotAvailable",
            "unacceptedPolicy",
            "unacceptedExtension",
            "systemFailure",
        ]
    )


@pytest.mark.parametrize("failure", sorted(TABLE))
def test_a_rejection_is_a_pki_status_2_with_one_bit_the_words_and_no_token(failure: str) -> None:
    refusal = TimestampRefusal.of(refused(failure))
    der = refusal.to_der()
    read = parse_reply(der)
    assert read.status == 2
    assert read.fail_bits == {TABLE[failure][0]}
    assert read.token is None
    assert read.texts == (refusal.text,)
    assert refusal.text
    assert refusal.text.isascii()
    assert parse(der).tag == 0x30  # one SEQUENCE: no trailing bytes


def test_the_words_of_the_seven_failures_are_distinct() -> None:
    texts = [TimestampRefusal.of(refused(failure)).text for failure in sorted(TABLE)]
    assert len(set(texts)) == len(texts)


def test_the_message_a_hook_gives_is_the_status_text() -> None:
    refusal = TimestampRefusal.of(refused("badRequest", "This client may not ask."))
    assert "This client may not ask." in refusal.text
    assert parse_reply(refusal.to_der()).texts == (refusal.text,)


def test_a_message_that_is_not_ascii_or_is_very_long_still_makes_a_valid_rejection() -> None:
    for message in ("Mehr Zeit, bitte é", "x" * 5000):
        refusal = TimestampRefusal.of(refused("badRequest", message))
        read = parse_reply(refusal.to_der())
        assert read.status == 2
        assert read.fail_bits == {2}


def test_the_bits_in_a_bit_string_are_named_bits_with_no_trailing_zero_octets() -> None:
    """DER: a named-bit BIT STRING drops trailing zero bits; bit 25 needs four octets, bit 0 needs one."""
    for failure, (bit, _, _) in TABLE.items():
        info = parse(TimestampRefusal.of(refused(failure)).to_der()).children[0]
        bits = next(child for child in info.children if child.tag == 0x03)
        assert len(bits.content) - 1 == bit // 8 + 1
        assert bits.content[-1] != 0
    assert TABLE["badAlg"][0] == BAD_ALG


def test_only_the_two_503_failures_are_503() -> None:
    assert sorted(name for name, row in TABLE.items() if row[1] == 503) == ["systemFailure", "timeNotAvailable"]
    for failure in ("timeNotAvailable", "systemFailure"):
        assert TimestampRefusal.of(refused(failure)).http_status == 503


# -- a refusal costs nothing -------------------------------------------------------------------------------------------
BAD_REQUESTS = [
    query_der(b"\x01" * 20, algorithm_oid="1.3.14.3.2.26"),
    query_der(sha256(b"x"), policy="1.2.3.4"),
    query_der(sha256(b"x"), extension=True),
    query_der(sha256(b"x"), nonce=-1),
    b"not a TimeStampReq",
]


def test_a_refused_request_costs_no_key_use_and_no_serial(tsa_pki: TsaPki) -> None:
    key = IdentityKey(tsa_pki.ec)
    serials = CountingSerials()
    authority = make_authority(tsa_pki.ec, key=key, serials=serials)
    for request in BAD_REQUESTS:
        answer = authority.answer(request)
        assert answer.refusal is not None
    assert key.signs == 0
    assert serials.allocations == 0


def test_the_words_never_carry_a_request_byte(tsa_pki: TsaPki) -> None:
    authority = make_authority(tsa_pki.ec)
    marker = "ZZ-NOT-ECHOED-ZZ"
    for request in (marker.encode(), query_der(sha256(b"x"), policy="1.3.9999.8888.7777")):
        answer = authority.answer(request)
        assert answer.refusal is not None
        assert marker not in answer.refusal.text
        assert "8888" not in answer.refusal.text


# -- the cross-check ---------------------------------------------------------------------------------------------------
@requires_openssl
@pytest.mark.parametrize("failure", sorted(TABLE))
def test_openssl_reads_each_rejection_and_names_its_failure(tmp_path: Path, failure: str) -> None:
    refusal = TimestampRefusal.of(refused(failure))
    text = openssl_reply_text(tmp_path, refusal.to_der())
    assert "Status: Rejected" in text
    assert TABLE[failure][2] in text
    assert refusal.text in text


@requires_openssl
@pytest.mark.parametrize(("name", "request_bytes", "bit"), REFUSALS, ids=[row[0] for row in REFUSALS])
def test_openssl_reads_the_answer_to_each_refused_request_and_names_its_failure(
    tmp_path: Path, tsa_pki: TsaPki, name: str, request_bytes: bytes, bit: int
) -> None:
    answer = make_authority(tsa_pki.ec).answer(request_bytes)
    assert answer.refusal is not None
    text = openssl_reply_text(tmp_path, answer.response)
    (failure,) = (failure for failure, row in TABLE.items() if row[0] == bit)
    assert "Status: Rejected" in text, name
    assert TABLE[failure][2] in text, name
    assert answer.refusal.text in text, name
