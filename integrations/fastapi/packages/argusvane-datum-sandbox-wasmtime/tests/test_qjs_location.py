"""The provider honours the guest location the limits carry (`datum.runtime.qjs_path` and `qjs_sha256`)."""

import hashlib
from pathlib import Path

import pytest
from guests import datum_limits

from datum_sandbox.wasi import EngineConfigurationError, EngineLimits, EngineSettings
from datum_sandbox_wasmtime import WasmtimeProvider
from datum_sandbox_wasmtime._qjs import load_qjs


def limits(tmp_path: Path, **location: object) -> EngineLimits:
    return datum_limits(1, 1, tmp_path / "work", **location)  # type: ignore[arg-type]


def copy_of_guest(tmp_path: Path) -> Path:
    copy = tmp_path / "own-qjs-wasi.wasm"
    copy.write_bytes(load_qjs().data)
    return copy


def test_a_copy_with_a_wrong_digest_stops_the_start_naming_both_digests(tmp_path: Path) -> None:
    copy = copy_of_guest(tmp_path)
    wrong = "0" * 64
    with pytest.raises(EngineConfigurationError) as raised:
        WasmtimeProvider().create(limits(tmp_path, qjs_path=copy, qjs_sha256=wrong), EngineSettings())
    assert wrong in raised.value.message
    assert hashlib.sha256(copy.read_bytes()).hexdigest() in raised.value.message
    assert "datum.runtime.qjs_sha256" in raised.value.message


def test_a_missing_copy_stops_the_start_naming_the_setting(tmp_path: Path) -> None:
    with pytest.raises(EngineConfigurationError, match=r"datum\.runtime\.qjs_path"):
        WasmtimeProvider().create(limits(tmp_path, qjs_path=tmp_path / "absent.wasm"), EngineSettings())


def test_a_tampered_copy_without_a_digest_is_held_to_the_pin(tmp_path: Path) -> None:
    copy = copy_of_guest(tmp_path)
    data = bytearray(copy.read_bytes())
    data[-1] ^= 1
    copy.write_bytes(bytes(data))
    with pytest.raises(EngineConfigurationError):
        WasmtimeProvider().create(limits(tmp_path, qjs_path=copy), EngineSettings())


@pytest.mark.runtime
def test_a_verified_copy_is_the_guest_the_runtime_reports(tmp_path: Path) -> None:
    copy = copy_of_guest(tmp_path)
    digest = hashlib.sha256(copy.read_bytes()).hexdigest()
    runtime = WasmtimeProvider().create(limits(tmp_path, qjs_path=copy, qjs_sha256=digest), EngineSettings())
    try:
        notes = " ".join(runtime.engine_info().notes)
        assert str(copy) in notes
        assert digest in notes
    finally:
        runtime.close()


@pytest.mark.runtime
def test_the_limits_win_over_the_providers_own_location_only_when_they_carry_one(tmp_path: Path) -> None:
    copy = copy_of_guest(tmp_path)
    provider = WasmtimeProvider(qjs_path=copy)
    runtime = provider.create(limits(tmp_path), EngineSettings())
    try:
        assert str(copy) in " ".join(runtime.engine_info().notes)
    finally:
        runtime.close()
