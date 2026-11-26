"""The guest module is re-hashed at load: the pin, an own copy with its digest, and a mismatch naming both digests."""

import hashlib
from pathlib import Path

import pytest

from datum_sandbox.wasi import EngineConfigurationError
from datum_sandbox_wasmtime._qjs import load_qjs, pinned


def test_the_packaged_module_matches_its_pin() -> None:
    want, version = pinned()
    qjs = load_qjs()
    assert qjs.sha256 == want
    assert hashlib.sha256(qjs.data).hexdigest() == want
    assert version == qjs.version
    assert qjs.data[:4] == b"\0asm"


def test_an_own_copy_with_its_digest_is_used(tmp_path: Path) -> None:
    copy = tmp_path / "qjs-wasi.wasm"
    copy.write_bytes(load_qjs().data)
    assert load_qjs(copy).source == str(copy), "without a digest the pin is the expected one"
    assert load_qjs(copy, pinned()[0].upper()).sha256 == pinned()[0], "a digest is compared case-insensitively"


def test_a_tampered_copy_is_refused_naming_both_digests(tmp_path: Path) -> None:
    copy = tmp_path / "qjs-wasi.wasm"
    data = bytearray(load_qjs().data)
    data[-1] ^= 1
    copy.write_bytes(bytes(data))
    with pytest.raises(EngineConfigurationError) as caught:
        load_qjs(copy)
    assert hashlib.sha256(bytes(data)).hexdigest() in caught.value.message
    assert pinned()[0] in caught.value.message


def test_a_copy_whose_digest_is_not_the_given_one_is_refused(tmp_path: Path) -> None:
    copy = tmp_path / "qjs-wasi.wasm"
    copy.write_bytes(load_qjs().data)
    with pytest.raises(EngineConfigurationError) as caught:
        load_qjs(copy, "0" * 64)
    assert "datum.runtime.qjs_sha256" in caught.value.message
    assert "0" * 64 in caught.value.message


def test_a_missing_copy_is_refused_naming_the_setting(tmp_path: Path) -> None:
    with pytest.raises(EngineConfigurationError) as caught:
        load_qjs(tmp_path / "absent.wasm")
    assert "datum.runtime.qjs_path" in caught.value.message
