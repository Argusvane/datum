"""The cost rule: an element whose content length is exactly 128 must not make issuance re-encode everything.

asn1crypto 1.5.1 treats a header ending in byte 0x80 as indefinite and forces a recursive re-encode; the definite long
form of 128 is `81 80`. Building one attribute takes 220 to 238 calls against 7,739 and 22,092 at the bad
lengths. The authority builds each fixed part once, re-loads its bytes and assembles the variable outer shapes by hand,
so a name that makes ESSCertIDv2, the ESS attribute or the TSA name exactly 128 octets must cost the same as one that
does not. Each case asserts THE BYTES (the element really is 128 octets long, the token still reads and verifies) AND a
call-count budget (relative to the neighbouring lengths, and absolute).

Two of the three sites cannot reach 128 with a real certificate: the signed-attribute SET holds four to five
attributes that are already longer than 128 octets together (contentType 28, signingTime 30, messageDigest 49, the ESS
attribute 70 or more), and a certificate is never under 200 octets. The sites that can are tested; the notes say why.
At the TSA-name site the call-count row proves the bytes, not the cost: asn1crypto's re-encode of a Name at 128 octets
costs only about 1.02 to 1.2 times more, so a naive per-token build of the TSA name stays inside the budget there. The
real guard of the build-once rule is the warm-issue row (no asn1crypto `dump()`, no second `fixed_parts`).

The readers' OID cost: asn1crypto works out an OBJECT IDENTIFIER's dotted form in time
quadratic in its length, so `read_token`, `read_reply` and `read_certificate` first walk the raw DER (definite lengths
in their shortest form only, nesting capped) and refuse any OID over 64 content octets before asn1crypto sees it; a
256,000-octet OID at each site is refused well inside 3 s.
"""

import functools
import statistics
import time
from collections.abc import Callable, Iterator
from functools import cache
from pathlib import Path
from typing import Any

import pytest
from cryptography.hazmat.primitives.asymmetric import ec
from tsa_der import Node, TokenParts, parse, query_der, tlv, token_parts
from tsa_kernel import KernelSession, kernel_session
from tsa_support import count_calls, make_authority, openssl_verify, sha256

from datum_core.testing import requires_openssl
from datum_core.testing.tsa_pki import TsaIdentity, TsaPki, make_leaf, make_root
from datum_core.timestamp import TimestampAuthority, TimestampQuery, TimestampToken, _der

DATA = b"hello"
REQUEST = query_der(sha256(DATA), cert_req=True)
SERIAL = 0x0123456789ABCDEF
"""A fixed 8-octet serial: the sizes below depend on it, so it is not random."""
RELATIVE_BUDGET = 1.5
"""Calls at the 128 length against the median of the neighbouring lengths."""
ABSOLUTE_BUDGET = 4_000
"""Calls of one `issue()`. The sketch that hand-assembles the outer shapes spends about 1,700 at every length; the
    build-once-only form spends 5,300 at a good length and 62,000 at a bad one; a naive build 7,739 for
    one attribute."""


@cache
def keys() -> tuple[ec.EllipticCurvePrivateKey, ec.EllipticCurvePrivateKey]:
    return ec.generate_private_key(ec.SECP384R1()), ec.generate_private_key(ec.SECP256R1())


LONG_ORGANIZATION = "O" * 64
"""A certificate name part at the X.520 limit: it lets the subject name reach 128 octets with a common name of 29."""


@cache
def named(issuer_length: int, subject_length: int, organization: str = "Datum test") -> TsaIdentity:
    """An EC identity whose root common name has `issuer_length` characters and the leaf's `subject_length`."""
    root_key, leaf_key = keys()
    root = make_root("R" * issuer_length, root_key)
    leaf = make_leaf("T" * subject_length, leaf_key, root, root_key, serial=SERIAL, organization=organization)
    return TsaIdentity("sized", root_key, root, leaf_key, leaf)


def token_of(identity: TsaIdentity) -> tuple[TimestampAuthority, bytes]:
    authority = make_authority(identity)
    grant = authority.issue(TimestampQuery.parse(REQUEST))
    return authority, grant.token


# site name: (which length is swept, the element whose content length must be 128)
def ess(parts: TokenParts) -> Node:
    return parts.ess


def ess_attribute(parts: TokenParts) -> Node:
    return parts.ess_attribute


