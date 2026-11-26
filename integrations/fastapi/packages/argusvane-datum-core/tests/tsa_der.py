"""A DER writer and reader for the timestamp tests, independent of the code under test (and of asn1crypto).

The tests build every request as bytes with `query_der` and read every reply and token with `Node`, `parse_reply` and
`token_parts`, so a mistake in `datum_core.timestamp` cannot be hidden by sharing a library with the test. The reader
is deliberately small: definite lengths only, no indefinite form (a TSA reply is never written that way).
"""

from collections.abc import Iterator, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime

SHA256 = "2.16.840.1.101.3.4.2.1"
SHA384 = "2.16.840.1.101.3.4.2.2"
SHA512 = "2.16.840.1.101.3.4.2.3"
SHA224 = "2.16.840.1.101.3.4.2.4"
SHA1 = "1.3.14.3.2.26"
MD5 = "1.2.840.113549.2.5"
DIGEST_OIDS = {"sha256": SHA256, "sha384": SHA384, "sha512": SHA512, "sha224": SHA224, "sha1": SHA1, "md5": MD5}
DIGEST_LENGTHS = {"sha256": 32, "sha384": 48, "sha512": 64, "sha224": 28, "sha1": 20, "md5": 16}

OID_SIGNED_DATA = "1.2.840.113549.1.7.2"
OID_TST_INFO = "1.2.840.113549.1.9.16.1.4"
OID_CONTENT_TYPE = "1.2.840.113549.1.9.3"
OID_MESSAGE_DIGEST = "1.2.840.113549.1.9.4"
OID_SIGNING_TIME = "1.2.840.113549.1.9.5"
OID_ESS_CERT_ID_V2 = "1.2.840.113549.1.9.16.2.47"
OID_ALGORITHM_PROTECTION = "1.2.840.113549.1.9.52"
OID_ECDSA_SHA256 = "1.2.840.10045.4.3.2"
OID_RSA_SHA256 = "1.2.840.113549.1.1.11"

# PKIFailureInfo bit numbers (RFC 3161 section 2.4.2)
BAD_ALG = 0
BAD_REQUEST = 2
BAD_DATA_FORMAT = 5
TIME_NOT_AVAILABLE = 14
UNACCEPTED_POLICY = 15
UNACCEPTED_EXTENSION = 16
SYSTEM_FAILURE = 25


