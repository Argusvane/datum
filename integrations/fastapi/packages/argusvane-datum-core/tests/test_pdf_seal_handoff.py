"""The seal signs a handoff only when it is over the prepared file, checked before the key is used.

The sandboxed program hands out what the server's key signs. `complete` re-derives everything from the bytes, but
only after the key has made a value, so the host ties the handoff to the prepared bytes first: the byte range is
`[0, a, b, c]` with `a < b` and `b + c` the file's length (one gap, reaching the end); `digest` is the SHA-256 over
those ranges; `toBeSignedDigest` is the SHA-256 of `toBeSigned`; and `toBeSigned` is a DER SET of attributes, each
`SEQUENCE { OID, SET }`, holding exactly one `messageDigest` whose one value is an OCTET STRING of that digest. Any
other handoff is the 500 `signature` (`PdfSignatureError`, the code of every signing refusal), and the key signs
nothing and `complete` is never asked.
"""

import base64
import hashlib
from collections.abc import Callable
from typing import Any

import pytest
from pdf_support import PdfRig, started_pdf

from datum_core.pdf.outcomes import PdfError, Printed
from datum_core.testing.pdf_handoff import (
    OID_CONTENT_TYPE,
    OID_DATA,
    OID_MESSAGE_DIGEST,
    attribute,
    attributes,
    der,
    object_identifier,
    signed_attributes,
    signing_handoff,
)
from datum_core.testing.tsa_pki import DocumentPki, build_document_pki
from datum_core.timestamp.attributes import signed_attributes_digest

SEALED = {"pdf": {"seal": {"enabled": True, "timestamp": False, "posted_answers": True}}}

type Damage = Callable[[bytes, dict[str, Any]], None]
"""Changes the handoff the program sent over `prepared` (in place)."""


@pytest.fixture(scope="module")
def pki() -> DocumentPki:
    return build_document_pki()


def _decoded(handoff: dict[str, Any], key: str) -> bytes:
    return base64.b64decode(handoff[key])


def _digest_of(prepared: bytes, handoff: dict[str, Any]) -> bytes:
    return _decoded(handoff, "digest")


def _with_attributes(signed: Callable[[bytes, bytes], bytes]) -> Damage:
    """A damage that replaces `toBeSigned` by `signed(prepared, digest)` and keeps `toBeSignedDigest` its digest."""

    def damage(prepared: bytes, handoff: dict[str, Any]) -> None:
        to_be_signed = signed(prepared, _digest_of(prepared, handoff))
        handoff["toBeSigned"] = base64.b64encode(to_be_signed).decode("ascii")
        handoff["toBeSignedDigest"] = base64.b64encode(hashlib.sha256(to_be_signed).digest()).decode("ascii")

    return damage


def _range(change: Callable[[list[int], int], list[int]]) -> Damage:
    """A damage that changes the byte range and makes every digest agree with it, so only the range is wrong."""

    def damage(prepared: bytes, handoff: dict[str, Any]) -> None:
        changed = change(list(handoff["byteRange"]), len(prepared))
        digest = hashlib.sha256(prepared[: changed[1]] + prepared[changed[2] :]).digest()
        to_be_signed = signed_attributes(digest)
        handoff["byteRange"] = changed
        handoff["digest"] = base64.b64encode(digest).decode("ascii")
        handoff["toBeSigned"] = base64.b64encode(to_be_signed).decode("ascii")
        handoff["toBeSignedDigest"] = base64.b64encode(hashlib.sha256(to_be_signed).digest()).decode("ascii")

    return damage


def _content_type() -> bytes:
    return attribute(OID_CONTENT_TYPE, object_identifier(OID_DATA))


def _message_digest(digest: bytes) -> bytes:
    return attribute(OID_MESSAGE_DIGEST, der(0x04, digest))


DAMAGES: dict[str, Damage] = {
    "a range that does not start at 0": _range(lambda r, _n: [1, r[1], r[2], r[3]]),
    "a gap of no length": _range(lambda r, n: [0, r[1], r[1], n - r[1]]),
    "a gap that runs backwards": _range(lambda r, n: [0, r[2], r[1], n - r[1]]),
    "a range short of the end": _range(lambda r, _n: [0, r[1], r[2], r[3] - 1]),
    "a range past the end": _range(lambda r, _n: [0, r[1], r[2], r[3] + 1]),
    "a digest over other bytes": lambda _p, h: h.update(
        digest=base64.b64encode(hashlib.sha256(b"other").digest()).decode("ascii")
    ),
    "a toBeSignedDigest of something else": lambda _p, h: h.update(
        toBeSignedDigest=base64.b64encode(hashlib.sha256(b"other").digest()).decode("ascii")
    ),
    "attributes over another digest": _with_attributes(lambda _p, _d: signed_attributes(hashlib.sha256(b"x").digest())),
    "no messageDigest": _with_attributes(lambda _p, _d: attributes(_content_type())),
    "two messageDigests": _with_attributes(
        lambda _p, d: attributes(_message_digest(d), attribute(OID_MESSAGE_DIGEST, der(0x04, d + b"\x00")))
    ),
    "a messageDigest of two values": _with_attributes(
        lambda _p, d: attributes(attribute(OID_MESSAGE_DIGEST, der(0x04, d), der(0x04, d + b"\x00")))
    ),
    "a messageDigest that is no OCTET STRING": _with_attributes(
        lambda _p, d: attributes(attribute(OID_MESSAGE_DIGEST, der(0x0C, d)))
    ),
    "a constructed OCTET STRING": _with_attributes(
        lambda _p, d: attributes(attribute(OID_MESSAGE_DIGEST, der(0x24, der(0x04, d))))
    ),
    "a SEQUENCE, not a SET": _with_attributes(lambda _p, d: der(0x30, _content_type() + _message_digest(d))),
    "an attribute of three members": _with_attributes(
        lambda _p, d: attributes(
            der(0x30, object_identifier(OID_MESSAGE_DIGEST) + der(0x31, der(0x04, d)) + der(0x05, b""))
        )
    ),
    "an attribute whose values are no SET": _with_attributes(
        lambda _p, d: attributes(der(0x30, object_identifier(OID_MESSAGE_DIGEST) + der(0x30, der(0x04, d))))
    ),
    "an attribute whose type is no OID": _with_attributes(
        lambda _p, d: attributes(der(0x30, der(0x04, b"\x2a") + der(0x31, der(0x04, d))))
    ),
    "attributes out of DER order": _with_attributes(
        lambda _p, d: der(0x31, b"".join(sorted([_content_type(), _message_digest(d)], reverse=True)))
    ),
    "a length not in its shortest form": _with_attributes(
        lambda _p, d: b"\x31\x81" + bytes([len(_message_digest(d))]) + _message_digest(d)
    ),
    "bytes after the SET": _with_attributes(lambda _p, d: attributes(_message_digest(d)) + b"\x00"),
}


