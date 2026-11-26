"""Pinned: every default, every bound edge, the typed words, secrets in URIs."""

import logging
from typing import Any

import pytest
from pydantic import SecretStr, ValidationError

from datum_core import checks
from datum_core.config import DatumConfig
from datum_sandbox import checks as sandbox_checks

# (dotted path, default); host.time_zone is the process zone and is tested apart.
PINNED_DEFAULTS: list[tuple[str, Any]] = [
    ("enabled", True),
    ("strict_env", False),
    ("silenced_checks", ()),
    ("workers_expected", None),
    ("runtime.engine", "wasmtime"),
    ("runtime.fail_fast", True),
    ("runtime.warm_up_runs", 3),
    ("runtime.shutdown_grace", 10.0),
    ("runtime.startup_budget", 30.0),
    ("runtime.tick", 0.05),
    ("runtime.work_dir", None),
    ("runtime.stop_grace", 5.0),
    ("runtime.max_strays", 0),
    ("runtime.qjs_path", None),
    ("runtime.qjs_sha256", None),
    ("runtime.validation.time_limit", 5.0),
    ("runtime.validation.memory", 33554432),
    ("runtime.validation.concurrency", 0),
    ("runtime.validation.wait", 2.0),
    ("runtime.pdf.time_limit", 60.0),
    ("runtime.pdf.memory", 268435456),
    ("runtime.pdf.concurrency", 0),
    ("runtime.pdf.wait", 2.0),
    ("runtime.verify_max_bytes", 20971520),
    ("runtime.worker_threads", 0),
    ("runtime.programs.sandbox", None),
    ("runtime.programs.pdf", None),
    ("host.formula_errors", "fail"),
    ("host.risky_patterns", "refuse"),
    ("host.unknown_fields", "strip"),
    ("host.log_level", "warn"),
    ("submissions.idempotency.memory_size", 10000),
    ("forms.locations", ("datum/forms/*.json",)),
    ("forms.snapshots.max_entries", 500),
    ("forms.snapshots.public_copy_cache_size", 256),
    ("forms.translations.max_entries", 1000),
    ("forms.data_sources.timeout", 15.0),
    ("forms.data_sources.max_threads", 16),
    ("forms.cache.definition", "no-store"),
    ("web.api.max_body_size", 1048576),
    ("web.api.problem_details", False),
    ("web.api.busy_retry_after", 5),
    ("web.api.correlation_header", "X-Request-ID"),
    ("web.api.endpoints.submissions", False),
    ("web.api.endpoints.validate", False),
    ("web.api.endpoints.test", False),
    ("web.api.endpoints.inspect", False),
    ("web.api.endpoints.definition", False),
    ("web.api.endpoints.data_sources", False),
    ("web.api.endpoints.pdf", False),
    ("web.api.endpoints.fill", False),
    ("web.api.endpoints.sign", False),
    ("web.api.endpoints.verify", False),
    ("web.api.endpoints.certificate", False),
    ("web.throttle.enabled", True),
    ("web.throttle.limit", 60),
    ("web.throttle.address_limit", 600),
    ("web.throttle.window", 60.0),
    ("web.throttle.by", ("ip", "form")),
    ("web.throttle.max_keys", 10000),
    ("web.throttle.limits", {}),
    ("web.throttle.storage", "async+memory://"),
    ("web.throttle.key_salt", None),
    ("web.assets.enabled", False),
    ("web.assets.cache_period", 31536000.0),
    ("web.assets.omit_features", ()),
    ("web.csrf.header_name", "X-XSRF-TOKEN"),
    ("web.csrf.cookie_name", "XSRF-TOKEN"),
    ("web.csrf.meta_name", "_csrf"),
    ("web.openapi.enabled", True),
    ("web.openapi.tag_prefix", "datum-"),
    ("web.openapi.group_documents", False),
    ("web.management.recheck", False),
    ("builder.enabled", False),
    ("builder.max_definition_size", 1048576),
    ("pdf.enabled", True),
    ("pdf.fonts", "default"),
    ("pdf.seal.enabled", False),
    ("pdf.seal.layouts", ()),
    ("pdf.seal.certify", "noChanges"),
    ("pdf.seal.timestamp", True),
    ("pdf.seal.reason", None),
    ("pdf.seal.location", None),
    ("pdf.seal.visible", None),
    ("pdf.seal.posted_answers", False),
    ("pdf.signing.type", "PKCS12"),
    ("pdf.signing.pkcs12_file", None),
    ("pdf.signing.pkcs12_password", None),
    ("pdf.signing.friendly_name", None),
    ("pdf.signing.key_password", None),
    ("pdf.signing.key_file", None),
    ("pdf.signing.cert_file", None),
    ("pdf.signing.retired_certificates", ()),
    ("pdf.signing.trust_anchors", ()),
    ("pdf.signing.tsa.url", None),
    ("pdf.signing.tsa.policy", None),
    ("pdf.signing.tsa.bearer_token", None),
    ("pdf.signing.tsa.basic_user", None),
    ("pdf.signing.tsa.basic_password", None),
    ("pdf.signing.tsa.timeout", 10.0),
    ("tsa.enabled", False),
    ("tsa.access", "clients"),
    ("tsa.policy", None),
    ("tsa.accepted_policies", ()),
    ("tsa.accuracy", 1.0),
    ("tsa.max_request_size", 16384),
    ("tsa.session_cookies", ("*",)),
    ("tsa.allow_memory_stores", False),
    ("tsa.client_store", "settings"),
    ("tsa.clients", ()),
    ("tsa.retired_certificates", ()),
    ("tsa.flood.limit", 1000),
    ("tsa.flood.window", 3600.0),
    ("tsa.flood.failed_keys", 10),
    ("tsa.signer.type", "PKCS12"),
    ("tsa.signer.pkcs12_file", None),
    ("tsa.signer.pkcs12_password", None),
    ("tsa.signer.friendly_name", None),
    ("tsa.signer.key_password", None),
    ("tsa.signer.key_file", None),
    ("tsa.signer.cert_file", None),
    ("tsa.signer.self_signed", False),
]

