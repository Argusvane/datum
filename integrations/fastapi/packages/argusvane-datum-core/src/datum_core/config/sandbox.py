"""`sandbox_settings`: the `datum.runtime.*` and `datum.host.*` sections mapped onto argusvane-datum-sandbox's settings.

The pydantic models parse (durations, sizes, words, type sanity); `SandboxSettings.build` holds every value to its bound
and remembers where it came from. A field the configuration set is passed as set (so the report says "configured"); one
it left at its default is not passed, and the report says "default". The process time zone is the host's own default for
`datum.host.time_zone`, handed over as a default.
"""

from typing import TYPE_CHECKING

from pydantic import BaseModel

from datum_core.config.models import DatumConfig
from datum_sandbox.runtime import SandboxSettings

if TYPE_CHECKING:
    from collections.abc import Mapping


def _set(model: BaseModel, name: str) -> bool:
    return name in model.model_fields_set


def _value(model: BaseModel, name: str) -> object:
    value: object = getattr(model, name)
    if hasattr(value, "total_seconds"):
        return value.total_seconds()
    if isinstance(value, int) and not isinstance(value, bool):
        return int(value)
    return value


def sandbox_settings(config: DatumConfig) -> SandboxSettings:
    """Return the clamped sandbox settings of `config` (raises `DatumConfigurationError` for what cannot be clamped)."""
    runtime = config.runtime
    host = config.host
    capture = runtime.diagnostics.capture
    sections: tuple[tuple[BaseModel, Mapping[str, str]], ...] = (
        (
            runtime,
            {
                "engine": "engine",
                "stop_grace": "stop_grace",
                "max_strays": "max_strays",
                "tick": "tick",
                "work_dir": "work_dir",
                "qjs_path": "qjs_path",
                "qjs_sha256": "qjs_sha256",
                "fail_fast": "fail_fast",
                "warm_up_runs": "warm_up_runs",
                "startup_budget": "startup_budget",
                "shutdown_grace": "shutdown_grace",
                "verify_max_bytes": "verify_max_bytes",
            },
        ),
        (
            runtime.validation,
            {
                "time_limit": "validation_time_limit",
                "memory": "validation_memory",
                "concurrency": "validation_concurrency",
                "wait": "validation_wait",
            },
        ),
        (
            runtime.pdf,
            {
                "time_limit": "pdf_time_limit",
                "memory": "pdf_memory",
                "concurrency": "pdf_concurrency",
                "wait": "pdf_wait",
            },
        ),
        (runtime.programs, {"sandbox": "sandbox_program", "pdf": "pdf_program"}),
        (
            host,
            {
                "formula_errors": "formula_errors",
                "risky_patterns": "risky_patterns",
                "time_zone": "time_zone",
                "unknown_fields": "unknown_fields",
                "log_level": "log_level",
            },
        ),
        (runtime.diagnostics, {"trace": "trace", "report": "report"}),
        (
            capture,
            {
                "enabled": "capture_enabled",
                "directory": "capture_directory",
                "max_runs": "capture_max_runs",
                "max_bytes": "capture_max_bytes",
                "queue_bytes": "capture_queue_bytes",
            },
        ),
    )
    values: dict[str, object] = {}
    for model, names in sections:
        for field, keyword in names.items():
            if _set(model, field):
                values[keyword] = _value(model, field)
    defaults: dict[str, object] = {}
    if "time_zone" not in values:
        defaults["time_zone"] = host.time_zone  # the process zone, resolved once by the configuration
    return SandboxSettings.build(defaults=defaults, **values)  # type: ignore[arg-type]
