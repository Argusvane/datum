import json
import warnings
from collections.abc import Iterator
from datetime import timedelta
from pathlib import Path
from typing import Any

import pytest
import tzlocal
from pydantic import BaseModel, SecretStr, ValidationError
from pydantic_core import PydanticUndefined

from datum_core import checks
from datum_core.config import DatumConfig, process_zone, reset_process_zone, unknown_env_checks
from datum_core.config.env import setting_names
from datum_core.config.models import Throttle
from datum_core.config.schema import SCHEMA_FILE, main, render, settings_schema
from datum_sandbox import checks as sandbox_checks


def walk(model: type[BaseModel], path: tuple[str, ...] = ()) -> Iterator[tuple[tuple[str, ...], Any]]:
    for name, field in model.model_fields.items():
        yield (*path, name), field
        ann = field.annotation
        if isinstance(ann, type) and issubclass(ann, BaseModel):
            yield from walk(ann, (*path, name))


def errors_at(**kwargs: Any) -> list[tuple[str, ...]]:
    with pytest.raises(ValidationError) as caught:
        DatumConfig(**kwargs)
    return [tuple(str(p) for p in e["loc"]) for e in caught.value.errors()]


# --- shape ---------------------------------------------------------------------------------------------------------
def test_every_field_has_a_description_and_a_json_friendly_default() -> None:
    count = 0
    for path, field in walk(DatumConfig):
        count += 1
        assert field.description, ".".join(path)
        if field.default is not PydanticUndefined:
            json.dumps(field.default)  # raises when the default is not JSON-friendly
        else:
            assert field.default_factory is not None, ".".join(path)
    assert count > 150


def test_every_documented_setting_is_present() -> None:
    names = set(setting_names())
    for expected in [
        "DATUM_ENABLED", "DATUM_STRICT_ENV", "DATUM_SILENCED_CHECKS", "DATUM_WORKERS_EXPECTED",
        "DATUM_RUNTIME__ENGINE", "DATUM_RUNTIME__QJS_SHA256", "DATUM_RUNTIME__VALIDATION__TIME_LIMIT",
        "DATUM_RUNTIME__PDF__WAIT", "DATUM_RUNTIME__VERIFY_MAX_BYTES", "DATUM_RUNTIME__PROGRAMS__PDF",
        "DATUM_HOST__TIME_ZONE", "DATUM_SUBMISSIONS__IDEMPOTENCY__MEMORY_SIZE", "DATUM_FORMS__LOCATIONS",
        "DATUM_FORMS__SNAPSHOTS__PUBLIC_COPY_CACHE_SIZE", "DATUM_FORMS__DATA_SOURCES__MAX_THREADS",
        "DATUM_WEB__API__MAX_BODY_SIZE",
        "DATUM_WEB__API__ENDPOINTS__VALIDATE", "DATUM_WEB__API__ENDPOINTS__CERTIFICATE",
        "DATUM_WEB__THROTTLE__LIMITS", "DATUM_WEB__THROTTLE__STORAGE", "DATUM_WEB__ASSETS__OMIT_FEATURES",
        "DATUM_WEB__CSRF__META_NAME", "DATUM_WEB__OPENAPI__GROUP_DOCUMENTS", "DATUM_WEB__MANAGEMENT__RECHECK",
        "DATUM_BUILDER__MAX_DEFINITION_SIZE", "DATUM_PDF__FONTS",
        "DATUM_PDF__SEAL__POSTED_ANSWERS", "DATUM_PDF__SIGNING__FRIENDLY_NAME",
        "DATUM_PDF__SIGNING__TSA__BASIC_PASSWORD",
        "DATUM_PDF__SIGNING__TRUST_ANCHORS", "DATUM_TSA__SESSION_COOKIES", "DATUM_TSA__FLOOD__FAILED_KEYS",
        "DATUM_TSA__SIGNER__SELF_SIGNED", "DATUM_WEB__THROTTLE__KEY_SALT",
    ]:  # fmt: skip
        assert expected in names, expected


def test_defaults_build_dump_and_freeze() -> None:
    config = DatumConfig()
    assert config.runtime.validation.memory == 33_554_432
    assert config.runtime.validation.time_limit == timedelta(seconds=5)
    assert config.web.api.max_body_size == 1024 * 1024
    assert config.tsa.max_request_size == 16 * 1024
    assert config.forms.locations == ("datum/forms/*.json",)
    assert config.web.throttle.by == ("ip", "form")
    config.model_dump()
    json.loads(config.model_dump_json())
    with pytest.raises(ValidationError):
        config.enabled = False  # type: ignore[misc]