def tlv(tag: int, body: bytes) -> bytes:
    """Return one TLV with a definite length in its shortest form."""
    size = len(body)
    if size < 0x80:
        head = bytes([size])
    else:
        length = size.to_bytes((size.bit_length() + 7) // 8, "big")
        head = bytes([0x80 | len(length)]) + length
    return bytes([tag]) + head + body


def seq(*parts: bytes) -> bytes:
    """Return a SEQUENCE of `parts`."""
    return tlv(0x30, b"".join(parts))


def der_int(value: int) -> bytes:
    """Return an INTEGER in its minimal two's-complement form."""
    size = max(1, (value.bit_length() + 8) // 8)
    return tlv(0x02, value.to_bytes(size, "big", signed=True))


def raw_int(content: bytes) -> bytes:
    """Return an INTEGER whose content octets are exactly `content` (a non-minimal form is the point)."""
    return tlv(0x02, content)


def der_oid(dotted: str) -> bytes:
    """Return an OBJECT IDENTIFIER (arcs of any size)."""
    arcs = [int(part) for part in dotted.split(".")]
    body = bytearray([arcs[0] * 40 + arcs[1]])
    for arc in arcs[2:]:
        rest = arc >> 7
        chunk = [arc & 0x7F]
        while rest:
            chunk.append(0x80 | (rest & 0x7F))
            rest >>= 7
        body.extend(reversed(chunk))
    return tlv(0x06, bytes(body))


def query_der(
    imprint: bytes,
    algorithm: str = "sha256",
    *,
    version: int = 1,
    policy: str | None = None,
    nonce: int | bytes | None = None,
    cert_req: bool = True,
    extension: bool = False,
    algorithm_oid: str | None = None,
    parameters: bytes | None = b"\x05\x00",
) -> bytes:
    """Return a TimeStampReq as DER.

    `nonce` as an int is written minimally (a negative int in two's complement); as bytes it is the INTEGER's content
    octets verbatim (`b"\\x00\\x00\\x05"` is the non-minimal `02 03 00 00 05`). `parameters` is the hash
    AlgorithmIdentifier's parameters (NULL by default; `None` leaves them out).
    """
    oid = algorithm_oid or DIGEST_OIDS[algorithm]
    algorithm_id = seq(der_oid(oid), parameters or b"")
    parts = [der_int(version), seq(algorithm_id, tlv(0x04, imprint))]
    if policy is not None:
        parts.append(der_oid(policy))
    if nonce is not None:
        parts.append(raw_int(nonce) if isinstance(nonce, bytes) else der_int(nonce))
    if cert_req:
        parts.append(tlv(0x01, b"\xff"))
    if extension:
        parts.append(tlv(0xA0, seq(der_oid("1.2.3.4"), tlv(0x04, b"\x05\x00"))))
    return seq(*parts)


# -- the reader --------------------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class Node:
    """One TLV: its tag, its content octets and its whole encoding."""

    tag: int
    content: bytes
    raw: bytes
    children: tuple["Node", ...] = field(default=(), repr=False)

    @property
    def constructed(self) -> bool:
        """Whether the tag says the content is itself TLVs."""
        return bool(self.tag & 0x20)


def read_tlv(data: bytes, offset: int = 0) -> tuple[Node, int]:
    """Read the TLV at `offset`; return it and the offset after it. Constructed content is read into `children`."""
    tag = data[offset]
    first = data[offset + 1]
    at = offset + 2
    if first < 0x80:
        size = first
    elif first == 0x80:
        raise ValueError("indefinite length")
    else:
        count = first & 0x7F
        size = int.from_bytes(data[at : at + count], "big")
        at += count
    end = at + size
    if end > len(data):
        raise ValueError("a TLV runs past its parent")
    content = data[at:end]
    kids: tuple[Node, ...] = ()
    if tag & 0x20:
        found: list[Node] = []
        inner = 0
        while inner < len(content):
            child, inner = read_tlv(content, inner)
            found.append(child)
        kids = tuple(found)
    return Node(tag, content, data[offset:end], kids), end


def parse(data: bytes) -> Node:
    """Read `data` as exactly one TLV."""
    node, end = read_tlv(data)
    if end != len(data):
        raise ValueError("trailing bytes")
    return node


def walk(node: Node) -> Iterator[Node]:
    """Yield `node` and every descendant, depth first."""
    yield node
    for child in node.children:
        yield from walk(child)


def oid_of(node: Node) -> str:
    """Return the dotted form of an OBJECT IDENTIFIER node."""
    body = node.content
    arcs = [body[0] // 40, body[0] % 40]
    value = 0
    for byte in body[1:]:
        value = (value << 7) | (byte & 0x7F)
        if not byte & 0x80:
            arcs.append(value)
            value = 0
    return ".".join(str(arc) for arc in arcs)


def int_of(node: Node) -> int:
    """Return an INTEGER node's value."""
    return int.from_bytes(node.content, "big", signed=True)


# -- a reply -----------------------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class ParsedReply:
    """A TimeStampResp read without a library: the PKIStatus, its words, the failInfo bits and the token (if any)."""

    status: int
    texts: tuple[str, ...]
    fail_bits: frozenset[int]
    token: bytes | None


def parse_reply(der: bytes) -> ParsedReply:
    """Read a TimeStampResp (granted or rejected)."""
    root = parse(der)
    info = root.children[0]
    status = int_of(info.children[0])
    texts: tuple[str, ...] = ()
    bits: frozenset[int] = frozenset()
    for child in info.children[1:]:
        if child.tag == 0x30:
            texts = tuple(item.content.decode("utf-8") for item in child.children)
        elif child.tag == 0x03:
            unused, body = child.content[0], child.content[1:]
            total = len(body) * 8 - unused
            bits = frozenset(index for index in range(total) if body[index // 8] & (0x80 >> (index % 8)))
    token = root.children[1].raw if len(root.children) > 1 else None
    return ParsedReply(status, texts, bits, token)


# -- a token -----------------------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class TstInfo:
    """The TSTInfo fields the tests read (the nonce and the TSA name keep their whole TLV)."""

    version: int
    policy: str
    algorithm: str
    imprint: bytes
    serial: int
    gen_time: str
    accuracy: tuple[int | None, int | None, int | None] | None
    nonce_tlv: bytes | None
    tsa_tlv: bytes | None


@dataclass(frozen=True)
class TokenParts:
    """A token pulled apart: the TSTInfo, the carried certificates, the signer, the signed attributes."""

    content_info: Node
    signed_data: Node
    tst_der: bytes
    tst: TstInfo
    certificates: tuple[bytes, ...]
    signer: Node
    signed_attributes: Node
    ess_attribute: Node
    ess: Node

    @property
    def sid(self) -> Node:
        """The SignerIdentifier (issuer and serial)."""
        return self.signer.children[1]

    @property
    def signature(self) -> bytes:
        """The signature octets."""
        return self.signer.children[-1].content


def _tst_info(der: bytes) -> TstInfo:
    root = parse(der)
    kids = list(root.children)
    version, policy, imprint_node, serial, gen_time, *rest = kids
    accuracy = None
    nonce_tlv = None
    tsa_tlv = None
    for node in rest:
        if node.tag == 0x30:
            fields: dict[int, int] = {}
            for part in node.children:
                fields[part.tag] = int_of(part)
            accuracy = (fields.get(0x02), fields.get(0x80), fields.get(0x81))
        elif node.tag == 0x02:
            nonce_tlv = node.raw
        elif node.tag == 0xA0:
            tsa_tlv = node.raw
    return TstInfo(
        version=int_of(version),
        policy=oid_of(policy),
        algorithm=oid_of(imprint_node.children[0].children[0]),
        imprint=imprint_node.children[1].content,
        serial=int_of(serial),
        gen_time=gen_time.content.decode("ascii"),
        accuracy=accuracy,
        nonce_tlv=nonce_tlv,
        tsa_tlv=tsa_tlv,
    )


def token_parts(token: bytes) -> TokenParts:
    """Read a timestamp token (a CMS ContentInfo holding SignedData over a TSTInfo)."""
    content_info = parse(token)
    assert_oid = oid_of(content_info.children[0])
    if assert_oid != OID_SIGNED_DATA:
        raise ValueError(f"not SignedData: {assert_oid}")
    signed_data = content_info.children[1].children[0]
    kids = signed_data.children
    encap = kids[2]
    tst_der = encap.children[1].children[0].content
    certificates: tuple[bytes, ...] = ()
    for node in kids[3:]:
        if node.tag == 0xA0:
            certificates = tuple(item.raw for item in node.children)
    signer = kids[-1].children[0]
    attributes = next(child for child in signer.children if child.tag == 0xA0)
    ess_attribute = next(a for a in attributes.children if oid_of(a.children[0]) == OID_ESS_CERT_ID_V2)
    ess = ess_attribute.children[1].children[0].children[0].children[0]
    return TokenParts(
        content_info, signed_data, tst_der, _tst_info(tst_der), certificates, signer, attributes, ess_attribute, ess
    )


def attribute_oids(parts: TokenParts) -> list[str]:
    """Return the signed attributes' types in the order they are written."""
    return [oid_of(a.children[0]) for a in parts.signed_attributes.children]


def is_der_set_order(parts: Sequence[bytes]) -> bool:
    """Whether `parts` are in DER SET OF order (X.690 11.6: ascending as octet strings)."""
    return list(parts) == sorted(parts)


def generalized_time(instant: datetime) -> str:
    """Return the GeneralizedTime text of `instant` in UTC, whole seconds (`20261020120000Z`)."""
    return instant.astimezone(UTC).strftime("%Y%m%d%H%M%SZ")
