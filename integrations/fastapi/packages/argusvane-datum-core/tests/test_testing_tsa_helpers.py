"""The helpers themselves: the test PKI, `requires_openssl` and the three store contracts.

The PKI builds five certificate kinds and a PKCS#12 in under 3 seconds, nothing committed; the BER leaf is really BER;
the look-alike differs from the leaf by one character and keeps every length. `requires_openssl` skips with a
reason when the binary is absent and `DATUM_OPENSSL` names another. Each contract class fails a store that breaks
its rule (a mutant per rule), so a green binding means something. These tests need no timestamp code, so they are
green now.
"""

import time
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace

import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, padding, rsa
from cryptography.hazmat.primitives.serialization import pkcs12
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

from datum_core.stores.tsa import TsaClientRecord, TsaLogEntry
from datum_core.testing import TsaClientStoreContract, TsaLogContract, TsaSerialAllocatorContract
from datum_core.testing.openssl import (
    OPENSSL_ENV,
    openssl_binary,
    openssl_skip_reason,
    requires_openssl,
    skip_openssl_under_xdist,
)
from datum_core.testing.tsa_contract import key_hash, key_text
from datum_core.testing.tsa_pki import INSTANT, PKI_NOT_AFTER, PKI_NOT_BEFORE, TsaPki, build_pki, bytes_to_pem


# -- the PKI -----------------------------------------------------------------------------------------------------------
def test_the_pki_builds_every_kind_and_a_pkcs12_in_under_three_seconds() -> None:
    started = time.perf_counter()
    pki = build_pki()
    pki.ec.pkcs12()
    pki.rsa.pkcs12(ca_names=("root",))
    pki.look_alike(pki.rsa)
    assert time.perf_counter() - started < 3.0
    assert pki.ber_leaf


def test_the_ec_chain_is_p256_under_p384_and_the_rsa_chain_is_2048_under_3072(tsa_pki: TsaPki) -> None:
    ec_leaf, ec_root = tsa_pki.ec.leaf.public_key(), tsa_pki.ec.root.public_key()
    rsa_leaf, rsa_root = tsa_pki.rsa.leaf.public_key(), tsa_pki.rsa.root.public_key()
    assert isinstance(ec_leaf, ec.EllipticCurvePublicKey)
    assert ec_leaf.curve.name == "secp256r1"
    assert isinstance(ec_root, ec.EllipticCurvePublicKey)
    assert ec_root.curve.name == "secp384r1"
    assert isinstance(rsa_leaf, rsa.RSAPublicKey)
    assert rsa_leaf.key_size == 2048
    assert isinstance(rsa_root, rsa.RSAPublicKey)
    assert rsa_root.key_size == 3072


def test_each_leaf_is_signed_by_its_root_and_the_roots_are_cas(tsa_pki: TsaPki) -> None:
    for identity in (tsa_pki.ec, tsa_pki.rsa, tsa_pki.wrong_eku):
        assert identity.leaf.issuer == identity.root.subject
        identity.leaf.verify_directly_issued_by(identity.root)
        basic = identity.root.extensions.get_extension_for_class(x509.BasicConstraints)
        assert basic.value.ca is True


def test_the_conforming_leaves_have_a_critical_time_stamping_eku_and_the_wrong_one_server_auth(tsa_pki: TsaPki) -> None:
    for identity in (tsa_pki.ec, tsa_pki.rsa):
        eku = identity.leaf.extensions.get_extension_for_class(x509.ExtendedKeyUsage)
        assert eku.critical is True
        assert list(eku.value) == [ExtendedKeyUsageOID.TIME_STAMPING]
    wrong = tsa_pki.wrong_eku.leaf.extensions.get_extension_for_class(x509.ExtendedKeyUsage)
    assert list(wrong.value) == [ExtendedKeyUsageOID.SERVER_AUTH]


def test_every_certificate_is_valid_at_the_fixed_instant(tsa_pki: TsaPki) -> None:
    for identity in (tsa_pki.ec, tsa_pki.rsa, tsa_pki.wrong_eku):
        for certificate in (identity.leaf, identity.root):
            assert certificate.not_valid_before_utc == PKI_NOT_BEFORE
            assert certificate.not_valid_after_utc == PKI_NOT_AFTER
            assert certificate.not_valid_before_utc <= INSTANT <= certificate.not_valid_after_utc


