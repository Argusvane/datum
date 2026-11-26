"""`KeyFileTsaKeyMaterial`: the timestamp server's signing key and chain, read once from the files the settings name.

`datum.tsa.signer.type` is `PKCS12` (`pkcs12_file`, `pkcs12_password`, `friendly_name`) or `PEM` (`key_file`,
`key_password`, `cert_file`). An empty password is no password (None), for both kinds. The files are read ONCE, at
start: a renewed key takes a restart (list the replaced certificate in `datum.tsa.retired_certificates`). The start
refuses, with a `DatumConfigurationError` that names the setting and never a password, a path's content or a key byte,
when:

- a setting is set that cannot apply to the chosen type (`friendly_name`, `pkcs12_file` or `pkcs12_password` with
  `PEM`; `key_password`, `key_file` or `cert_file` with `PKCS12`: the key of a PKCS#12 store is opened by
  `pkcs12_password` and the store holds the chain); the message names it;
- the file is missing or unreadable, a password is wrong or missing, the store or the key is not what it should be;
- more than one returned certificate carries a friendly name (OpenSSL's first-key-wins rule would then decide), or a set
  `friendly_name` is not the key's certificate's (the message names both); `friendly_name` is a check, never a selector;
- the chain's first certificate is not the key's certificate;
- the key is one the signer cannot use, the signing certificate's serial is negative (RFC 5280 forbids it), or the
  certificate breaks `TsaCertificateRules`.

The ONE loader is `load_signing_key`: every rule above except `TsaCertificateRules` (a timestamp key's own rule, passed
in as `leaf_rule`) lives there, parametrised by the setting it names, and the PDF seal key's loader calls it too, so the
two key files are read and refused by the same code. A refusal is raised only from a frame
that no longer holds the key object, and nothing is built until every check has passed.

Libraries: `cryptography` (`pkcs12.load_pkcs12`, `load_pem_private_key`, `load_pem_x509_certificates`) does all the
parsing; the key stays its object inside `TsaSigningKey`. The only code written here is the friendly-name check and the
chain assembly, which no library offers. Both passwords are `SecretStr` and are unwrapped in one place (`_reveal`).

Only `KeyFileTsaKeyMaterial.from_settings` runs these checks for a timestamp key (through `load_signing_key`): the
class's constructor (inherited from `TsaSigningKey`) checks only that the key is one it can sign with and the chain is
not empty, never that the leaf is the key's certificate or keeps `TsaCertificateRules`, so code that builds one directly
owns those checks.
"""

from collections.abc import Callable
from pathlib import Path
from typing import Final, Self

from cryptography import x509
from cryptography.exceptions import UnsupportedAlgorithm
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec, rsa
from cryptography.hazmat.primitives.asymmetric.types import PrivateKeyTypes, PublicKeyTypes
from cryptography.hazmat.primitives.serialization import pkcs12
from cryptography.x509.oid import PublicKeyAlgorithmOID
from pydantic import SecretStr

from datum_core.config.models import KeyType, Signing, TsaSigner
from datum_core.timestamp.certificate import (
    PROBLEM_TEXT,
    TsaCertificateRules,
    TsaPrivateKey,
    TsaSigningKey,
    algorithm_of,
    read_limited,
)
from datum_sandbox.checks import DatumConfigurationError

__all__ = ["KeyFileSettings", "KeyFileTsaKeyMaterial", "load_signing_key"]

type KeyFileSettings = TsaSigner | Signing
"""A settings section that names a key file: `datum.tsa.signer` or `datum.pdf.signing` (the same key fields)."""

_SETTING: Final = "datum.tsa.signer"


def _refuse(setting: str, message: str) -> DatumConfigurationError:
    return DatumConfigurationError(
        message, hint=f"fix {setting}; a key is read once at start, so a renewed key takes a restart"
    )


def _reveal(secret: SecretStr | None) -> bytes | None:
    """Return a password's bytes, or None when there is none (an empty password is none).

    The one place a `SecretStr` is unwrapped.
    """
    return (None if secret is None else secret.get_secret_value().encode()) or None


_FOREIGN: Final = {
    KeyType.PEM: ("friendly_name", "pkcs12_file", "pkcs12_password"),
    KeyType.PKCS12: ("key_password", "key_file", "cert_file"),
}
"""The settings that cannot apply to each signer type; one that is set stops the start."""


