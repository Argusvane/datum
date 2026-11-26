"""The import rules of the timestamp package, read from the source (the layer rules are `lint-imports`'s).

`asn1crypto` is imported in `datum_core/timestamp/_der.py` and nowhere else; `cryptography` only under
`datum_core/timestamp` (the key loader and the signing call), beside the `pdf` subpackage the contract
names and the test PKI helper, `datum_core/testing/tsa_pki.py`; nothing in `src/` runs a subprocess (openssl is a test
cross-check only); and a `SecretStr` is unwrapped at one place per secret (the key loader's two passwords, the client's
two credentials). The scan reads every file under `src/datum_core`, so a module that lands later is covered when it
lands.
"""

import ast
from pathlib import Path

import pytest

import datum_core

ROOT = Path(datum_core.__file__).parent
SOURCES = sorted(path for path in ROOT.rglob("*.py") if "__pycache__" not in path.parts)
CRYPTOGRAPHY_HOMES = ("timestamp/", "pdf/", "testing/tsa_pki.py")
UNWRAP_ALLOWANCE = {"timestamp/keys.py": 1, "timestamp/client.py": 2}


def imports_of(path: Path) -> set[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"))
    found: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            found.update(alias.name.split(".")[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
            found.add(node.module.split(".")[0])
    return found


def relative(path: Path) -> str:
    return path.relative_to(ROOT).as_posix()


def test_the_scan_finds_the_source_tree() -> None:
    assert len(SOURCES) > 100
    assert ROOT / "timestamp" / "protocols.py" in SOURCES


def test_asn1crypto_is_imported_in_der_py_and_nowhere_else() -> None:
    importers = [relative(path) for path in SOURCES if "asn1crypto" in imports_of(path)]
    assert importers == ["timestamp/_der.py"]


def test_cryptography_is_imported_only_under_its_homes() -> None:
    stray = [
        relative(path)
        for path in SOURCES
        if "cryptography" in imports_of(path) and not relative(path).startswith(CRYPTOGRAPHY_HOMES)
    ]
    assert stray == []


def test_the_timestamp_package_imports_cryptography_in_the_key_and_signing_modules_only() -> None:
    importers = {
        relative(path) for path in SOURCES if "cryptography" in imports_of(path) and "timestamp/" in relative(path)
    }
    assert importers
    assert importers <= {
        "timestamp/keys.py",
        "timestamp/certificate.py",
        "timestamp/authority.py",
        "timestamp/token.py",
        "timestamp/_der.py",
    }


def test_no_module_in_the_package_imports_a_web_framework_or_an_http_client() -> None:
    forbidden = {"fastapi", "starlette", "httpx", "httpx2", "requests", "urllib3", "aiohttp"}
    found = {
        relative(path): imports_of(path) & forbidden for path in SOURCES if relative(path).startswith("timestamp/")
    }
    assert {name: hit for name, hit in found.items() if hit} == {}


def test_the_stores_import_nothing_from_the_timestamp_package() -> None:
    """The store seams live in `stores.tsa` (below `timestamp`); a store importing `timestamp` breaks the layering.

    Red against the pre-change tree, where `stores/tsa.py` and `stores/memory.py` imported `timestamp.protocols`.
    """
    importers = [
        relative(path)
        for path in SOURCES
        if relative(path).startswith("stores/")
        for node in ast.walk(ast.parse(path.read_text(encoding="utf-8")))
        if isinstance(node, ast.ImportFrom) and node.module and node.module.startswith("datum_core.timestamp")
    ]
    assert importers == []


def test_the_facade_names_the_store_seams_of_stores_tsa() -> None:
    from datum_core import timestamp  # noqa: PLC0415
    from datum_core.stores import tsa  # noqa: PLC0415

    for name in ("TsaSerialAllocator", "TsaLog", "TsaLogEntry", "TsaClientStore", "TsaClientRecord"):
        assert getattr(timestamp, name) is getattr(tsa, name), name
        assert getattr(tsa, name).__module__ == "datum_core.stores.tsa", name


def test_nothing_in_src_runs_a_subprocess() -> None:
    runners = [relative(path) for path in SOURCES if "subprocess" in imports_of(path)]
    assert runners == []


def test_the_package_does_not_import_the_pdf_or_submissions_layers_it_sits_beside_except_the_receipt_types() -> None:
    allowed = {"timestamp/receipt.py"}
    layers = ("datum_core.pdf", "datum_core.submissions")
    importers = [
        relative(path)
        for path in SOURCES
        if relative(path).startswith("timestamp/")
        for node in ast.walk(ast.parse(path.read_text(encoding="utf-8")))
        if isinstance(node, ast.ImportFrom) and node.module and node.module.startswith(layers)
    ]
    assert set(importers) <= allowed


@pytest.mark.parametrize("module", sorted(UNWRAP_ALLOWANCE))
def test_a_secret_is_unwrapped_at_a_bounded_number_of_places(module: str) -> None:
    path = ROOT / module
    tree = ast.parse(path.read_text(encoding="utf-8"))
    calls = [
        node
        for node in ast.walk(tree)
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == "get_secret_value"
    ]
    assert 1 <= len(calls) <= UNWRAP_ALLOWANCE[module]


def test_no_other_timestamp_module_unwraps_a_secret() -> None:
    unwrapping: list[str] = []
    for path in SOURCES:
        name = relative(path)
        if not name.startswith("timestamp/") or name in UNWRAP_ALLOWANCE:
            continue
        tree = ast.parse(path.read_text(encoding="utf-8"))
        if any(isinstance(n, ast.Attribute) and n.attr == "get_secret_value" for n in ast.walk(tree)):
            unwrapping.append(name)
    assert unwrapping == []


def test_importing_the_package_without_the_extra_works() -> None:
    import subprocess  # noqa: PLC0415 - a fresh interpreter is the only honest probe
    import sys  # noqa: PLC0415

    done = subprocess.run(
        [
            sys.executable,
            "-I",
            "-c",
            (
                "import sys\nfor n in ('asn1crypto','cryptography'): sys.modules[n]=None\n"
                "import datum_core, datum_core.datum, datum_core.timestamp, datum_core.timestamp.protocols\n"
                "print('ok')"
            ),
        ],
        capture_output=True,
        text=True,
        check=False,
        timeout=120,
    )
    assert done.returncode == 0, done.stderr
    assert done.stdout.strip() == "ok"
