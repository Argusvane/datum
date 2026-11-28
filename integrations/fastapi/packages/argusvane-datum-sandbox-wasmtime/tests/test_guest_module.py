"""The guest module is re-hashed at load: the pin, an own copy with its digest, and a mismatch naming both digests.

The pin is built into argusvane-datum-sandbox-wasmtime and must be the one argusvane-datum-qjs-wasm ships beside the
module, so a substituted argusvane-datum-qjs-wasm cannot bring a pin of its own.
"""

import hashlib
import json
from importlib import resources
from pathlib import Path

import pytest

import datum_qjs_wasm
from datum_sandbox.wasi import EngineConfigurationError
from datum_sandbox_wasmtime import _qjs
from datum_sandbox_wasmtime._qjs import load_qjs, pinned, shipped_pin


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


def test_the_built_in_pin_is_the_one_runtime_json_ships() -> None:
    record = json.loads((resources.files(datum_qjs_wasm) / _qjs.PIN).read_text(encoding="utf-8"))
    assert (record["sha256"], record["qjsVersion"]) == (_qjs.PINNED_SHA256, _qjs.PINNED_VERSION), (
        "a pin bump updates runtime.json (npm run fastapi:pin-runtime) and PINNED_SHA256 and PINNED_VERSION in _qjs.py"
    )
    assert pinned() == shipped_pin()


def _substituted(tmp_path: Path, data: bytes, pin: str) -> Path:
    """A stand-in for another argusvane-datum-qjs-wasm: its module and a runtime.json naming `pin`."""
    (tmp_path / _qjs.ASSET).write_bytes(data)
    (tmp_path / _qjs.PIN).write_text(json.dumps({"sha256": pin, "qjsVersion": _qjs.PINNED_VERSION}), encoding="utf-8")
    return tmp_path


def test_a_substituted_module_is_refused_even_when_its_runtime_json_agrees(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    other = bytearray(load_qjs().data)
    other[-1] ^= 1
    digest = hashlib.sha256(bytes(other)).hexdigest()
    monkeypatch.setattr(_qjs, "_resources", lambda: _substituted(tmp_path, bytes(other), digest))
    with pytest.raises(EngineConfigurationError) as caught:
        load_qjs()
    assert digest in caught.value.message
    assert _qjs.PINNED_SHA256 in caught.value.message


def test_a_runtime_json_that_names_another_pin_is_refused(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    data = load_qjs().data
    monkeypatch.setattr(_qjs, "_resources", lambda: _substituted(tmp_path, data, "f" * 64))
    with pytest.raises(EngineConfigurationError) as caught:
        load_qjs()
    assert "f" * 64 in caught.value.message
    assert _qjs.PINNED_SHA256 in caught.value.message
