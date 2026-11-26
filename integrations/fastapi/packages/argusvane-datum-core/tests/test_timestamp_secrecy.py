"""The private key and both passwords never leave their objects.

Nothing the timestamp package, `Datum` or the settings expose may carry the PKCS#12 password, the PEM key's password,
the private key's PEM, its PKCS#8 DER or (for EC) its private scalar: not in `repr` or `str`, not in a public
attribute (a probe walks every public attribute, instance slot and container, four levels deep), not in a log record
(DEBUG, through `caplog`, with the message, the arguments, the extras and the formatted traceback), not in an event,
the health body or `info()`, not in the message, hint, arguments or chain of a refusal. The library's own key object is
opaque and is the only place the key lives: the loader keeps no bytes copy of it.
"""

import json
import logging
import traceback
from collections.abc import Iterable, Iterator, Mapping
from pathlib import Path
from typing import cast

import pytest
from tsa_der import query_der
from tsa_support import (
    KEY_PASSWORD,
    P12_PASSWORD,
    leaks,
    make_authority,
    pem_signer,
    pkcs12_signer,
    plain_tsa_datum,
    query_of,
    secrets_of,
    sha256,
    tsa_config,
    with_fields,
)

from datum_core.config.models import TsaSigner
from datum_core.testing.tsa_pki import INSTANT, TsaIdentity, TsaPki
from datum_core.timestamp import KeyFileTsaKeyMaterial, SelfSignedTsaCertificate, TimestampQuery
from datum_sandbox.checks import DatumConfigurationError

WRONG_PASSWORD = "wrong-ZZ-guess-ZZ"
DEPTH = 4


LEAVES = (str, int, float, bool, type(None), bytes, bytearray)


def children_of(obj: object) -> list[object]:
    """The values reachable from `obj` one step on: container items, public attributes, instance slots."""
    if isinstance(obj, Mapping):
        return [*obj.keys(), *obj.values()]
    if isinstance(obj, (list, tuple, set, frozenset)):
        return list(cast("Iterable[object]", obj))
    names = {name for name in dir(obj) if not name.startswith("__")}
    for klass in type(obj).__mro__:
        slots = getattr(klass, "__slots__", ())
        names.update([slots] if isinstance(slots, str) else slots)
    names.update(getattr(obj, "__dict__", {}))
    values: list[object] = []
    for name in sorted(names):
        try:
            value = getattr(obj, name)
        except Exception:  # noqa: S112 - a property that raises exposes nothing
            continue
        if not callable(value):
            values.append(value)
    return values


def exposed(obj: object, *, depth: int = DEPTH, seen: set[int] | None = None) -> Iterator[str]:
    """Yield the text of `obj` and of everything reachable through its public attributes, slots and containers."""
    seen = set() if seen is None else seen
    if id(obj) in seen:
        return
    seen.add(id(obj))
    if isinstance(obj, (bytes, bytearray)):
        yield repr(bytes(obj))
        yield bytes(obj).hex()
    else:
        yield repr(obj)
        yield str(obj)
    opaque = type(obj).__module__.startswith("cryptography")  # the library's key object: only its repr can leak
    if depth == 0 or opaque or isinstance(obj, LEAVES):
        return
    for child in children_of(obj):
        yield from exposed(child, depth=depth - 1, seen=seen)


def held_by(obj: object) -> list[object]:
    """What an object keeps in its instance dictionary and its slots (not what its properties compute)."""
    names = list(getattr(obj, "__dict__", {}))
    for klass in type(obj).__mro__:
        slots = getattr(klass, "__slots__", ())
        names += [slots] if isinstance(slots, str) else list(slots)
    return [getattr(obj, name) for name in names if hasattr(obj, name)]


def assert_clean(obj: object, forbidden: list[str | bytes], what: str = "object") -> None:
    found = leaks("\n".join(exposed(obj)), forbidden)
    assert not found, f"{what} exposes {found}"


