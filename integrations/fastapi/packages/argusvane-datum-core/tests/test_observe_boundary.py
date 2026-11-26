"""Source rules: observation through the API only, `limits` only in `throttle`, and the
service packages say nothing of headers, statuses or requests.

The API-only rule has one named exception: `testing/otel.py`, the testing extra's in-memory SDK installer, which the
members' observation tests share (one provider per process) and which no product module imports.
"""

import ast
from pathlib import Path

import pytest

import datum_core

ROOT = Path(datum_core.__file__).resolve().parent
OBSERVE = ROOT / "observe.py"
TESTING_SDK = ROOT / "testing" / "otel.py"
BANNED_IMPORT_PREFIXES = (
    "opentelemetry.sdk",
    "opentelemetry.exporter",
    "opentelemetry.instrumentation",
    "prometheus_client",
)
WEB_WORDS = {"request", "Request", "response", "Response", "status", "status_code", "header", "HTTPStatus"}
WEB_MODULES = ("fastapi", "starlette", "http", "flask", "django", "litestar")


def sources() -> list[Path]:
    return sorted(path for path in ROOT.rglob("*.py") if "__pycache__" not in path.parts)


def imported(tree: ast.AST) -> set[str]:
    found: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            found |= {alias.name for alias in node.names}
        elif isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
            found.add(node.module)
    return found


def test_the_observation_module_exists_and_names_its_bucket_advice() -> None:
    assert OBSERVE.is_file()
    assert "RUN_DURATION_BUCKETS" in OBSERVE.read_text(encoding="utf-8")


def test_the_tracer_and_the_meter_are_acquired_at_module_level_under_the_name_datum() -> None:
    tree = ast.parse(OBSERVE.read_text(encoding="utf-8"))
    calls = {
        node.value.func.attr: node.value
        for node in tree.body
        if isinstance(node, ast.Assign)
        and isinstance(node.value, ast.Call)
        and isinstance(node.value.func, ast.Attribute)
        and node.value.func.attr in {"get_tracer", "get_meter"}
    }
    assert set(calls) == {"get_tracer", "get_meter"}
    for call in calls.values():
        assert isinstance(call.args[0], ast.Constant)
        assert call.args[0].value == "datum"
        assert len(call.args) >= 2 or call.keywords  # the version rides along


@pytest.mark.parametrize("path", sources(), ids=lambda p: str(p.relative_to(ROOT)))
def test_no_module_imports_an_sdk_an_exporter_an_instrumentation_or_a_prometheus_client(path: Path) -> None:
    modules = imported(ast.parse(path.read_text(encoding="utf-8")))
    bad = [m for m in modules if m.startswith(BANNED_IMPORT_PREFIXES)]
    if path == TESTING_SDK:
        # The one exception: the tests' in-memory SDK, behind the testing extra; the SDK only, no exporter package.
        assert bad
        assert all(m.startswith("opentelemetry.sdk") for m in bad), bad
        return
    assert bad == [], bad


def test_no_product_module_imports_the_testing_kits_sdk_installer() -> None:
    for path in sources():
        if path == TESTING_SDK:
            continue
        modules = imported(ast.parse(path.read_text(encoding="utf-8")))
        installer = [m for m in modules if m == "datum_core.testing.otel" or m.startswith("datum_core.testing.otel.")]
        assert installer == [], path


def test_the_product_installs_no_handler_and_never_reads_the_auto_configure_variable() -> None:
    for path in sources():
        text = path.read_text(encoding="utf-8")
        code = "\n".join(line for line in text.splitlines() if not line.lstrip().startswith(("#", '"', "'")))
        assert "FASTAPI_OTEL_AUTO_CONFIGURE" not in code, path
        for forbidden in ("basicConfig(", ".addHandler(", "NullHandler("):
            assert forbidden not in code, (path, forbidden)


def test_no_module_writes_the_trace_header_names_and_the_client_tests_record_every_header() -> None:
    """No source file spells `traceparent` or `tracestate`: Datum never injects trace context into a request.

    The timestamp client's outbound request is held to the same rule from the other side: its tests record every header
    the stub server receives, with a W3C propagator set and a span active (`test_timestamp_client.py`).
    """
    for path in sources():
        text = path.read_text(encoding="utf-8").lower()
        assert "traceparent" not in text, path
        assert "tracestate" not in text, path


@pytest.mark.parametrize("path", sources(), ids=lambda p: str(p.relative_to(ROOT)))
def test_limits_is_imported_only_by_the_throttle_package(path: Path) -> None:
    modules = imported(ast.parse(path.read_text(encoding="utf-8")))
    uses_limits = any(m == "limits" or m.startswith("limits.") for m in modules)
    assert not uses_limits or "throttle" in (*path.relative_to(ROOT).parts[:1], path.stem), path


def service_packages() -> list[Path]:
    return [p for p in sources() if p.relative_to(ROOT).parts[0] in {"submissions", "throttle"}]


def test_the_service_packages_exist() -> None:
    assert {p.relative_to(ROOT).parts[0] for p in service_packages()} == {"submissions", "throttle"}


@pytest.mark.parametrize("path", service_packages(), ids=lambda p: str(p.relative_to(ROOT)))
def test_the_service_packages_import_no_web_framework_and_name_no_header_status_or_request(path: Path) -> None:
    tree = ast.parse(path.read_text(encoding="utf-8"))
    web = [m for m in imported(tree) if m.split(".")[0] in WEB_MODULES]
    assert web == []
    names: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Name):
            names.add(node.id)
        elif isinstance(node, ast.Attribute):
            names.add(node.attr)
        elif isinstance(node, ast.arg):
            names.add(node.arg)
        elif isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef | ast.ClassDef):
            names.add(node.name)
    assert names & WEB_WORDS == set()


def shielded_scopes(tree: ast.AST) -> list[int]:
    """Line numbers of every call that passes `shield=True` (a cancel scope or a helper that wraps one)."""
    return [
        node.lineno
        for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        and any(
            keyword.arg == "shield" and isinstance(keyword.value, ast.Constant) and keyword.value.value is True
            for keyword in node.keywords
        )
    ]


def test_no_source_of_either_package_shields_a_cancel_scope() -> None:
    fastapi_sources = ROOT.parents[2] / "argusvane-datum-fastapi" / "src"
    paths = sources() + (sorted(fastapi_sources.rglob("*.py")) if fastapi_sources.is_dir() else [])
    assert paths
    offenders = [
        f"{path.name}:{line}" for path in paths for line in shielded_scopes(ast.parse(path.read_text(encoding="utf-8")))
    ]
    assert offenders == [], "the effect stage is a task the host owns, never CancelScope(shield=True)"


def test_the_shield_scan_catches_a_shielded_scope() -> None:
    assert shielded_scopes(ast.parse("import anyio\nwith anyio.CancelScope(shield=True):\n    pass\n")) == [2]
    assert shielded_scopes(ast.parse("import anyio\nwith anyio.CancelScope():\n    pass\n")) == []