def tsa_name(parts: TokenParts) -> Node:
    (general_name,) = parse(parts.tst.tsa_tlv or b"").children
    return parse(general_name.content)


SITES: dict[str, tuple[str, Callable[[TokenParts], Node]]] = {
    "ESSCertIDv2": ("issuer", ess),
    "ESS attribute": ("issuer", ess_attribute),
    "TSA name": ("subject", tsa_name),
}


def length_for(site: str, size: int) -> int:
    """The content length of `site`'s element in a token whose swept name has `size` characters."""
    sweep, pick = SITES[site]
    identity = named(size, 20) if sweep == "issuer" else named(20, size, LONG_ORGANIZATION)
    _, token = token_of(identity)
    return len(pick(token_parts(token)).content)


def find_size(site: str) -> int:
    """The name length at which `site` is exactly 128 octets (the test fails if no length in 1..64 gives it)."""
    for size in range(1, 65):
        if length_for(site, size) == 128:
            return size
    pytest.fail(f"no name length makes the {site} exactly 128 octets")


def authority_and_identity(site: str, size: int) -> tuple[TimestampAuthority, TsaIdentity]:
    identity = named(size, 20) if SITES[site][0] == "issuer" else named(20, size, LONG_ORGANIZATION)
    return make_authority(identity), identity


@pytest.mark.parametrize("site", sorted(SITES))
def test_the_element_is_really_128_octets_long_and_the_token_still_reads_whole(site: str) -> None:
    size = find_size(site)
    _, identity = authority_and_identity(site, size)
    _, token = token_of(identity)
    parts = token_parts(token)
    element = SITES[site][1](parts)
    assert len(element.content) == 128
    assert element.raw[:3] == bytes([element.tag, 0x81, 0x80]), "the header is the long form `81 80`"
    assert parts.tst.imprint == sha256(DATA)
    assert parts.ess.children[0].content == sha256(identity.leaf_der)
    assert parts.certificates == identity.chain_der or set(parts.certificates) == set(identity.chain_der)
    parsed = TimestampToken.parse(token)
    assert parsed.check() == ()
    assert parsed.verify_over(DATA) == ()


@pytest.mark.parametrize("site", sorted(SITES))
def test_issuing_at_128_costs_no_more_calls_than_at_the_neighbouring_lengths(site: str) -> None:
    """The bytes at every site, and the cost where a naive build shows (not at the TSA name: see the module text)."""
    size = find_size(site)
    counts: dict[int, int] = {}
    for candidate in [size - 4, size - 3, size - 2, size + 2, size + 3, size + 4, size]:
        authority, _ = authority_and_identity(site, candidate)
        query = TimestampQuery.parse(REQUEST)
        authority.issue(query)  # warm: imports and caches are not the build
        counts[candidate] = count_calls(functools.partial(authority.issue, query))
    neighbours = [count for candidate, count in counts.items() if candidate != size]
    at_128 = counts[size]
    assert at_128 <= RELATIVE_BUDGET * statistics.median(neighbours) + 50, (site, counts)
    assert at_128 <= ABSOLUTE_BUDGET, (site, counts)


def test_the_neighbouring_lengths_themselves_stay_within_the_absolute_budget() -> None:
    authority, _ = authority_and_identity("ESSCertIDv2", 20)
    query = TimestampQuery.parse(REQUEST)
    authority.issue(query)
    assert count_calls(functools.partial(authority.issue, query)) <= ABSOLUTE_BUDGET


def asn1crypto_dump_classes() -> list[type]:
    """Every asn1crypto class that defines its own `dump` (the base one included), found at run time."""
    found: list[type] = []
    pending: list[type] = [_der.core.Asn1Value]
    while pending:
        cls = pending.pop()
        if "dump" in vars(cls):
            found.append(cls)
        pending.extend(cls.__subclasses__())
    return found