def log_text(caplog: pytest.LogCaptureFixture) -> str:
    """Every record's message, arguments, extras and formatted traceback."""
    parts: list[str] = [caplog.text]
    for record in caplog.records:
        parts.append(record.getMessage())
        parts.append(str(record.args))
        parts.append(str({k: v for k, v in vars(record).items() if k.startswith("datum_")}))
        if record.exc_info:
            parts.append("".join(traceback.format_exception(*record.exc_info)))
        if record.exc_text:
            parts.append(record.exc_text)
    return "\n".join(parts)


def chain_text(error: BaseException) -> str:
    """The message, hint, arguments, repr, traceback text and every chained exception."""
    parts: list[str] = []
    current: BaseException | None = error
    for _ in range(10):
        if current is None:
            break
        parts += [str(current), repr(current), getattr(current, "hint", ""), *map(str, current.args)]
        parts.append("".join(traceback.format_exception(current)))
        current = current.__cause__ or current.__context__
    return "\n".join(parts)


@pytest.fixture
def forbidden(tsa_pki: TsaPki) -> list[str | bytes]:
    return [*secrets_of(tsa_pki.ec, P12_PASSWORD, KEY_PASSWORD, WRONG_PASSWORD), *secrets_of(tsa_pki.rsa)]


def loaded(tmp_path: Path, identity: TsaIdentity, kind: str) -> KeyFileTsaKeyMaterial:
    if kind == "pkcs12":
        return KeyFileTsaKeyMaterial.from_settings(pkcs12_signer(tmp_path, identity, friendly_name="datum-tsa"))
    return KeyFileTsaKeyMaterial.from_settings(pem_signer(tmp_path, identity, key_password=KEY_PASSWORD))


# -- the key material --------------------------------------------------------------------------------------------------
@pytest.mark.parametrize("kind", ["pkcs12", "pem"])
@pytest.mark.parametrize("which", ["ec", "rsa"])
def test_the_loaded_key_material_shows_no_secret_in_any_public_attribute(
    tmp_path: Path, tsa_pki: TsaPki, forbidden: list[str | bytes], kind: str, which: str
) -> None:
    identity = tsa_pki.ec if which == "ec" else tsa_pki.rsa
    assert_clean(loaded(tmp_path, identity, kind), forbidden, "the key material")


@pytest.mark.parametrize("kind", ["pkcs12", "pem"])
def test_the_loader_keeps_the_key_only_as_the_librarys_object_and_no_password(
    tmp_path: Path, tsa_pki: TsaPki, forbidden: list[str | bytes], kind: str
) -> None:
    material = loaded(tmp_path, tsa_pki.ec, kind)
    held = held_by(material)
    for value in held:
        assert not isinstance(value, (bytes, bytearray)) or value in tsa_pki.ec.chain_der
        assert type(value).__name__ != "SecretStr"
    assert_clean(held, forbidden, "what the loader keeps")


def test_the_self_signed_material_keeps_the_key_only_as_the_librarys_object() -> None:
    material = SelfSignedTsaCertificate.generate(INSTANT)
    assert_clean(material, ["PRIVATE KEY", "BEGIN"], "the self-signed material")
    for value in held_by(material):
        assert not isinstance(value, (bytes, bytearray)) or value in material.chain_der


def test_pickling_the_key_material_is_refused_or_carries_no_key(tmp_path: Path, tsa_pki: TsaPki) -> None:
    import pickle  # noqa: PLC0415

    material = loaded(tmp_path, tsa_pki.ec, "pkcs12")
    try:
        blob = pickle.dumps(material)
    except TypeError:  # the refusal; any other exception fails the test
        return
    assert not leaks(blob.decode("latin-1"), secrets_of(tsa_pki.ec, P12_PASSWORD))


# -- the authority and every value it hands out ------------------------------------------------------------------------
def test_the_authority_and_what_it_returns_show_no_secret(
    tmp_path: Path, tsa_pki: TsaPki, forbidden: list[str | bytes]
) -> None:
    material = loaded(tmp_path, tsa_pki.ec, "pkcs12")
    authority = make_authority(tsa_pki.ec, key=material)
    grant = authority.issue(query_of(nonce=0x5EC12E7))
    refused = authority.answer(query_der(b"\x01" * 20, algorithm_oid="1.3.14.3.2.26"))
    granted = authority.answer(query_der(sha256(b"x")))
    for obj in (authority, grant, refused, granted, refused.refusal):
        assert_clean(obj, forbidden, type(obj).__name__)