def test_the_look_alike_has_the_leafs_key_issuer_and_serial_and_a_subject_one_character_off(tsa_pki: TsaPki) -> None:
    alike = x509.load_der_x509_certificate(tsa_pki.look_alike(tsa_pki.rsa))
    leaf = tsa_pki.rsa.leaf
    assert alike.public_key() == leaf.public_key()
    assert alike.issuer == leaf.issuer
    assert alike.serial_number == leaf.serial_number
    assert alike.subject != leaf.subject
    one = str(leaf.subject.get_attributes_for_oid(NameOID.COMMON_NAME)[0].value)
    other = str(alike.subject.get_attributes_for_oid(NameOID.COMMON_NAME)[0].value)
    assert len(one) == len(other)
    assert sum(a != b for a, b in zip(one, other, strict=True)) == 1
    assert len(alike.public_bytes(serialization.Encoding.DER)) == len(tsa_pki.rsa.leaf_der)


def test_the_ber_leaf_is_ber_cryptography_refuses_it_and_the_signature_is_the_roots(tsa_pki: TsaPki) -> None:
    with pytest.raises(ValueError, match=r"(?i)critical|invalid|parse"):
        x509.load_der_x509_certificate(tsa_pki.ber_leaf)
    assert b"\x06\x03\x55\x1d\x13\x01\x01\x01" in tsa_pki.ber_leaf  # BasicConstraints critical written as 01
    assert b"\x06\x03\x55\x1d\x13\x01\x01\xff" not in tsa_pki.ber_leaf
    assert tsa_pki.ber_leaf[0] == 0x30


def test_openssl_reads_the_ber_leaf(tmp_path: Path, tsa_pki: TsaPki) -> None:
    binary = openssl_binary()
    if binary is None:
        pytest.skip(openssl_skip_reason() or "no openssl")
    import subprocess  # noqa: PLC0415 - a test cross-check, never src

    path = tmp_path / "ber.der"
    path.write_bytes(tsa_pki.ber_leaf)
    done = subprocess.run(  # noqa: S603
        [binary, "x509", "-inform", "der", "-in", str(path), "-noout", "-subject"],
        capture_output=True,
        check=False,
        timeout=30,
    )
    assert done.returncode == 0, done.stderr
    assert b"BER" in done.stdout


def test_the_pkcs12_holds_the_key_the_leaf_and_the_named_certificates(tsa_pki: TsaPki) -> None:
    data = tsa_pki.ec.pkcs12(password="pw", key_name="the-key", ca_names=("the-root",))
    loaded = pkcs12.load_pkcs12(data, b"pw")
    assert loaded.cert is not None
    assert loaded.cert.friendly_name == b"the-key"
    assert loaded.cert.certificate == tsa_pki.ec.leaf
    (extra,) = loaded.additional_certs
    assert extra.friendly_name == b"the-root"
    assert loaded.key is not None


def test_a_pkcs12_without_a_password_or_a_name_loads_without_either(tsa_pki: TsaPki) -> None:
    loaded = pkcs12.load_pkcs12(tsa_pki.rsa.pkcs12(password=None, key_name=None), None)
    assert loaded.cert is not None
    assert loaded.cert.friendly_name is None
    assert loaded.cert.certificate == tsa_pki.rsa.leaf


def test_the_pem_pair_is_written_and_an_encrypted_key_needs_its_password(tmp_path: Path, tsa_pki: TsaPki) -> None:
    key_file, cert_file = tsa_pki.ec.write_pem_pair(tmp_path, key_password="secret")
    certificates = x509.load_pem_x509_certificates(cert_file.read_bytes())
    assert [c.public_bytes(serialization.Encoding.DER) for c in certificates] == list(tsa_pki.ec.chain_der)
    key = serialization.load_pem_private_key(key_file.read_bytes(), b"secret")
    assert isinstance(key, ec.EllipticCurvePrivateKey)
    with pytest.raises(TypeError):
        serialization.load_pem_private_key(key_file.read_bytes(), None)


def test_an_identity_signs_in_the_algorithm_it_names(tsa_pki: TsaPki) -> None:
    assert tsa_pki.ec.algorithm == "ecdsa-sha256"
    assert tsa_pki.rsa.algorithm == "rsa-sha256"
    ec_public = tsa_pki.ec.leaf.public_key()
    assert isinstance(ec_public, ec.EllipticCurvePublicKey)
    ec_public.verify(tsa_pki.ec.sign(b"data"), b"data", ec.ECDSA(hashes.SHA256()))
    rsa_public = tsa_pki.rsa.leaf.public_key()
    assert isinstance(rsa_public, rsa.RSAPublicKey)
    rsa_public.verify(tsa_pki.rsa.sign(b"data"), b"data", padding.PKCS1v15(), hashes.SHA256())


