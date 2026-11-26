"""The boundary of the generic layer: `datum_sandbox.wasi` imports only the standard library and itself.

import-linter holds the same rules for the workspace (`lint-imports`, run by CI beside `deptry`); this test reads the
sources itself, relative imports resolved, so a run of this member's tests alone catches a Datum word or a third-party
import landing in the generic run, and a `datum_core` import anywhere in the library.
"""

import ast
import sys
from pathlib import Path

import datum_sandbox
import datum_sandbox.wasi

ROOT = Path(datum_sandbox.__file__).parent
WASI = Path(datum_sandbox.wasi.__file__).parent


def module_of(path: Path) -> str:
    parts = ["datum_sandbox", *path.relative_to(ROOT).with_suffix("").parts]
    return ".".join(parts[:-1] if parts[-1] == "__init__" else parts)


def imported(path: Path, module: str | None = None) -> set[str]:
    """Every module `path` imports, a relative import resolved against the module's own package."""
    module = module or module_of(path)
    package = module if path.name == "__init__.py" else module.rpartition(".")[0]
    found: set[str] = set()
    for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
        if isinstance(node, ast.Import):
            found.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            if node.level:
                base = package.split(".")
                base = base[: len(base) - (node.level - 1)]
                target = ".".join([*base, *([node.module] if node.module else [])])
                found.add(target)
                found.update(f"{target}.{alias.name}" for alias in node.names if not node.module)
            elif node.module:
                found.add(node.module)
    return found


def test_the_wasi_layer_imports_only_the_standard_library_and_itself() -> None:
    offenders: dict[str, list[str]] = {}
    for path in sorted(WASI.glob("*.py")):
        bad = sorted(
            name
            for name in imported(path)
            if name.split(".")[0] not in sys.stdlib_module_names
            and name != "datum_sandbox.wasi"
            and not name.startswith("datum_sandbox.wasi.")
        )
        if bad:
            offenders[path.name] = bad
    assert offenders == {}


def test_a_relative_import_that_leaves_the_wasi_layer_is_caught(tmp_path: Path) -> None:
    probe = tmp_path / "_probe.py"
    probe.write_text(
        "from .. import checks\nfrom ..protocol import Program\nfrom . import _records\n", encoding="utf-8"
    )
    found = imported(probe, "datum_sandbox.wasi._probe")
    assert {"datum_sandbox.checks", "datum_sandbox.protocol", "datum_sandbox.wasi._records"} <= found


def test_the_library_imports_no_other_datum_distribution() -> None:
    offenders = {
        str(path.relative_to(ROOT)): sorted(
            name
            for name in imported(path)
            if name.split(".")[0] in {"datum_core", "datum_fastapi", "datum_sandbox_wasmtime"}
        )
        for path in ROOT.rglob("*.py")
    }
    assert {name: bad for name, bad in offenders.items() if bad} == {}


def test_the_wasi_layer_names_no_datum_type() -> None:
    for path in WASI.glob("*.py"):
        text = path.read_text(encoding="utf-8")
        for word in ("ProgramKind", "SandboxError", "DatumConfigurationError", "pdf_capable", "APP_PROGRAM"):
            assert word not in text, (path.name, word)