def test_no_copy_method() -> None:
    with pytest.raises(TypeError):
        DatumConfig().model_copy(update={"enabled": False})
    with pytest.raises(TypeError):
        DatumConfig().copy()


def test_unknown_member_in_code_or_toml_is_extra_forbidden() -> None:
    with pytest.raises(ValidationError) as caught:
        DatumConfig.model_validate({"runtime": {"validation": {"time_limt": 3}}})
    assert caught.value.errors()[0]["type"] == "extra_forbidden"
    assert errors_at(runtim={}) == [("runtim",)]


# --- Seconds and Size ----------------------------------------------------------------------------------------------
@pytest.mark.parametrize("given", [5, 5.0, "5", "PT5S", timedelta(seconds=5)])
def test_seconds_forms(given: object) -> None:
    config = DatumConfig.model_validate({"runtime": {"validation": {"time_limit": given}}})
    assert config.runtime.validation.time_limit == timedelta(seconds=5)


def test_seconds_fraction() -> None:
    config = DatumConfig.model_validate({"runtime": {"validation": {"time_limit": "5.5"}}})
    assert config.runtime.validation.time_limit == timedelta(seconds=5.5)


@pytest.mark.parametrize(
    ("given", "expected"), [("32MiB", 33_554_432), ("32MB", 32_000_000), (1024, 1024), ("1KiB", 1024)]
)
def test_size_forms(given: object, expected: int) -> None:
    config = DatumConfig.model_validate({"runtime": {"validation": {"memory": given}}})
    assert config.runtime.validation.memory == expected


def test_every_docs_example_size_parses() -> None:
    for text in ("32MiB", "256MiB", "20MiB", "1MiB", "16KiB", "64MiB"):
        DatumConfig.model_validate({"web": {"api": {"max_body_size": text}}})


# --- fail fast: every kind names its field ---------------------------------------------------------------------------
@pytest.mark.parametrize(
    ("data", "loc"),
    [
        ({"host": {"formula_errors": "ignore"}}, ("host", "formula_errors")),
        ({"host": {"log_level": "loud"}}, ("host", "log_level")),
        ({"pdf": {"fonts": "wingdings"}}, ("pdf", "fonts")),
        ({"pdf": {"seal": {"certify": "everything"}}}, ("pdf", "seal", "certify")),
        ({"web": {"throttle": {"by": ["ip", "cookie"]}}}, ("web", "throttle", "by", "1")),
        ({"web": {"throttle": {"by": []}}}, ("web", "throttle", "by")),
        ({"host": {"time_zone": "Nope/Zone"}}, ("host", "time_zone")),
        ({"host": {"time_zone": ""}}, ("host", "time_zone")),
        ({"runtime": {"validation": {"memory": "lots"}}}, ("runtime", "validation", "memory")),
        ({"web": {"api": {"max_body_size": "-1"}}}, ("web", "api", "max_body_size")),
        ({"runtime": {"validation": {"time_limit": "soon"}}}, ("runtime", "validation", "time_limit")),
        ({"runtime": {"shutdown_grace": "PTxS"}}, ("runtime", "shutdown_grace")),
        ({"web": {"throttle": {"limit": 0}}}, ("web", "throttle", "limit")),
        ({"web": {"api": {"max_body_size": 0}}}, ("web", "api", "max_body_size")),
        ({"builder": {"max_definition_size": 0}}, ("builder", "max_definition_size")),
        ({"builder": {"max_definition_size": "65MiB"}}, ("builder", "max_definition_size")),
        ({"forms": {"snapshots": {"max_entries": 0}}}, ("forms", "snapshots", "max_entries")),
        ({"forms": {"data_sources": {"max_threads": 0}}}, ("forms", "data_sources", "max_threads")),
        ({"runtime": {"validation": {"wait": -1}}}, ("runtime", "validation", "wait")),
        ({"runtime": {"validation": {"concurrency": -1}}}, ("runtime", "validation", "concurrency")),
        ({"runtime": {"validation": {"concurrency": 2.5}}}, ("runtime", "validation", "concurrency")),
        ({"runtime": {"pdf": {"time_limit": 0}}}, ("runtime", "pdf", "time_limit")),
        ({"web": {"api": {"busy_retry_after": 0}}}, ("web", "api", "busy_retry_after")),
        ({"submissions": {"idempotency": {"memory_size": 15}}}, ("submissions", "idempotency", "memory_size")),
        ({"workers_expected": 0}, ("workers_expected",)),
        ({"tsa": {"policy": "not-an-oid"}}, ("tsa", "policy")),
        ({"pdf": {"signing": {"tsa": {"policy": "1.2.x"}}}}, ("pdf", "signing", "tsa", "policy")),
        ({"tsa": {"max_request_size": "2MiB"}}, ("tsa", "max_request_size")),
        ({"tsa": {"accuracy": 61}}, ("tsa", "accuracy")),
        ({"tsa": {"clients": ["abc"]}}, ("tsa", "clients", "0")),
        ({"web": {"throttle": {"limits": {"submit": 0}}}}, ("web", "throttle", "limits")),
        ({"web": {"throttle": {"limits": {"submitt": 5}}}}, ("web", "throttle", "limits", "submitt", "[key]")),
        ({"web": {"api": {"correlation_header": "bad header"}}}, ("web", "api", "correlation_header")),
        ({"silenced_checks": ["datum.E003"]}, ("silenced_checks",)),
        ({"silenced_checks": ["datum.W099"]}, ("silenced_checks",)),
    ],
)  # fmt: skip
def test_bad_values_fail_naming_the_field(data: dict[str, Any], loc: tuple[str, ...]) -> None:
    with pytest.raises(ValidationError) as caught:
        DatumConfig.model_validate(data)
    assert loc in [tuple(str(p) for p in e["loc"]) for e in caught.value.errors()]
    assert ".".join(loc[:1]) in str(caught.value)


