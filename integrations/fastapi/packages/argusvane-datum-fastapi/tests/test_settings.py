"""The binding half: DatumSettings is DatumConfig plus sources; the env scan is a trailing source."""

import logging
import os
from pathlib import Path
from typing import Any

import pytest
from pydantic import ValidationError

from datum_core.config import DatumConfig
from datum_fastapi import DatumSettings
from datum_sandbox.checks import DatumConfigurationError

CHECKS_LOGGER = "datum.checks"


@pytest.fixture(autouse=True)
def _clean_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in list(os.environ):
        if name.upper().startswith("DATUM_") or name == "WEB_CONCURRENCY":
            monkeypatch.delenv(name)


def w007(caplog: pytest.LogCaptureFixture) -> list[logging.LogRecord]:
    """One record per W007 finding (a finding logs its message and a HINT line, both tagged with the id)."""
    return [r for r in caplog.records if r.getMessage().startswith("(datum.W007)")]


# ---- the fields ----------------------------------------------------------------------------------------------------
def test_settings_and_config_have_the_same_fields_with_the_same_types() -> None:
    assert list(DatumSettings.model_fields) == list(DatumConfig.model_fields)
    for name, field in DatumConfig.model_fields.items():
        assert DatumSettings.model_fields[name].annotation == field.annotation, name


def test_settings_and_config_publish_the_same_schema_fields() -> None:
    settings = DatumSettings.model_json_schema(mode="validation")
    config = DatumConfig.model_json_schema(mode="validation")
    assert list(settings["properties"]) == list(config["properties"])
    assert settings["$defs"].keys() == config["$defs"].keys()


def test_every_settings_field_has_a_description_in_the_published_schema() -> None:
    schema = DatumSettings.model_json_schema(mode="validation")
    defs = schema["$defs"]

    def described(prop: dict[str, Any]) -> bool:
        # pydantic leaves a section's description on the referenced definition when it equals the class's.
        ref = prop.get("$ref")
        return bool(prop.get("description") or (ref and defs[ref.rsplit("/", 1)[1]].get("description")))

    missing = [f"datum.{name}" for name, prop in schema["properties"].items() if not described(prop)]
    for section, body in defs.items():
        missing += [f"{section}.{name}" for name, prop in body.get("properties", {}).items() if not described(prop)]
    assert missing == []


def test_the_model_rules_of_the_settings_class() -> None:
    model = DatumSettings.model_config
    assert model.get("env_prefix") == "DATUM_"
    assert model.get("env_nested_delimiter") == "__"
    assert model.get("extra") == "forbid"
    assert model.get("env_ignore_empty") is True
    assert model.get("validate_default") is True
    assert model.get("frozen") is True
    assert model.get("env_file") is None
    assert model.get("hide_input_in_errors") is True  # a validation message never echoes a secret


def test_to_config_gives_a_validation_only_config_with_the_same_values() -> None:
    init: dict[str, Any] = {"runtime": {"engine": "other"}}
    settings = DatumSettings(**init)
    config = settings.to_config()
    assert type(config) is DatumConfig
    assert config.runtime.engine == "other"
    assert config.model_dump() == DatumConfig.model_validate({"runtime": {"engine": "other"}}).model_dump()


def test_the_defaults_dump_and_the_size_default_survives_as_text() -> None:
    dumped = DatumSettings().model_dump()
    assert dumped["runtime"]["validation"]["memory"] == DatumConfig().model_dump()["runtime"]["validation"]["memory"]