def answering(rig: PdfRig, op: str, damage: Damage | None) -> None:
    """Answer `op` as the scripted program does, with the handoff damaged by `damage`."""

    def answer(request: dict[str, Any]) -> dict[str, Any]:
        sent = rig.runtime.answer_of(op, request)
        if damage is not None:
            damage(base64.b64decode(sent["bytes"]), sent["signing"])
        return sent

    rig.runtime.on(op, answer)


def test_a_handoff_over_the_prepared_file_is_signed_once(pki: DocumentPki) -> None:
    with started_pdf(SEALED, signer=pki.signer) as rig:
        answering(rig, "document", None)
        outcome = rig.render()
        assert isinstance(outcome, Printed), outcome
        assert rig.signer is not None
        assert len(rig.signer.signs) == 1
        assert len(rig.runtime.requests("complete")) == 1


@pytest.mark.parametrize("damage", DAMAGES.values(), ids=DAMAGES.keys())
def test_a_handoff_not_over_the_prepared_file_is_refused_before_the_key_signs(pki: DocumentPki, damage: Damage) -> None:
    with started_pdf(SEALED, signer=pki.signer) as rig:
        answering(rig, "document", damage)
        with pytest.raises(PdfError) as raised:
            rig.render()
        assert (raised.value.code, raised.value.status) == ("signature", 500)
        assert rig.signer is not None
        assert rig.signer.signs == []
        assert rig.runtime.requests("complete") == []


def test_the_sign_route_checks_its_handoff_too(pki: DocumentPki) -> None:
    with started_pdf({"pdf": {"seal": {"enabled": False}}}, signer=pki.signer) as rig:
        answering(rig, "document", DAMAGES["a digest over other bytes"])
        answering(rig, "sign", DAMAGES["a digest over other bytes"])
        with pytest.raises(PdfError) as raised:
            rig.sign()
        assert (raised.value.code, raised.value.status) == ("signature", 500)
        assert rig.signer is not None
        assert rig.signer.signs == []
        assert rig.runtime.requests("complete") == []


# -- the reader itself ---------------------------------------------------------------------------------------------
DIGEST = hashlib.sha256(b"the file").digest()


def test_the_reader_returns_the_one_message_digest() -> None:
    assert signed_attributes_digest(signed_attributes(DIGEST)) == DIGEST
    handoff = signing_handoff(b"%PDF-1.7\nthe file\n", algorithm="ECDSA-P256-SHA256")
    assert signed_attributes_digest(_decoded(handoff, "toBeSigned")) == _decoded(handoff, "digest")


@pytest.mark.parametrize(
    "value",
    [
        b"",
        b"\x31\x00",  # no attribute at all
        attributes(
            _message_digest(DIGEST), attribute("1.2.3.4", der(0x02, b"\x02"), der(0x02, b"\x01"), ordered=False)
        ),
        attributes(_message_digest(DIGEST), attribute("1.2.3.4", der(0x01, b"\x01"))),  # a BOOLEAN that is not FF
        attributes(_message_digest(DIGEST), attribute("1.2.3.4", der(0x02, b"\x00\x05"))),  # a padded INTEGER
        attributes(_message_digest(DIGEST), attribute("1.2.3.4", der(0x02, b""))),  # an empty INTEGER
        attributes(
            _message_digest(DIGEST), attribute("1.2.3.4", der(0x30, der(0x31, der(0x02, b"\x02") + der(0x02, b"\x01"))))
        ),
        attributes(_message_digest(DIGEST), attribute("1.2.3.4", der(0x2C, der(0x0C, b"a")))),  # a constructed string
        attributes(_message_digest(DIGEST), der(0x30, der(0x06, b"\x2a\x80\x01") + der(0x31, b""))),  # a padded OID arc
        b"\x31\x80" + _message_digest(DIGEST) + b"\x00\x00",  # an indefinite length
    ],
    ids=[
        "empty",
        "no attribute",
        "unsorted values",
        "boolean",
        "padded integer",
        "empty integer",
        "nested unsorted set",
        "constructed string",
        "padded oid",
        "indefinite",
    ],
)
def test_the_reader_refuses_what_is_not_der_signed_attributes(value: bytes) -> None:
    assert signed_attributes_digest(value) is None