def test_enum_words_are_case_folded_and_name_the_closest() -> None:
    assert DatumConfig(host={"log_level": "WARN"}).host.log_level == "warn"  # type: ignore[arg-type]
    assert DatumConfig.model_validate({"pdf": {"seal": {"certify": "NOCHANGES"}}}).pdf.seal.certify == "noChanges"
    with pytest.raises(ValidationError) as caught:
        DatumConfig.model_validate({"host": {"formula_errors": "fial"}})
    text = str(caught.value)
    assert "'fail'" in text
    assert "'warn'" in text
    assert "did you mean 'fail'" in text


def test_words_from_a_non_string_still_fail() -> None:
    assert errors_at(host={"log_level": 3}) == [("host", "log_level")]


def test_silenced_checks_accept_info_and_warning() -> None:
    assert DatumConfig(silenced_checks=("datum.W004", "datum.I001")).silenced_checks == ("datum.W004", "datum.I001")


# --- secrets ----------------------------------------------------------------------------------------------------------
def test_no_secret_in_any_message_or_repr() -> None:
    secret = "s3cret-" + "x" * 40
    config = DatumConfig.model_validate(
        {
            "web": {"throttle": {"key_salt": secret}},
            "pdf": {
                "signing": {
                    "pkcs12_password": secret,
                    "key_password": secret,
                    "tsa": {"bearer_token": secret, "basic_password": secret},
                }
            },
            "tsa": {"signer": {"pkcs12_password": secret, "key_password": secret}},
        }
    )
    for dumped in (repr(config), str(config), config.model_dump_json(), repr(config.model_dump())):
        assert secret not in dumped
    assert isinstance(config.web.throttle.key_salt, SecretStr)
    assert config.web.throttle.key_salt.get_secret_value() == secret


def test_a_short_secret_is_reported_by_its_length_only() -> None:
    short = "hunter2-short"
    with pytest.raises(ValidationError) as caught:
        Throttle(key_salt=SecretStr(short))
    text = str(caught.value) + repr(caught.value.errors())
    assert short not in text
    assert "at least 32 bytes (got 13)" in text
    assert "key_salt" in text


def test_a_secret_beside_another_failure_stays_out_of_the_message() -> None:
    secret = "another-secret-value-123456789012345"
    with pytest.raises(ValidationError) as caught:
        DatumConfig.model_validate({"web": {"throttle": {"key_salt": secret, "limit": "x"}}})
    assert secret not in str(caught.value) + repr(caught.value.errors())
    with pytest.raises(ValidationError) as caught:
        DatumConfig.model_validate({"pdf": {"signing": {"pkcs12_password": secret, "bogus": 1}}})
    assert secret not in str(caught.value) + repr(caught.value.errors())
    for wrong_shape in (
        {"web": {"throttle": {"key_salt": [secret]}}},
        {"pdf": {"signing": [secret]}},
        {"tsa": {"signer": secret}},
    ):
        with pytest.raises(ValidationError) as caught:
            DatumConfig.model_validate(wrong_shape)
        # errors() hands the raw input back to code that asks for it; the message (str) must not carry it
        assert secret not in str(caught.value) + repr(caught.value.errors(include_input=False))


# --- time zone ------------------------------------------------------------------------------------------------------
@pytest.fixture
def fresh_zone() -> Iterator[None]:
    reset_process_zone()
    yield
    reset_process_zone()