def test_the_environment_fills_nested_fields_and_an_empty_value_falls_back(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DATUM_RUNTIME__FAIL_FAST", "false")
    monkeypatch.setenv("DATUM_RUNTIME__ENGINE", "")
    monkeypatch.setenv("DATUM_WEB__API__ENDPOINTS__DEFINITION", "true")
    settings = DatumSettings()
    assert settings.runtime.fail_fast is False
    assert settings.runtime.engine == "wasmtime"  # empty means unset
    assert settings.web.api.endpoints.definition is True


def test_a_bad_value_names_its_field_in_the_validation_error(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DATUM_WEB__API__BUSY_RETRY_AFTER", "0")
    with pytest.raises(ValidationError, match="busy_retry_after"):
        DatumSettings()


# ---- the trailing env scan -----------------------------------------------------------------------------------------
def test_an_unknown_key_warns_w007_with_a_did_you_mean(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    monkeypatch.setenv("DATUM_RUNTIM__FAIL_FAST", "false")
    with caplog.at_level(logging.WARNING, logger=CHECKS_LOGGER):
        DatumSettings()
    records = w007(caplog)
    assert len(records) == 1
    text = "\n".join(r.getMessage() for r in caplog.records)
    assert "DATUM_RUNTIM__FAIL_FAST" in text
    assert "DATUM_RUNTIME__FAIL_FAST" in text  # the suggestion


def test_service_host_and_port_warn_only(monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture) -> None:
    monkeypatch.setenv("DATUM_SERVICE_HOST", "0.0.0.0")  # noqa: S104
    monkeypatch.setenv("DATUM_PORT", "9000")
    with caplog.at_level(logging.WARNING, logger=CHECKS_LOGGER):
        settings = DatumSettings()
    assert len(w007(caplog)) == 2
    assert settings.strict_env is False


def test_a_known_key_and_unrelated_variables_warn_nothing(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    monkeypatch.setenv("DATUM_RUNTIME__FAIL_FAST", "true")
    monkeypatch.setenv("OTHER_THING", "1")
    with caplog.at_level(logging.WARNING, logger=CHECKS_LOGGER):
        DatumSettings()
    assert w007(caplog) == []


def test_strict_env_refuses_the_start_with_a_configuration_error_naming_the_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("DATUM_STRICT_ENV", "true")
    monkeypatch.setenv("DATUM_RUNTIM__FAIL_FAST", "false")
    with pytest.raises(DatumConfigurationError) as raised:
        DatumSettings()
    assert "DATUM_RUNTIM__FAIL_FAST" in str(raised.value)
    assert [p.id for p in raised.value.problems] == ["datum.W007"]


def test_strict_env_given_in_code_also_refuses(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DATUM_SERVICE_HOST", "x")
    with pytest.raises(DatumConfigurationError):
        DatumSettings(strict_env=True)


def test_silenced_checks_silence_the_w007_warning(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    monkeypatch.setenv("DATUM_SERVICE_HOST", "x")
    monkeypatch.setenv("DATUM_SILENCED_CHECKS", '["datum.W007"]')
    with caplog.at_level(logging.WARNING, logger=CHECKS_LOGGER):
        DatumSettings()
    assert w007(caplog) == []


# ---- the TOML file -------------------------------------------------------------------------------------------------
def test_datum_config_file_is_allowlisted_and_read_as_toml(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    file = tmp_path / "datum.toml"
    file.write_text('[runtime]\nfail_fast = false\n\n[web.api]\nmax_body_size = "2MiB"\n', encoding="utf-8")
    monkeypatch.setenv("DATUM_CONFIG_FILE", str(file))
    with caplog.at_level(logging.WARNING, logger=CHECKS_LOGGER):
        settings = DatumSettings()
    assert w007(caplog) == []
    assert settings.runtime.fail_fast is False
    assert settings.web.api.max_body_size == 2 * 1024 * 1024


def test_the_environment_wins_over_the_toml_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    file = tmp_path / "datum.toml"
    file.write_text("[runtime]\nwarm_up_runs = 7\n", encoding="utf-8")
    monkeypatch.setenv("DATUM_CONFIG_FILE", str(file))
    monkeypatch.setenv("DATUM_RUNTIME__WARM_UP_RUNS", "1")
    assert DatumSettings().runtime.warm_up_runs == 1


def test_init_arguments_win_over_the_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DATUM_RUNTIME__WARM_UP_RUNS", "1")
    init: dict[str, Any] = {"runtime": {"warm_up_runs": 5}}
    assert DatumSettings(**init).runtime.warm_up_runs == 5


def test_a_nested_typo_in_the_toml_file_is_an_extra_forbidden_error(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    file = tmp_path / "datum.toml"
    file.write_text("[runtime]\nfail_fastt = true\n", encoding="utf-8")
    monkeypatch.setenv("DATUM_CONFIG_FILE", str(file))
    with pytest.raises(ValidationError) as raised:
        DatumSettings()
    assert raised.value.errors()[0]["type"] == "extra_forbidden"


def test_a_nested_typo_in_code_is_an_extra_forbidden_error() -> None:
    init: dict[str, Any] = {"runtime": {"fail_fastt": True}}
    with pytest.raises(ValidationError) as raised:
        DatumSettings(**init)
    assert raised.value.errors()[0]["type"] == "extra_forbidden"


def test_the_settings_are_frozen() -> None:
    settings = DatumSettings()
    with pytest.raises(ValidationError):
        settings.strict_env = True  # type: ignore[misc]


def test_a_secret_never_appears_in_a_validation_message(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DATUM_WEB__THROTTLE__KEY_SALT", "short-secret-value")
    with pytest.raises(ValidationError) as raised:
        DatumSettings()
    assert "short-secret-value" not in str(raised.value)


def test_a_config_file_that_does_not_exist_refuses_naming_the_variable(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("DATUM_CONFIG_FILE", str(tmp_path / "missing.toml"))
    with pytest.raises(DatumConfigurationError, match="DATUM_CONFIG_FILE"):
        DatumSettings()


def test_an_empty_config_file_variable_means_unset(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DATUM_CONFIG_FILE", "")
    assert DatumSettings().runtime.engine == "wasmtime"


def test_the_scan_warns_once_per_construction(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    monkeypatch.setenv("DATUM_SERVICE_HOST", "x")
    with caplog.at_level(logging.WARNING, logger=CHECKS_LOGGER):
        DatumSettings()
        DatumSettings()
    assert len(w007(caplog)) == 2


def test_strict_env_from_the_environment_is_read_as_a_boolean_word(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DATUM_STRICT_ENV", "yes")
    monkeypatch.setenv("DATUM_SERVICE_HOST", "x")
    with pytest.raises(DatumConfigurationError):
        DatumSettings()


def test_a_bad_strict_env_is_the_fields_own_validation_error(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DATUM_STRICT_ENV", "perhaps")
    monkeypatch.setenv("DATUM_SERVICE_HOST", "x")
    with pytest.raises(ValidationError, match="strict_env"):
        DatumSettings()


def test_the_validation_error_of_a_secret_is_loggable_without_its_input(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DATUM_WEB__THROTTLE__KEY_SALT", "short-secret-value")
    with pytest.raises(ValidationError) as raised:
        DatumSettings()
    assert "short-secret-value" not in str(raised.value.errors(include_input=False))