@pytest.mark.parametrize("which", ["ec", "rsa"])
def test_a_warm_issue_dumps_nothing_through_asn1crypto_and_builds_the_fixed_parts_once(
    tsa_pki: TsaPki, monkeypatch: pytest.MonkeyPatch, which: str
) -> None:
    """The build-once rule itself: the 128 rows prove bytes at the TSA name, only this one proves the cost."""
    identity = tsa_pki.ec if which == "ec" else tsa_pki.rsa
    authority = make_authority(identity)
    query = TimestampQuery.parse(query_der(sha256(DATA), nonce=0x1234, cert_req=True))
    authority.issue(query)  # warm: the imprint's AlgorithmIdentifier is cached on first use
    dumps: list[type] = []
    builds: list[int] = []

    def counted(cls: type) -> Callable[..., Any]:
        real: Callable[..., Any] = vars(cls)["dump"]

        def dump(self: Any, *args: Any, **kwargs: Any) -> Any:
            dumps.append(cls)
            result: Any = real(self, *args, **kwargs)
            return result

        return dump

    for cls in asn1crypto_dump_classes():
        monkeypatch.setattr(cls, "dump", counted(cls))
    real_fixed = _der.fixed_parts

    def counted_fixed(*args: Any, **kwargs: Any) -> Any:
        builds.append(1)
        return real_fixed(*args, **kwargs)

    monkeypatch.setattr(_der, "fixed_parts", counted_fixed)
    for _ in range(3):
        authority.issue(query)
    assert dumps == []
    assert builds == []


@requires_openssl
@pytest.mark.parametrize("site", sorted(SITES))
def test_openssl_verifies_the_token_with_a_128_octet_element(tmp_path: Path, site: str) -> None:
    size = find_size(site)
    authority, identity = authority_and_identity(site, size)
    grant = authority.issue(TimestampQuery.parse(REQUEST))
    by_query = openssl_verify(tmp_path, grant.response, root_pem=identity.root_pem, query=REQUEST)
    assert by_query.returncode == 0, by_query.stderr
    by_data = openssl_verify(tmp_path, grant.response, root_pem=identity.root_pem, data=DATA)
    assert by_data.returncode == 0, by_data.stderr


# -- the 128-octet tokens through the other two readers ----------------------------------------------------------------
@pytest.fixture(scope="module")
def kernel(tsa_pki: TsaPki) -> Iterator[KernelSession]:
    with kernel_session(tsa_pki) as session:
        yield session


@pytest.mark.runtime
@pytest.mark.parametrize("site", sorted(SITES))
def test_the_kernel_accepts_the_token_with_a_128_octet_element(kernel: KernelSession, site: str) -> None:
    authority, _ = authority_and_identity(site, find_size(site))
    signing = kernel.prepare()
    grant = authority.issue(TimestampQuery.parse(signing.request))
    assert len(SITES[site][1](token_parts(grant.token)).content) == 128
    completed = kernel.complete(signing, grant.response)
    assert completed["ok"], completed
    report = kernel.verify(completed)
    assert report["coversSignature"] is True
    assert report["certificateMatches"] is True


@pytest.mark.parametrize("site", sorted(SITES))
def test_rfc3161_client_verifies_the_token_with_a_128_octet_element(site: str) -> None:
    from cryptography import x509  # noqa: PLC0415
    from rfc3161_client import VerifierBuilder, decode_timestamp_response  # noqa: PLC0415

    authority, identity = authority_and_identity(site, find_size(site))
    request = query_der(sha256(DATA), nonce=0x5151, cert_req=True)
    grant = authority.issue(TimestampQuery.parse(request))
    assert len(SITES[site][1](token_parts(grant.token)).content) == 128
    builder = VerifierBuilder().add_root_certificate(x509.load_der_x509_certificate(identity.root_der))
    builder = builder.nonce(0x5151).tsa_certificate(x509.load_der_x509_certificate(identity.leaf_der))
    assert builder.build().verify_message(decode_timestamp_response(grant.response), DATA) is True


# -- the readers' pre-walk: a long OID, BER lengths, deep nesting ------------------------------------------------------
LONG_OID = 256_000


def oid_of_octets(count: int) -> bytes:
    """An OBJECT IDENTIFIER TLV with `count` content octets: `2b`, continuation octets, a last arc."""
    return tlv(0x06, b"\x2b" + b"\x81" * (count - 2) + b"\x01")


def replaced(raw: bytes, path: tuple[int, ...], new: bytes) -> bytes:
    """Return `raw` with the TLV at `path` (child indexes) replaced by `new`, every enclosing length rewritten."""
    if not path:
        return new
    node = parse(raw)
    children = [child.raw for child in node.children]
    children[path[0]] = replaced(children[path[0]], path[1:], new)
    return tlv(node.tag, b"".join(children))


