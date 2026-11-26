"""Source rules: the builder package is a service, not a route.

It imports no web framework and names no header, status or request; it never reaches for the submission handler, the
submission events, the throttle or the public copy of a stored definition; it is a layer of its own (a sibling of
`submissions`, above `forms`, below `http`).
"""

import ast
import importlib.resources
import tomllib
from pathlib import Path

import pytest

import datum_core

ROOT = Path(datum_core.__file__).resolve().parent
BUILDER = ROOT / "builder"
WEB_WORDS = {"request", "Request", "response", "Response", "status", "status_code", "header", "headers", "HTTPStatus"}
WEB_MODULES = ("fastapi", "starlette", "http", "flask", "django", "litestar", "anyio", "asgiref")
NOT_THE_BUILDERS = (
    "datum_core.submissions",
    "datum_core.throttle",
    "datum_core.http",
    "datum_core.observe",
    "datum_core.datum",
    "datum_core.aio",
)
FORBIDDEN_NAMES = {
    "public_copy",
    "SubmissionHandler",
    "SubmissionValidatedEvent",
    "SubmissionRejectedEvent",
    "SubmissionThrottledEvent",
    "SubmissionRedeliveredEvent",
    "DefinitionCustomizer",
}


def modules() -> list[Path]:
    return sorted(path for path in BUILDER.rglob("*.py") if "__pycache__" not in path.parts)


def imported(tree: ast.AST) -> set[str]:
    found: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            found |= {alias.name for alias in node.names}
        elif isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
            found.add(node.module)
    return found


def names_in(tree: ast.AST) -> set[str]:
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
        elif isinstance(node, ast.alias):
            names.add(node.name.split(".")[-1])
    return names


def test_the_builder_package_exists_and_has_modules_to_scan() -> None:
    assert (BUILDER / "__init__.py").is_file()
    assert modules()


@pytest.mark.parametrize("path", modules(), ids=lambda p: str(p.relative_to(ROOT)))
def test_a_builder_module_imports_no_web_framework_and_names_no_header_status_or_request(path: Path) -> None:
    tree = ast.parse(path.read_text(encoding="utf-8"))
    assert [m for m in imported(tree) if m.split(".")[0] in WEB_MODULES] == []
    assert names_in(tree) & WEB_WORDS == set()


@pytest.mark.parametrize("path", modules(), ids=lambda p: str(p.relative_to(ROOT)))
def test_a_builder_module_imports_none_of_the_layers_above_it_or_beside_it(path: Path) -> None:
    tree = ast.parse(path.read_text(encoding="utf-8"))
    offenders = [m for m in imported(tree) if any(m == bad or m.startswith(bad + ".") for bad in NOT_THE_BUILDERS)]
    assert offenders == []


@pytest.mark.parametrize("path", modules(), ids=lambda p: str(p.relative_to(ROOT)))
def test_a_builder_module_never_names_the_public_copy_the_submission_handler_or_a_submission_event(
    path: Path,
) -> None:
    tree = ast.parse(path.read_text(encoding="utf-8"))
    assert names_in(tree) & FORBIDDEN_NAMES == set()


@pytest.mark.parametrize("path", modules(), ids=lambda p: str(p.relative_to(ROOT)))
def test_a_builder_module_holds_no_http_status_literal(path: Path) -> None:
    tree = ast.parse(path.read_text(encoding="utf-8"))
    offenders = [
        f"{path.name}:{node.lineno} {node.value}"
        for node in ast.walk(tree)
        if isinstance(node, ast.Constant)
        and isinstance(node.value, int)
        and not isinstance(node.value, bool)
        and 400 <= node.value <= 599
    ]
    assert offenders == []


def test_the_builder_modules_catch_no_bare_exception_around_a_hook() -> None:
    """A hook's raise reaches the caller as raised: no `except Exception` may stand between the hook and the caller."""
    offenders: list[str] = []
    for path in modules():
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if isinstance(node, ast.Try):
                for handler in node.handlers:
                    caught = ast.unparse(handler.type) if handler.type is not None else "bare"
                    if caught in {"Exception", "BaseException", "bare"} and any(
                        isinstance(call, ast.Call) and ast.unparse(call.func).endswith(("call_hook", "resolve"))
                        for call in ast.walk(ast.Module(body=node.body, type_ignores=[]))
                    ):
                        offenders.append(f"{path.name}:{handler.lineno}")
    assert offenders == []


# -- the layer ---------------------------------------------------------------------------------------------------------
def test_the_import_contract_lists_the_builder_as_a_sibling_of_submissions_above_forms() -> None:
    pyproject = Path(__file__).resolve().parents[3] / "pyproject.toml"
    document = tomllib.loads(pyproject.read_text(encoding="utf-8"))
    layers = next(
        contract["layers"]
        for contract in document["tool"]["importlinter"]["contracts"]
        if contract.get("type") == "layers" and "datum_core" in contract.get("containers", [])
    )
    sibling_row = next(row for row in layers if "(builder)" in row)
    assert "(submissions)" in sibling_row
    assert layers.index(sibling_row) < layers.index("(forms)")


def test_the_builder_package_is_part_of_the_distribution() -> None:
    assert importlib.resources.files("datum_core").joinpath("builder").is_dir()