def test_the_query_the_token_and_the_refusal_show_no_secret(tsa_pki: TsaPki, forbidden: list[str | bytes]) -> None:
    from datum_core.timestamp import TimestampToken  # noqa: PLC0415

    authority = make_authority(tsa_pki.ec)
    grant = authority.issue(query_of())
    for obj in (query_of(), TimestampToken.parse(grant.token)):
        assert_clean(obj, forbidden, type(obj).__name__)


# -- settings ----------------------------------------------------------------------------------------------------------
def test_the_settings_show_no_password_in_any_dump(
    tmp_path: Path, tsa_pki: TsaPki, forbidden: list[str | bytes]
) -> None:
    config = tsa_config(
        allow_memory_stores=True,
        signer={**pkcs12_signer(tmp_path, tsa_pki.ec, key_password=KEY_PASSWORD).model_dump(mode="python")},
    )
    texts = [repr(config), str(config), repr(config.tsa), repr(config.tsa.signer), config.model_dump_json()]
    texts.append(json.dumps(config.model_dump(mode="json")))
    texts.append(config.tsa.signer.model_dump_json())
    for text in texts:
        assert not leaks(text, forbidden)


def test_the_environment_settings_show_no_password(
    tmp_path: Path, tsa_pki: TsaPki, monkeypatch: pytest.MonkeyPatch, forbidden: list[str | bytes]
) -> None:
    from datum_fastapi import DatumSettings  # noqa: PLC0415 - the binding's env loader

    monkeypatch.setenv("DATUM_TSA__ENABLED", "true")
    monkeypatch.setenv("DATUM_TSA__SIGNER__PKCS12_FILE", str(tmp_path / "x.p12"))
    monkeypatch.setenv("DATUM_TSA__SIGNER__PKCS12_PASSWORD", P12_PASSWORD)
    monkeypatch.setenv("DATUM_TSA__SIGNER__KEY_PASSWORD", KEY_PASSWORD)
    settings = DatumSettings()
    for text in (repr(settings), str(settings), settings.model_dump_json(), repr(settings.to_config())):
        assert not leaks(text, forbidden)


# -- logs --------------------------------------------------------------------------------------------------------------
def test_loading_issuing_and_refusing_write_no_secret_to_any_log(
    tmp_path: Path, tsa_pki: TsaPki, forbidden: list[str | bytes], caplog: pytest.LogCaptureFixture
) -> None:
    with caplog.at_level(logging.DEBUG):
        for identity, kind in ((tsa_pki.ec, "pkcs12"), (tsa_pki.rsa, "pem")):
            material = loaded(tmp_path, identity, kind)
            authority = make_authority(identity, key=material)
            authority.issue(query_of())
            authority.answer(b"garbage")
            authority.answer(query_der(sha256(b"x"), policy="1.2.3.4"))
    assert not leaks(log_text(caplog), forbidden)


def test_a_failed_load_writes_no_secret_to_any_log_and_its_error_carries_none(
    tmp_path: Path, tsa_pki: TsaPki, forbidden: list[str | bytes], caplog: pytest.LogCaptureFixture
) -> None:
    good = pkcs12_signer(tmp_path, tsa_pki.ec)
    cases = [
        with_fields(good, pkcs12_password=WRONG_PASSWORD),
        with_fields(good, pkcs12_password=None),
        with_fields(good, pkcs12_file=str(tmp_path / "gone.p12")),
        with_fields(good, friendly_name="not-this-one"),
        TsaSigner.model_validate(
            {"type": "PEM", "key_file": str(tmp_path / "gone.pem"), "cert_file": str(tmp_path / "gone2.pem")}
        ),
    ]
    names = ["pkcs12_password", "pkcs12_password", "pkcs12_file", "friendly_name", None]
    with caplog.at_level(logging.DEBUG):
        for signer, name in zip(cases, names, strict=True):
            with pytest.raises(DatumConfigurationError) as raised:
                KeyFileTsaKeyMaterial.from_settings(signer)
            if name is not None:
                assert name in str(raised.value)
            assert not leaks(chain_text(raised.value), forbidden)
    assert not leaks(log_text(caplog), forbidden)


