"""The `messageDigest` of CMS signed attributes, read only from DER.

`signed_attributes_digest` answers the value of the one `messageDigest` attribute of signed attributes
(`SET OF Attribute`, each `SEQUENCE { OBJECT IDENTIFIER, SET OF value }`), its one value an OCTET STRING, or None when
the bytes are not that shape in DER: no attribute or more than one is a `messageDigest`, it holds other than one value,
or the encoding is not the one DER allows. The DER rules checked are structural DER (`_der`'s pre-walk: definite and
shortest-form lengths, one element, the OID cap and the nesting cap) and, over every element: each SET's elements in
ascending order of their encodings, no constructed form of a universal primitive type, a BOOLEAN of `00` or `FF`, an
INTEGER or ENUMERATED in its fewest octets, an empty NULL, and OBJECT IDENTIFIER arcs in their fewest octets.

Built on: `_der`'s pre-walk (`require_der`), which refuses before anything is split. asn1crypto's `CMSAttributes`
would read BER and re-encode on `dump()` (the cost `_der` names), and `cryptography` reads no CMS attributes, so the
TLVs are split here; nothing is parsed into objects.
"""

from typing import Final

from datum_core.timestamp._der import OID_MESSAGE_DIGEST, oid, require_der

__all__ = ["signed_attributes_digest"]

_SET: Final = 0x31
_SEQUENCE: Final = 0x30
_OCTET_STRING: Final = 0x04
_OBJECT_IDENTIFIER: Final = 0x06
_BOOLEAN: Final = 0x01
_INTEGER: Final = 0x02
_ENUMERATED: Final = 0x0A
_NULL: Final = 0x05
_CONSTRUCTED: Final = 0x20
_CLASS: Final = 0xC0
_HIGH_TAG: Final = 0x1F
_SHORT_FORM: Final = 0x80
_PAIR: Final = 2
_ZERO: Final = 0x00
_ONES: Final = 0xFF
_MESSAGE_DIGEST_TYPE: Final = oid(OID_MESSAGE_DIGEST)


def signed_attributes_digest(der: bytes) -> bytes | None:
    """Return the one `messageDigest` value of DER signed attributes, or None when `der` is not that shape."""
    try:
        require_der(der)
        (whole,) = _elements(der)
        if whole[0] != _SET or not _canonical(whole):
            return None
        found: list[list[tuple[int, bytes, bytes]]] = []
        for tag, _, content in _elements(whole[2]):
            members = _elements(content)
            if tag != _SEQUENCE or len(members) != _PAIR:
                return None
            (kind, kind_encoding, _), (values_tag, _, values) = members
            if kind != _OBJECT_IDENTIFIER or values_tag != _SET:
                return None
            if kind_encoding == _MESSAGE_DIGEST_TYPE:
                found.append(_elements(values))
    except (ValueError, IndexError):
        return None
    if len(found) != 1 or len(found[0]) != 1:
        return None
    value_tag, _, digest = found[0][0]
    return digest if value_tag == _OCTET_STRING else None


def _elements(content: bytes) -> list[tuple[int, bytes, bytes]]:
    """Split content octets the pre-walk passed into (first tag octet, the whole encoding, its content octets)."""
    found: list[tuple[int, bytes, bytes]] = []
    at = 0
    while at < len(content):
        first = content[at]
        cursor = at + 1
        if first & _HIGH_TAG == _HIGH_TAG:
            while content[cursor] & 0x80:
                cursor += 1
            cursor += 1
        head = content[cursor]
        cursor += 1
        if head < _SHORT_FORM:
            size = head
        else:
            count = head & 0x7F
            size = int.from_bytes(content[cursor : cursor + count], "big")
            cursor += count
        end = cursor + size
        if end > len(content):
            raise ValueError("an element runs past its parent")
        found.append((first, content[at:end], content[cursor:end]))
        at = end
    return found


def _canonical(element: tuple[int, bytes, bytes]) -> bool:
    """Whether `element` and everything inside it keeps the DER rules of the module text (an explicit stack)."""
    pending = [element]
    while pending:
        tag, _, content = pending.pop()
        universal = tag & _CLASS == 0
        if tag & _CONSTRUCTED:
            children = _elements(content)
            if universal and tag not in {_SEQUENCE, _SET}:
                return False  # a constructed string, or another universal primitive written constructed
            if tag == _SET and [child[1] for child in children] != sorted(child[1] for child in children):
                return False
            pending.extend(children)
        elif universal and not _primitive_canonical(tag, content):
            return False
    return True


def _primitive_canonical(tag: int, content: bytes) -> bool:
    if tag == _BOOLEAN:
        return content in {b"\x00", b"\xff"}
    if tag in {_INTEGER, _ENUMERATED}:
        # the fewest octets: no leading 00 before a clear top bit, no leading FF before a set one
        padded = len(content) > 1 and (
            (content[0] == _ZERO and content[1] < _SHORT_FORM) or (content[0] == _ONES and content[1] >= _SHORT_FORM)
        )
        return bool(content) and not padded
    if tag == _NULL:
        return not content
    if tag == _OBJECT_IDENTIFIER:
        if not content or content[-1] & 0x80:
            return False
        starts = [0] + [index + 1 for index, octet in enumerate(content[:-1]) if not octet & 0x80]
        return all(content[start] != 0x80 for start in starts)  # noqa: PLR2004 - a leading zero group
    return True
