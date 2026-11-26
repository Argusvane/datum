"""A signing handoff shaped as the PDF program makes one, for scripted programs in tests.

The host signs a handoff only when it is over the prepared file: a byte range `[0, a, b, c]` with one gap reaching the
end, the SHA-256 over those ranges as `digest`, `toBeSigned` a DER SET of attributes whose one `messageDigest` is that
digest, and `toBeSignedDigest` its SHA-256. `signing_handoff` writes such a handoff over any bytes; `signed_attributes`
and the DER writers let a test build the attributes, or a broken variant of them, by hand.

Built on: `hashlib` and `base64`. The DER is written by the few lines below rather than asn1crypto so a test can write
shapes no library would (an unsorted SET, a long-form length).
"""

import base64
import hashlib
from datetime import UTC, datetime, timedelta
from typing import Any, Final

__all__ = [
    "OID_CONTENT_TYPE",
    "OID_DATA",
    "OID_MESSAGE_DIGEST",
    "OID_SIGNING_TIME",
    "attribute",
    "attributes",
    "der",
    "object_identifier",
    "signed_attributes",
    "signing_handoff",
]

OID_CONTENT_TYPE: Final = "1.2.840.113549.1.9.3"
OID_MESSAGE_DIGEST: Final = "1.2.840.113549.1.9.4"
OID_SIGNING_TIME: Final = "1.2.840.113549.1.9.5"
OID_DATA: Final = "1.2.840.113549.1.7.1"
_EPOCH: Final = datetime(2026, 1, 1, tzinfo=UTC)
_SHORT_FORM: Final = 0x80


def der(tag: int, content: bytes) -> bytes:
    """Return one DER element: `tag`, the shortest-form length, `content`."""
    size = len(content)
    if size < _SHORT_FORM:
        return bytes([tag, size]) + content
    octets = size.to_bytes((size.bit_length() + 7) // 8, "big")
    return bytes([tag, _SHORT_FORM | len(octets)]) + octets + content


def object_identifier(dotted: str) -> bytes:
    """Return the DER OBJECT IDENTIFIER of `dotted`."""
    arcs = [int(arc) for arc in dotted.split(".")]
    body = bytearray([arcs[0] * 40 + arcs[1]])
    for arc in arcs[2:]:
        groups = [arc & 0x7F]
        rest = arc >> 7
        while rest:
            groups.append(0x80 | (rest & 0x7F))
            rest >>= 7
        body += bytes(reversed(groups))
    return der(0x06, bytes(body))


def attribute(dotted: str, *values: bytes, ordered: bool = True) -> bytes:
    """Return the Attribute `SEQUENCE { type, SET OF value }` (the values sorted unless `ordered` is false)."""
    inner = sorted(values) if ordered else list(values)
    return der(0x30, object_identifier(dotted) + der(0x31, b"".join(inner)))


def attributes(*items: bytes, ordered: bool = True) -> bytes:
    """Return the signed attributes `SET OF Attribute` (sorted as DER requires unless `ordered` is false)."""
    return der(0x31, b"".join(sorted(items) if ordered else items))


def signed_attributes(digest: bytes, *, serial: int = 1) -> bytes:
    """Return contentType `data`, a signing time `serial` seconds into 2026 and the one messageDigest `digest`."""
    when = (_EPOCH + timedelta(seconds=serial)).strftime("%y%m%d%H%M%SZ").encode("ascii")
    return attributes(
        attribute(OID_CONTENT_TYPE, object_identifier(OID_DATA)),
        attribute(OID_SIGNING_TIME, der(0x17, when)),
        attribute(OID_MESSAGE_DIGEST, der(0x04, digest)),
    )


def signing_handoff(
    pdf: bytes,
    *,
    algorithm: str,
    serial: int = 1,
    field: str = "Signature1",
    to_be_signed: bytes | None = None,
) -> dict[str, Any]:
    """Return the program's `signing` member over `pdf`: a two-octet gap in the middle, the attributes over the rest.

    `to_be_signed` replaces the attributes (its `toBeSignedDigest` follows it), for a test of a handoff the host
    refuses.
    """
    start = len(pdf) // 2
    end = start + 2
    digest = hashlib.sha256(pdf[:start] + pdf[end:]).digest()
    signed = signed_attributes(digest, serial=serial) if to_be_signed is None else to_be_signed
    return {
        "field": field,
        "byteRange": [0, start, end, len(pdf) - end],
        "digest": base64.b64encode(digest).decode("ascii"),
        "toBeSigned": base64.b64encode(signed).decode("ascii"),
        "toBeSignedDigest": base64.b64encode(hashlib.sha256(signed).digest()).decode("ascii"),
        "signatureAlgorithm": algorithm,
        "subFilter": "ETSI.CAdES.detached",
    }