def test_starting_and_stopping_a_datum_over_a_pkcs12_key_writes_no_secret_to_any_log(
    tmp_path: Path, tsa_pki: TsaPki, forbidden: list[str | bytes], caplog: pytest.LogCaptureFixture
) -> None:
    signer = pkcs12_signer(tmp_path, tsa_pki.ec, friendly_name="datum-tsa")
    datum = plain_tsa_datum(tsa_config(allow_memory_stores=True, signer=signer.model_dump(mode="python")))
    with caplog.at_level(logging.DEBUG):
        datum.start()
        try:
            authority = datum.timestamp_authority
            assert authority is not None
            authority.issue(TimestampQuery.of(sha256(b"x"), "sha256", nonce=7))
            authority.answer(b"garbage")
            datum.health()
            datum.info()
        finally:
            datum.stop()
    assert not leaks(log_text(caplog), forbidden)


def test_a_failed_start_over_a_wrong_password_writes_no_secret_to_any_log(
    tmp_path: Path, tsa_pki: TsaPki, forbidden: list[str | bytes], caplog: pytest.LogCaptureFixture
) -> None:
    signer = with_fields(pkcs12_signer(tmp_path, tsa_pki.ec), pkcs12_password=WRONG_PASSWORD)
    datum = plain_tsa_datum(tsa_config(allow_memory_stores=True, signer=signer.model_dump(mode="python")))
    with caplog.at_level(logging.DEBUG), pytest.raises(DatumConfigurationError) as raised:
        datum.start()
    assert not leaks(chain_text(raised.value), forbidden)
    assert not leaks(log_text(caplog), forbidden)


# -- the running datum -------------------------------------------------------------------------------------------------
def test_health_info_and_the_datum_itself_show_no_secret(
    tmp_path: Path, tsa_pki: TsaPki, forbidden: list[str | bytes]
) -> None:
    signer = pkcs12_signer(tmp_path, tsa_pki.ec, friendly_name="datum-tsa")
    datum = plain_tsa_datum(tsa_config(allow_memory_stores=True, signer=signer.model_dump(mode="python")))
    datum.start()
    try:
        bodies = [json.dumps(datum.health().to_json()), json.dumps(datum.info()), repr(datum), str(datum.config)]
        for text in bodies:
            assert not leaks(text, forbidden)
        assert_clean(datum.timestamp_authority, forbidden, "the authority")
        assert_clean(datum.timestamp_gate, forbidden, "the gate")
    finally:
        datum.stop()


def test_events_carry_scalars_and_no_secret(tmp_path: Path, tsa_pki: TsaPki, forbidden: list[str | bytes]) -> None:
    from datum_core.events import DatumEvent, EventDispatcher  # noqa: PLC0415

    seen: list[DatumEvent] = []
    authority = make_authority(
        tsa_pki.ec,
        key=loaded(tmp_path, tsa_pki.ec, "pkcs12"),
        events=EventDispatcher([(DatumEvent, seen.append)]),
    )
    authority.issue(query_of(), client="client-1")
    authority.answer(b"garbage")
    assert len(seen) == 2
    for event in seen:
        assert_clean(event, forbidden, type(event).__name__)


def test_the_probe_itself_finds_a_leak_so_a_clean_result_means_something() -> None:
    class Leaky:
        def __init__(self) -> None:
            self.token = "hunter2-ZZ"

        @property
        def public(self) -> str:
            return "prefix hunter2-ZZ suffix"

    assert leaks("\n".join(exposed(Leaky())), ["hunter2-ZZ"])
    assert not leaks("\n".join(exposed(object())), ["hunter2-ZZ"])
    assert leaks("\n".join(exposed({"a": [b"hunter2-ZZ"]})), [b"hunter2-ZZ"])
