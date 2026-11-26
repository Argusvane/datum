"""`datum.runtime.qjs_path` and `qjs_sha256` reach the engine through `SandboxSettings` and `EngineLimits`."""

from pathlib import Path

import pytest

from datum_core.config import DatumConfig
from datum_core.config.sandbox import sandbox_settings
from datum_sandbox.checks import DatumConfigurationError
from datum_sandbox.protocol import ProgramLimits
from datum_sandbox.wasi import EngineLimits

DIGEST = "ab" * 32


def test_the_engine_limits_default_to_the_packaged_guest(tmp_path: Path) -> None:
    limits = EngineLimits({"validation": 1, "pdf": 1}, tmp_path)
    assert (limits.module_path, limits.module_sha256) == (None, None)
    assert ProgramLimits().engine_limits(tmp_path).module_path is None


def test_the_location_travels_from_the_settings_through_program_limits_to_engine_limits(tmp_path: Path) -> None:
    config = DatumConfig.model_validate({"runtime": {"qjs_path": str(tmp_path / "own.wasm"), "qjs_sha256": DIGEST}})
    settings = sandbox_settings(config)
    assert settings.checks == ()
    engine = settings.engine
    limits = settings.limits.engine_limits(tmp_path, qjs_path=engine.qjs_path, qjs_sha256=engine.qjs_sha256)
    assert limits.module_path == tmp_path / "own.wasm"
    assert limits.module_sha256 == DIGEST


def test_an_unset_location_stays_unset_through_the_clamp(tmp_path: Path) -> None:
    engine = sandbox_settings(DatumConfig()).engine
    limits = ProgramLimits().engine_limits(tmp_path, qjs_path=engine.qjs_path, qjs_sha256=engine.qjs_sha256)
    assert (limits.module_path, limits.module_sha256) == (None, None)


def test_a_digest_without_a_path_is_refused_so_it_is_never_silently_ignored(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="module_sha256"):
        EngineLimits({"validation": 1}, tmp_path, module_sha256=DIGEST)
    config = DatumConfig.model_validate({"runtime": {"qjs_sha256": DIGEST}})
    with pytest.raises(DatumConfigurationError, match="qjs_sha256"):
        sandbox_settings(config)