def test_zone_default_is_the_process_zone(fresh_zone: None, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(tzlocal, "get_localzone_name", lambda: "Asia/Tokyo")
    assert DatumConfig().host.time_zone == "Asia/Tokyo"
    assert process_zone().check is None


def test_zone_unreadable_falls_back_to_utc_with_a_warning(fresh_zone: None, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(tzlocal, "get_localzone_name", lambda: None)
    assert DatumConfig().host.time_zone == "UTC"
    check = process_zone().check
    assert check is not None
    assert check.id == checks.W010
    assert check.level is sandbox_checks.CheckLevel.WARNING
    assert "DATUM_HOST__TIME_ZONE" in check.hint


def test_zone_that_is_not_in_the_database_or_raises_falls_back(
    fresh_zone: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(tzlocal, "get_localzone_name", lambda: "Nope/Zone")
    assert process_zone().name == "UTC"
    reset_process_zone()

    def boom() -> str:
        raise OSError

    monkeypatch.setattr(tzlocal, "get_localzone_name", boom)
    assert process_zone().name == "UTC"


def test_zone_is_resolved_once(fresh_zone: None, monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[int] = []

    def read() -> str:
        calls.append(1)
        return "UTC"

    monkeypatch.setattr(tzlocal, "get_localzone_name", read)
    DatumConfig()
    DatumConfig()
    assert len(calls) == 1


def test_tzlocal_warning_does_not_escape(fresh_zone: None, monkeypatch: pytest.MonkeyPatch) -> None:
    def read() -> str:
        warnings.warn("defaulting to UTC", UserWarning, stacklevel=1)
        return "Asia/Tokyo"

    monkeypatch.setattr(tzlocal, "get_localzone_name", read)
    assert process_zone().name == "Asia/Tokyo"  # filterwarnings=error would turn the warning into UTC otherwise


# --- the unknown-key scan ------------------------------------------------------------------------------------
def test_clean_environment_has_no_findings() -> None:
    env = {
        "DATUM_RUNTIME__VALIDATION__TIME_LIMIT": "7", "DATUM_ENABLED": "", "datum_host__log_level": "warn",
        "DATUM_CONFIG_FILE": "/etc/datum.toml", "DATUM_WEB__THROTTLE__LIMITS__SUBMIT": "5",
        "DATUM_WEB__THROTTLE__LIMITS": '{"pdf": 2}', "PATH": "/bin", "DATUMX": "1",
    }  # fmt: skip
    assert unknown_env_checks(env) == ()


def test_typo_in_a_section_suggests_the_field() -> None:
    (check,) = unknown_env_checks({"DATUM_RUNTIM__FAIL_FAST": "false"})
    assert check.id == checks.W007
    assert check.level is sandbox_checks.CheckLevel.WARNING
    assert "DATUM_RUNTIME__FAIL_FAST" in check.hint
    assert "strict_env" in check.hint


def test_typo_in_a_leaf_suggests_the_field() -> None:
    (check,) = unknown_env_checks({"DATUM_RUNTIME__VALIDATION__TIME_LIMT": "7"})
    assert "DATUM_RUNTIME__VALIDATION__TIME_LIMIT" in check.hint


def test_orchestrator_variables_warn_without_a_misleading_hint() -> None:
    found = unknown_env_checks({"DATUM_SERVICE_HOST": "10.0.0.1", "DATUM_PORT": "tcp://10.0.0.1:80"})
    assert [c.id for c in found] == [checks.W007, checks.W007]
    assert all("did you mean" not in c.hint for c in found)  # DATUM_PORT is not DATUM_RUNTIME or DATUM_HOST


def test_nested_bogus_and_single_underscore_nesting_are_found() -> None:
    names = [c.msg for c in unknown_env_checks({"DATUM_RUNTIME__BOGUS": "1", "DATUM_WEB_API__MAX_BODY_SIZE": "1MiB"})]
    assert len(names) == 2
    (single,) = (c for c in unknown_env_checks({"DATUM_WEB_API__MAX_BODY_SIZE": "1"}))
    assert "did you mean DATUM_WEB__API__MAX_BODY_SIZE" in single.hint


def test_a_scalar_cannot_be_nested_into() -> None:
    assert len(unknown_env_checks({"DATUM_ENABLED__X": "1"})) == 1


def test_scan_is_case_insensitive_and_sorted() -> None:
    found = unknown_env_checks({"datum_zzz": "1", "Datum_Aaa": "1"})
    assert [c.msg.split()[3] for c in found] == ["Datum_Aaa", "datum_zzz"]


# --- the schema -----------------------------------------------------------------------------------------------------
def test_schema_lists_every_field_with_a_description() -> None:
    with warnings.catch_warnings():
        warnings.simplefilter("error")
        schema = settings_schema()

    defs: dict[str, Any] = schema["$defs"]

    def described(prop: dict[str, Any]) -> bool:
        # pydantic leaves the description on the referenced definition when the field's text equals the class's
        ref: str | None = prop.get("$ref") or prop.get("allOf", [{}])[0].get("$ref")
        return bool(prop.get("description") or (ref and defs[ref.rsplit("/", 1)[1]].get("description")))

    def check(model: type[BaseModel], node: dict[str, Any]) -> None:
        props: dict[str, Any] = node["properties"]
        assert set(props) == set(model.model_fields)
        for name, field in model.model_fields.items():
            assert described(props[name]), name
            ann = field.annotation
            if isinstance(ann, type) and issubclass(ann, BaseModel):
                ref = (props[name].get("$ref") or props[name]["allOf"][0]["$ref"]).rsplit("/", 1)[1]
                check(ann, defs[ref])

    check(DatumConfig, schema)
    assert schema["additionalProperties"] is False


def test_schema_documents_seconds_and_size() -> None:
    schema = settings_schema()
    budget = schema["$defs"]["ValidationBudget"]["properties"]
    seconds = budget["time_limit"]
    assert any(alt.get("type") == "number" for alt in seconds["anyOf"])
    assert any(alt.get("format") == "duration" for alt in seconds["anyOf"])
    size = budget["memory"]
    assert any(alt.get("type") == "integer" for alt in size["anyOf"])
    assert any("pattern" in alt for alt in size["anyOf"])
    assert size["default"] == "32MiB"


def test_schema_cli_writes_the_file(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    assert main(["--out", str(tmp_path)]) == 0
    target = tmp_path / SCHEMA_FILE
    assert capsys.readouterr().out.strip() == str(target)
    assert target.read_text(encoding="utf-8") == render()
    assert json.loads(render())["title"] == "Datum settings"
    assert main(["--out", str(tmp_path / "sub" / "x.json")]) == 0
    assert (tmp_path / "sub" / "x.json").read_text(encoding="utf-8") == render()


# --- further edge cases -----------------------------------------------------------------------------------------------
@pytest.mark.parametrize(
    "path",
    ["runtime.validation.time_limit", "runtime.validation.wait", "runtime.validation.memory", "web.api.max_body_size"],
)
@pytest.mark.parametrize("flag_value", [True, False])
def test_seconds_and_sizes_refuse_a_bool(path: str, flag_value: bool) -> None:
    *parents, leaf = path.split(".")
    data: dict[str, Any] = {leaf: flag_value}
    for part in reversed(parents):
        data = {part: data}
    with pytest.raises(ValidationError) as caught:
        DatumConfig.model_validate(data)
    assert tuple(path.split(".")) in [tuple(str(p) for p in e["loc"]) for e in caught.value.errors()]


@pytest.mark.parametrize(
    "path",
    ["runtime.validation.concurrency", "runtime.pdf.concurrency", "runtime.warm_up_runs", "web.api.busy_retry_after"],
)
@pytest.mark.parametrize("flag_value", [True, False])
def test_counts_refuse_a_bool(path: str, flag_value: bool) -> None:
    test_seconds_and_sizes_refuse_a_bool(path, flag_value)


def test_the_unknown_key_hint_considers_the_allowlist() -> None:
    (check,) = unknown_env_checks({"DATUM_CONFIG_FIL": "/etc/datum.toml"})
    assert "did you mean DATUM_CONFIG_FILE?" in check.hint
    assert unknown_env_checks({"DATUM_CONFIG_FILE": "/etc/datum.toml"}) == ()
    (port,) = unknown_env_checks({"DATUM_PORT": "tcp://10.0.0.1:80"})
    assert "did you mean" not in port.hint


def test_a_raw_string_secret_stays_out_of_the_message_and_the_input_free_dumps() -> None:
    # A plain str (not a SecretStr) that fails the length rule: errors() and json() with their default include_input
    # hand the raw value back, which is why the binding logs errors(include_input=False).
    raw = "raw-secret-20-bytes!"
    with pytest.raises(ValidationError) as caught:
        DatumConfig.model_validate({"web": {"throttle": {"key_salt": raw}}})
    error = caught.value
    for text in (
        str(error),
        repr(error),
        repr(error.errors(include_input=False)),
        error.json(include_input=False),
    ):
        assert raw not in text
    assert "at least 32 bytes (got 20)" in error.json(include_input=False)