def test_bytes_to_pem_round_trips() -> None:
    pem = bytes_to_pem(b"\x30\x03\x02\x01\x05", "THING")
    assert pem.startswith(b"-----BEGIN THING-----\n")
    assert pem.endswith(b"-----END THING-----\n")


def test_two_builds_never_share_a_key() -> None:
    assert build_pki().ec.leaf_der != build_pki().ec.leaf_der


# -- requires_openssl --------------------------------------------------------------------------------------------------
def test_the_binary_is_found_on_the_path_or_by_the_environment_variable(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv(OPENSSL_ENV, raising=False)
    found = openssl_binary()
    assert (found is None) == (openssl_skip_reason() is not None)
    monkeypatch.setenv(OPENSSL_ENV, "/nonexistent/openssl")
    assert openssl_binary() is None
    reason = openssl_skip_reason()
    assert reason is not None
    assert OPENSSL_ENV in reason
    assert "/nonexistent/openssl" in reason


def test_a_missing_binary_with_no_override_says_how_to_name_one(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv(OPENSSL_ENV, raising=False)
    monkeypatch.setenv("PATH", "/nonexistent")
    reason = openssl_skip_reason()
    assert reason is not None
    assert OPENSSL_ENV in reason
    assert "PATH" in reason


def test_requires_openssl_marks_the_test_and_skips_it_with_a_reason_when_the_binary_is_absent(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv(OPENSSL_ENV, "/nonexistent/openssl")

    @requires_openssl
    def case() -> None: ...

    marks = {mark.name: mark for mark in getattr(case, "pytestmark", [])}
    assert "openssl" in marks
    assert marks["skipif"].args == (True,)
    assert "names no executable openssl binary" in marks["skipif"].kwargs["reason"]


def test_requires_openssl_does_not_skip_when_the_binary_is_there(monkeypatch: pytest.MonkeyPatch) -> None:
    if openssl_binary() is None:
        pytest.skip("no openssl here to prove the other branch")
    monkeypatch.delenv(OPENSSL_ENV, raising=False)

    @requires_openssl
    def case() -> None: ...

    marks = {mark.name: mark for mark in getattr(case, "pytestmark", [])}
    assert marks["skipif"].args == (False,)
    assert "openssl" in marks


class FakeItem:
    def __init__(self, *marks: str) -> None:
        self.marks = set(marks)
        self.added: list[object] = []

    def get_closest_marker(self, name: str) -> object | None:
        return object() if name in self.marks else None

    def add_marker(self, mark: object) -> None:
        self.added.append(mark)


def test_skip_openssl_under_xdist_skips_only_marked_items_and_only_in_a_worker() -> None:
    marked, plain = FakeItem("openssl"), FakeItem()
    items: list[pytest.Item] = [marked, plain]  # type: ignore[list-item]
    worker = SimpleNamespace(workerinput={})
    assert skip_openssl_under_xdist(worker, items) == 1  # type: ignore[arg-type]
    assert len(marked.added) == 1
    assert plain.added == []


def test_the_hook_does_nothing_outside_a_worker() -> None:
    marked = FakeItem("openssl")
    items: list[pytest.Item] = [marked]  # type: ignore[list-item]
    assert skip_openssl_under_xdist(SimpleNamespace(), items) == 0  # type: ignore[arg-type]
    assert marked.added == []


# -- the contracts have teeth ------------------------------------------------------------------------------------------
class RepeatingAllocator:
    def allocate(self) -> int:
        return 7


class ReusingAllocator:
    """Hands out increasing serials but two racing threads can get the same one (no lock)."""

    def __init__(self) -> None:
        self._next = 1

    def allocate(self) -> int:
        value = self._next
        time.sleep(0.0005)
        self._next = value + 1
        return value


class OversizedAllocator:
    def __init__(self) -> None:
        self._n = 2**170

    def allocate(self) -> int:
        self._n += 1
        return self._n


class ZeroAllocator:
    def allocate(self) -> int:
        return 0


@pytest.mark.parametrize(
    ("store", "case"),
    [
        (RepeatingAllocator, "test_serials_increase_strictly_in_one_thread"),
        (ReusingAllocator, "test_a_serial_is_never_reused_by_threads_racing_for_them"),
        (OversizedAllocator, "test_a_serial_is_a_positive_integer_within_160_bits"),
        (ZeroAllocator, "test_a_serial_is_a_positive_integer_within_160_bits"),
    ],
)
def test_the_allocator_contract_fails_a_store_that_breaks_a_rule(store: type, case: str) -> None:
    with pytest.raises(AssertionError):
        getattr(TsaSerialAllocatorContract(), case)(store())


class OldestFirstLog:
    def __init__(self) -> None:
        self.rows: list[TsaLogEntry] = []

    def append(self, entry: TsaLogEntry) -> None:
        self.rows.append(entry)

    def recent(self, limit: int) -> tuple[TsaLogEntry, ...]:
        return tuple(self.rows[:limit])


class LossyLog(OldestFirstLog):
    """Drops rows appended while another thread appends (a check-then-act race)."""

    def append(self, entry: TsaLogEntry) -> None:
        snapshot = list(self.rows)
        time.sleep(0.0003)
        self.rows = [*snapshot, entry]

    def recent(self, limit: int) -> tuple[TsaLogEntry, ...]:
        return tuple(reversed(self.rows))[: max(limit, 0)]


class NegativeLimitLog(OldestFirstLog):
    def recent(self, limit: int) -> tuple[TsaLogEntry, ...]:
        return tuple(reversed(self.rows))[:limit] if limit else tuple(self.rows)


@pytest.mark.parametrize(
    ("store", "case"),
    [
        (OldestFirstLog, "test_entries_come_back_newest_first_and_the_limit_cuts_the_oldest"),
        (LossyLog, "test_threads_appending_together_lose_nothing"),
        (NegativeLimitLog, "test_a_zero_limit_reads_nothing"),
    ],
)
def test_the_log_contract_fails_a_store_that_breaks_a_rule(store: type, case: str) -> None:
    with pytest.raises(AssertionError):
        getattr(TsaLogContract(), case)(store())


class KeyedByText:
    """A client store that returns the key text as the client id."""

    def __init__(self, hashes: list[str], revoked: list[str] | None = None) -> None:
        self._hashes = set(hashes)
        self._revoked = set(revoked or [])

    def find(self, hash_: str) -> TsaClientRecord | None:
        return TsaClientRecord(hash_, hash_ in self._revoked) if hash_ in self._hashes else None

    def record_use(self, client_id: str, at: datetime) -> None:
        return


class SameIdForAll(KeyedByText):
    def find(self, hash_: str) -> TsaClientRecord | None:
        return TsaClientRecord("client", False) if hash_ in self._hashes else None


class IgnoresRevocation(KeyedByText):
    def find(self, hash_: str) -> TsaClientRecord | None:
        return TsaClientRecord(f"id-{hash_[:8]}", False) if hash_ in self._hashes else None


class RaisesOnOddHash(KeyedByText):
    def find(self, hash_: str) -> TsaClientRecord | None:
        if len(hash_) != 64:
            raise ValueError(hash_)
        return TsaClientRecord(f"id-{hash_[:8]}", False) if hash_ in self._hashes else None


@pytest.mark.parametrize(
    ("store", "case"),
    [
        (KeyedByText, "test_the_client_id_is_neither_the_key_nor_its_hash"),
        (SameIdForAll, "test_the_client_id_is_stable_and_differs_between_clients"),
        (IgnoresRevocation, "test_a_revoked_client_is_found_and_says_so"),
        (RaisesOnOddHash, "test_a_hash_that_is_not_hex_finds_nobody_and_does_not_raise"),
    ],
)
def test_the_client_contract_fails_a_store_that_breaks_a_rule(store: type, case: str) -> None:
    def factory(hashes: list[str], revoked: tuple[str, ...] = ()) -> object:
        return store(list(hashes), list(revoked))

    with pytest.raises((AssertionError, ValueError)):
        getattr(TsaClientStoreContract(), case)(factory)


def test_the_key_helpers_make_a_prefixed_key_and_its_lowercase_hex_hash() -> None:
    assert key_text(1).startswith("dtsa_")
    assert len(key_text(1)) == 5 + 43
    assert len(key_hash(key_text(1))) == 64
    assert key_hash(key_text(1)) != key_hash(key_text(2))