# (dotted path, lowest accepted, highest accepted or None); a float bound is a Seconds field.
PINNED_BOUNDS: list[tuple[str, float | int | None, float | int | None]] = [
    ("workers_expected", 1, None),
    ("runtime.warm_up_runs", 0, None),
    ("runtime.shutdown_grace", 0.0, None),
    ("runtime.startup_budget", 0.001, None),
    ("runtime.tick", 0.001, None),
    ("runtime.stop_grace", 0.0, None),
    ("runtime.max_strays", 0, None),
    ("runtime.validation.time_limit", 0.001, None),
    ("runtime.validation.memory", 1, None),
    ("runtime.validation.concurrency", 0, None),  # 64 is ProgramLimits.clamp's bound (W008), not a refusal
    ("runtime.validation.wait", 0.0, None),
    ("runtime.pdf.time_limit", 0.001, None),
    ("runtime.pdf.memory", 1, None),
    ("runtime.pdf.concurrency", 0, None),
    ("runtime.pdf.wait", 0.0, None),
    ("runtime.verify_max_bytes", 1, None),
    ("submissions.idempotency.memory_size", 16, 10000000),
    ("forms.snapshots.max_entries", 1, None),
    ("forms.snapshots.public_copy_cache_size", 1, None),
    ("forms.translations.max_entries", 1, None),
    ("forms.data_sources.timeout", 0.001, None),
    ("forms.data_sources.max_threads", 1, None),
    ("web.api.max_body_size", 1, None),
    ("web.api.busy_retry_after", 1, 3600),
    ("web.throttle.limit", 1, None),
    ("web.throttle.address_limit", 1, None),
    ("web.throttle.window", 1.0, None),
    ("web.throttle.max_keys", 1, None),
    ("web.assets.cache_period", 0.0, None),
    ("builder.max_definition_size", 1, 67108864),
    ("pdf.signing.tsa.timeout", 0.001, None),
    ("tsa.accuracy", 0.0, 60.0),
    ("tsa.max_request_size", 1, 1048576),
    ("tsa.flood.limit", 0, None),
    ("tsa.flood.window", 1.0, None),
    ("tsa.flood.failed_keys", 0, None),
]


def build(path: str, value: Any) -> DatumConfig:
    data: dict[str, Any] = {}
    node = data
    *parents, leaf = path.split(".")
    for part in parents:
        node = node.setdefault(part, {})
    node[leaf] = value
    return DatumConfig(**data)


def read(config: DatumConfig, path: str) -> Any:
    value: Any = config
    for part in path.split("."):
        value = getattr(value, part)
    return value


def normal(value: Any) -> Any:
    if hasattr(value, "total_seconds"):
        return value.total_seconds()
    if hasattr(value, "value"):
        return value.value
    if isinstance(value, tuple):
        return tuple(normal(v) for v in value)
    if isinstance(value, dict):
        return {normal(k): v for k, v in value.items()}
    return value


@pytest.mark.parametrize(("path", "expected"), PINNED_DEFAULTS, ids=[p for p, _ in PINNED_DEFAULTS])
def test_default_is_pinned(path: str, expected: Any) -> None:
    got = normal(read(DatumConfig(), path))
    assert got == expected
    assert isinstance(got, bool) == isinstance(expected, bool)