TST_OCTETS = (1, 0, 2, 1, 0)
"""ContentInfo > [0] > SignedData > encapContentInfo > [0] > the OCTET STRING holding the TSTInfo."""


def token_with_policy(token: bytes, policy: bytes) -> bytes:
    """`token` with its TSTInfo's policy replaced (inside the eContent OCTET STRING; the signature no longer holds)."""
    node = parse(token)
    for index in TST_OCTETS:
        node = node.children[index]
    tst = replaced(node.content, (1,), policy)
    return replaced(token, TST_OCTETS, tlv(0x04, tst))


def a_grant(identity: TsaIdentity) -> tuple[bytes, bytes]:
    grant = make_authority(identity).issue(TimestampQuery.parse(REQUEST))
    return grant.response, grant.token


def timed_refusal(reader: Callable[[bytes], object], der: bytes) -> float:
    started = time.monotonic()
    with pytest.raises(ValueError, match=r"^not a "):
        reader(der)
    return time.monotonic() - started


def test_a_token_whose_tstinfo_policy_is_a_256000_octet_oid_is_refused_inside_3_seconds(tsa_pki: TsaPki) -> None:
    """A reader that parsed this token took 12.8 s to read the OID."""
    _, token = a_grant(tsa_pki.ec)
    hostile = token_with_policy(token, oid_of_octets(LONG_OID))
    assert timed_refusal(_der.read_token, hostile) < 3
    started = time.monotonic()
    with pytest.raises(ValueError, match="not a timestamp token"):
        TimestampToken.parse(hostile)
    assert time.monotonic() - started < 3


def test_a_token_whose_content_type_is_a_256000_octet_oid_is_refused_inside_3_seconds(tsa_pki: TsaPki) -> None:
    _, token = a_grant(tsa_pki.ec)
    hostile = replaced(token, (0,), oid_of_octets(LONG_OID))
    assert timed_refusal(_der.read_token, hostile) < 3


def test_a_reply_carrying_a_256000_octet_oid_is_refused_inside_3_seconds(tsa_pki: TsaPki) -> None:
    """Red against the pre-change reader, which read the status and handed the hostile token on.

    The OID is the token's own content type, which the reply's walk reaches; a TSTInfo sits inside an OCTET STRING,
    so its OIDs are walked by `read_token`, which every reader of a reply's token goes through.
    """
    response, _ = a_grant(tsa_pki.ec)
    hostile = replaced(response, (1, 0), oid_of_octets(LONG_OID))
    assert timed_refusal(_der.read_reply, hostile) < 3


def test_a_certificate_with_a_256000_octet_extension_oid_is_refused_inside_3_seconds(tsa_pki: TsaPki) -> None:
    """Red against the pre-change reader: `Certificate.key_identifier` read every extension's OID."""
    hostile = replaced(tsa_pki.ec.leaf_der, (0, 7, 0, 0, 0), oid_of_octets(LONG_OID))
    assert timed_refusal(_der.read_certificate, hostile) < 3


def test_an_oid_of_64_content_octets_is_read_and_one_of_65_is_refused(tsa_pki: TsaPki) -> None:
    leaf = tsa_pki.ec.leaf_der
    at_cap = _der.read_certificate(replaced(leaf, (0, 7, 0, 0, 0), oid_of_octets(64)))
    assert at_cap.serial == _der.read_certificate(leaf).serial
    with pytest.raises(ValueError, match="not a certificate"):
        _der.read_certificate(replaced(leaf, (0, 7, 0, 0, 0), oid_of_octets(65)))
    _, token = a_grant(tsa_pki.ec)
    assert _der.read_token(token_with_policy(token, oid_of_octets(64))).policy.startswith("1.3.")
    with pytest.raises(ValueError, match="not a timestamp token"):
        _der.read_token(token_with_policy(token, oid_of_octets(65)))


def a_registered_id_name(octets: int) -> bytes:
    """A GeneralName `registeredID` ([8] IMPLICIT OBJECT IDENTIFIER) with `octets` content octets."""
    return b"\x88" + oid_of_octets(octets)[1:]