def _refuse_foreign_settings(settings: KeyFileSettings, setting: str) -> None:
    """Refuse a setting the chosen type cannot use; an empty value counts as not set (an empty password is none)."""
    for name in _FOREIGN[settings.type]:
        value: object = getattr(settings, name)
        if isinstance(value, SecretStr) and _reveal(value) is None:
            continue
        if value is not None:
            raise _refuse(setting, f"{setting}.{name} cannot apply to a {settings.type.value} signer; remove it.")


def _read(setting: str, name: str, path: str | None) -> bytes:
    """Return the file the setting names; refuse when it is not set or cannot be read."""
    if not path:
        raise _refuse(setting, f"{setting}.{name} is not set.")
    data = read_limited(Path(path))
    if data is None:
        raise _refuse(
            setting, f"{setting}.{name} names a file that cannot be read (missing, unreadable or over 1 MiB)."
        )
    return data


def _name_of(entry: pkcs12.PKCS12Certificate | None) -> str | None:
    if entry is None or entry.friendly_name is None:
        return None
    return entry.friendly_name.decode("utf-8", errors="replace")


def _friendly_name_problem(
    settings: KeyFileSettings,
    setting: str,
    key_entry: pkcs12.PKCS12Certificate,
    all_entries: list[pkcs12.PKCS12Certificate],
) -> str | None:
    """Name more than one named certificate, or a set friendly name that is not the key certificate's; else None."""
    named = [entry for entry in all_entries if entry.friendly_name is not None]
    if len(named) > 1:
        return (
            f"{setting}.pkcs12_file holds {len(named)} certificates with a friendly name; "
            "which key OpenSSL returns then depends on its order, so only one certificate may carry one."
        )
    wanted = settings.friendly_name
    if wanted is None:
        return None
    found = _name_of(key_entry)
    if found != wanted:
        shown = repr(found) if found is not None else "none"
        return (
            f"{setting}.friendly_name is {wanted!r} but the key's certificate in {setting}.pkcs12_file "
            f"has the friendly name {shown}; the name is a check, it does not select a certificate."
        )
    return None


def _open_pkcs12(settings: KeyFileSettings, setting: str) -> pkcs12.PKCS12KeyAndCertificates | None:
    """Return the opened store, or None; never raises once the bytes are read, so no frame of a refusal holds them."""
    data = _read(setting, "pkcs12_file", settings.pkcs12_file)
    try:
        return pkcs12.load_pkcs12(data, _reveal(settings.pkcs12_password))
    except (ValueError, TypeError, UnsupportedAlgorithm):
        return None


def _open_pem_key(settings: KeyFileSettings, setting: str) -> PrivateKeyTypes | None:
    """Return the PEM private key, or None.

    It never raises once the bytes are read, so no frame of a refusal holds them.
    """
    key_data = _read(setting, "key_file", settings.key_file)
    try:
        return serialization.load_pem_private_key(key_data, _reveal(settings.key_password))
    except (ValueError, TypeError, UnsupportedAlgorithm):
        return None


def _open_pem_certificates(settings: KeyFileSettings, setting: str) -> list[x509.Certificate]:
    """Return the PEM certificates (empty when none parse); the file's bytes stay in this frame."""
    cert_data = _read(setting, "cert_file", settings.cert_file)
    try:
        return x509.load_pem_x509_certificates(cert_data)
    except ValueError:
        return []


def _from_pkcs12(settings: KeyFileSettings, setting: str) -> tuple[PrivateKeyTypes, list[x509.Certificate]]:
    bundle = _open_pkcs12(settings, setting)
    if bundle is None:
        raise _refuse(
            setting, f"{setting}.pkcs12_file is not a PKCS#12 store, or {setting}.pkcs12_password does not open it."
        )
    key, key_entry = bundle.key, bundle.cert
    entries = [] if key_entry is None else [key_entry, *bundle.additional_certs]
    del bundle
    problem: str | None = None
    if key is None:
        problem = f"{setting}.pkcs12_file holds no private key."
    elif key_entry is None:
        problem = f"{setting}.pkcs12_file holds no certificate for its private key."
    else:
        problem = _friendly_name_problem(settings, setting, key_entry, entries)
    if key is None or problem is not None:
        del key  # the refusal's frames never hold the key
        raise _refuse(setting, problem or "")
    return key, [entry.certificate for entry in entries]