@pytest.mark.parametrize(("path", "low", "high"), PINNED_BOUNDS, ids=[p for p, _, _ in PINNED_BOUNDS])
def test_bound_edges(path: str, low: float | None, high: float | None) -> None:
    step: float = 0.001 if isinstance(low, float) or isinstance(high, float) else 1
    if low is not None:
        build(path, low)
        with pytest.raises(ValidationError):
            build(path, round(low - step, 6))
    if high is not None:
        build(path, high)
        with pytest.raises(ValidationError):
            build(path, round(high + step, 6))


def test_oid_digest_accept_and_refuse() -> None:
    assert build("tsa.policy", "1.2.3.4").tsa.policy == "1.2.3.4"
    for bad in ("3.1", "1", "1.02", "a.b"):
        with pytest.raises(ValidationError):
            build("tsa.policy", bad)
    digest = "AB" * 32
    assert build("runtime.qjs_sha256", digest).runtime.qjs_sha256 == digest.lower()
    for bad in ("ab" * 31, "ab" * 20, "zz" * 32):
        with pytest.raises(ValidationError):
            build("runtime.qjs_sha256", bad)


@pytest.mark.parametrize(
    ("path", "value"),
    [
        ("runtime.validation.time_limit", 0.0005),
        ("runtime.validation.time_limit", 600),
        ("runtime.validation.concurrency", 65),
        ("runtime.validation.wait", 11),
        ("runtime.validation.memory", "2GiB"),
        ("runtime.pdf.time_limit", 301),
        ("runtime.pdf.concurrency", 1000),
        ("runtime.pdf.wait", 30),
        ("runtime.pdf.memory", "1MiB"),
        ("runtime.verify_max_bytes", "1GiB"),
    ],
)
def test_runtime_budgets_keep_type_sanity_only(path: str, value: Any) -> None:
    """The one clamp is ProgramLimits.clamp (W008), so the model refuses no budget by range."""
    build(path, value)


@pytest.mark.parametrize(
    ("path", "secret"),
    [("web.throttle.storage", "async+redis://:pw123@h/0"), ("pdf.signing.tsa.url", "https://u:pw123@tsa.example/x")],
)
def test_credentials_in_a_uri_stay_out_of_repr_str_and_the_json_dump(path: str, secret: str) -> None:
    config = build(path, secret)
    assert read(config, path) == secret
    assert "pw123" not in repr(config)
    assert "pw123" not in str(config)
    dumped = config.model_dump_json()
    assert "pw123" not in dumped
    assert "u:" not in dumped  # the whole user-info goes, a user name can be a token
    assert read(build(path, "https://tsa.example/x"), path) == "https://tsa.example/x"
    assert "https://tsa.example/x" in build(path, "https://tsa.example/x").model_dump_json()  # no user-info: kept


@pytest.mark.parametrize(
    ("check", "level"),
    [
        (sandbox_checks.DatumCheck(sandbox_checks.CheckLevel.INFO, checks.I001, "m", "h"), logging.INFO),
        (sandbox_checks.DatumCheck(sandbox_checks.CheckLevel.WARNING, checks.W001, "m", "h"), logging.WARNING),
        (sandbox_checks.DatumCheck(sandbox_checks.CheckLevel.ERROR, checks.E001, "m", "h"), logging.ERROR),
    ],
)
def test_log_checks_levels_and_hint(
    check: sandbox_checks.DatumCheck, level: int, caplog: pytest.LogCaptureFixture
) -> None:
    with caplog.at_level(logging.DEBUG, logger="datum.checks"):
        checks.log_checks([check])
    assert [r.levelno for r in caplog.records] == [level, level]
    assert caplog.records[0].getMessage() == f"({check.id}) m"
    assert caplog.records[1].getMessage() == "HINT: h"


def test_a_throttle_key_is_made_of_at_least_one_component() -> None:
    assert build("web.throttle.by", ["ip"]).web.throttle.by == ("ip",)
    with pytest.raises(ValidationError) as caught:
        build("web.throttle.by", [])
    assert caught.value.errors()[0]["loc"] == ("web", "throttle", "by")


def test_the_throttle_key_salt_is_a_secret_of_at_least_32_bytes() -> None:
    salt = "k" * 32
    config = build("web.throttle.key_salt", salt)
    assert read(config, "web.throttle.key_salt").get_secret_value() == salt
    for dumped in (repr(config), str(config), config.model_dump_json()):
        assert salt not in dumped
    with pytest.raises(ValidationError) as caught:
        build("web.throttle.key_salt", SecretStr("k" * 31))
    assert "k" * 31 not in str(caught.value) + repr(caught.value.errors())
    assert "at least 32 bytes (got 31)" in str(caught.value)