def test_an_implicitly_tagged_registered_id_counts_as_an_oid(tsa_pki: TsaPki) -> None:
    """The TSA field's GeneralName as a `registeredID` of 256,000 octets is refused like any OID."""
    _, token = a_grant(tsa_pki.ec)
    node = parse(token)
    for index in TST_OCTETS:
        node = node.children[index]
    tst = parse(node.content)
    tsa_index = next(i for i, child in enumerate(tst.children) if child.tag == 0xA0)
    tst_der = replaced(node.content, (tsa_index,), tlv(0xA0, a_registered_id_name(LONG_OID)))
    hostile = replaced(token, TST_OCTETS, tlv(0x04, tst_der))
    assert timed_refusal(_der.read_token, hostile) < 3


def non_minimal(raw: bytes) -> bytes:
    """`raw`'s outer TLV with its length written in four octets, a leading zero among them (BER, not DER)."""
    node = parse(raw)
    return bytes([node.tag, 0x84]) + len(node.content).to_bytes(4, "big") + node.content


def indefinite(raw: bytes) -> bytes:
    """`raw`'s outer constructed TLV with an indefinite length and its end-of-contents octets (BER, not DER)."""
    node = parse(raw)
    return bytes([node.tag, 0x80]) + node.content + b"\x00\x00"


def long_form_short(raw: bytes) -> bytes:
    """`raw` with its first short child's length in the long form although it is under 128 (`81 xx`: non-minimal)."""
    node = parse(raw)
    index = next(i for i, child in enumerate(node.children) if len(child.content) < 0x80)
    short = node.children[index]
    children = [child.raw for child in node.children]
    children[index] = bytes([short.tag, 0x81, len(short.content)]) + short.content
    return tlv(node.tag, b"".join(children))


BER_LENGTHS: dict[str, Callable[[bytes], bytes]] = {
    "indefinite": indefinite,
    "four-octet-length": non_minimal,
    "long-form-under-128": long_form_short,
}


@pytest.mark.parametrize("form", sorted(BER_LENGTHS))
def test_every_reader_refuses_a_ber_length(tsa_pki: TsaPki, form: str) -> None:
    """Red against the pre-change readers, which asn1crypto lets read all three forms."""
    response, token = a_grant(tsa_pki.ec)
    change = BER_LENGTHS[form]
    with pytest.raises(ValueError, match="not a timestamp token"):
        _der.read_token(change(token))
    with pytest.raises(ValueError, match="not a TimeStampResp"):
        _der.read_reply(change(response))
    with pytest.raises(ValueError, match="not a certificate"):
        _der.read_certificate(change(tsa_pki.ec.leaf_der))


def test_a_ber_length_inside_the_tstinfo_is_refused(tsa_pki: TsaPki) -> None:
    _, token = a_grant(tsa_pki.ec)
    node = parse(token)
    for index in TST_OCTETS:
        node = node.children[index]
    hostile = replaced(token, TST_OCTETS, tlv(0x04, non_minimal(node.content)))
    with pytest.raises(ValueError, match="not a timestamp token"):
        _der.read_token(hostile)


def nested(depth: int) -> bytes:
    inner = tlv(0x0C, b"x")
    for _ in range(depth):
        inner = tlv(0x30, inner)
    return inner


def test_a_certificate_nested_past_the_depth_cap_is_refused_and_the_real_one_reads(tsa_pki: TsaPki) -> None:
    """A Name value nested 100 SEQUENCEs deep: asn1crypto never reads it (red against the pre-change reader)."""
    leaf = tsa_pki.ec.leaf_der
    issuer = parse(leaf).children[0].children[3]
    attribute = issuer.children[0].children[0]
    deep = tlv(0x30, tlv(0x31, tlv(0x30, attribute.children[0].raw + nested(100))))
    with pytest.raises(ValueError, match="not a certificate"):
        _der.read_certificate(replaced(leaf, (0, 3), deep))
    shallow = tlv(0x30, tlv(0x31, tlv(0x30, attribute.children[0].raw + nested(8))))
    assert _der.read_certificate(replaced(leaf, (0, 3), shallow)).issuer == shallow


def test_the_content_level_leniencies_stay_accepted(tsa_pki: TsaPki) -> None:
    """A BOOLEAN other than FF (the BER leaf) is read; structural DER is what the pre-walk enforces."""
    read = _der.read_certificate(tsa_pki.ber_leaf)
    assert read.der == tsa_pki.ber_leaf
    assert read.spki == _der.read_certificate(tsa_pki.rsa.leaf_der).spki
    assert "BOOLEAN" in (_der.__doc__ or "")