def _from_pem(settings: KeyFileSettings, setting: str) -> tuple[PrivateKeyTypes, list[x509.Certificate]]:
    missing = [name for name in ("key_file", "cert_file") if not getattr(settings, name)]
    if missing:
        raise _refuse(setting, f"{', '.join(f'{setting}.{name}' for name in missing)} must be set for a PEM signer.")
    key = _open_pem_key(settings, setting)
    try:
        certificates = _open_pem_certificates(settings, setting)
    except DatumConfigurationError:
        del key  # the refusal's frames never hold the key
        raise
    problem: str | None = None
    if key is None:
        problem = (
            f"{setting}.key_file does not hold a usable PEM private key, or {setting}.key_password "
            "is missing, wrong or given for a key that is not encrypted."
        )
    elif not certificates:
        problem = f"{setting}.cert_file holds no PEM certificate."
    if key is None or problem is not None:
        del key
        raise _refuse(setting, problem or "")
    return key, certificates


def _key_problem(key: TsaPrivateKey | None, certificates: list[x509.Certificate], setting: str) -> str | None:
    """Name the first rule the key and its chain break (the key, the leaf, the serial), or None."""
    if key is None or algorithm_of(key) is None:
        return f"{setting}: {PROBLEM_TEXT['key']}."
    leaf = certificates[0]
    try:
        leaf_spki = _spki(leaf.public_key())
    except (ValueError, UnsupportedAlgorithm):
        return (
            f"{setting}: the first certificate (the leaf) cannot be read as the certificate of the private key; "
            "list the key's own certificate first."
        )
    if leaf_spki != _spki(key.public_key()):
        return (
            f"{setting}: the first certificate (the leaf) is not the certificate of the private key; "
            "list the key's own certificate first."
        )
    if leaf.public_key_algorithm_oid not in (
        PublicKeyAlgorithmOID.RSAES_PKCS1_v1_5,
        PublicKeyAlgorithmOID.EC_PUBLIC_KEY,
    ):
        return f"{setting}: {PROBLEM_TEXT['key']}."
    if leaf.serial_number < 0:
        return f"{setting}: the signing certificate's serial is negative, which RFC 5280 forbids."
    return None


def load_signing_key[K: TsaSigningKey](
    settings: KeyFileSettings,
    *,
    setting: str,
    holder: type[K],
    leaf_rule: Callable[[bytes], str | None] | None = None,
) -> K:
    """Read the key and the chain `settings` names ONCE, check them, and return them held by `holder`.

    `setting` is the dotted name every refusal names (`datum.tsa.signer`, `datum.pdf.signing`); `leaf_rule` is a
    further rule for the signer's DER certificate that answers a refusal sentence or None. Every check runs before
    `holder` is built, so a refusal leaves nothing half-built, and it is raised from a frame that no longer holds the
    key. The checks are the module's (all but `TsaCertificateRules`, which a timestamp key passes as `leaf_rule`).
    """
    _refuse_foreign_settings(settings, setting)
    loaded = _from_pkcs12(settings, setting) if settings.type is KeyType.PKCS12 else _from_pem(settings, setting)
    found, certificates = loaded
    del loaded
    key = found if isinstance(found, ec.EllipticCurvePrivateKey | rsa.RSAPrivateKey) else None
    del found
    problem = _key_problem(key, certificates, setting)
    chain = tuple(item.public_bytes(serialization.Encoding.DER) for item in certificates)
    if problem is None and leaf_rule is not None:
        problem = leaf_rule(chain[0])
    if key is None or problem is not None:
        del key  # the refusal's frames never hold the key
        raise _refuse(setting, problem or f"{setting}: {PROBLEM_TEXT['key']}.")
    return holder(key, chain)


def _tsa_rules(certificate_der: bytes) -> str | None:
    """Name the `TsaCertificateRules` the timestamp key's certificate breaks, or None."""
    rules = TsaCertificateRules()
    problems = rules.problems(certificate_der)
    return f"{_SETTING}: the key's certificate breaks the rules: {rules.explain(problems)}." if problems else None


class KeyFileTsaKeyMaterial(TsaSigningKey):
    """The signing key and chain read from the files `datum.tsa.signer` names; see the module text for the refusals."""

    __slots__ = ()

    @classmethod
    def from_settings(cls, signer: TsaSigner) -> Self:
        """Read the key and the chain once and check them; nothing is kept if any check fails.

        This is the only checking path: the constructor never matches the leaf to the key or applies the rules.
        """
        return load_signing_key(signer, setting=_SETTING, holder=cls, leaf_rule=_tsa_rules)


def _spki(public_key: PublicKeyTypes) -> bytes:
    """Return a public key's SubjectPublicKeyInfo DER (what two keys are compared by)."""
    return public_key.public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
