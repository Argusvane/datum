"""The timestamp facade: lazy imports, no asn1crypto or cryptography until a name needs them, real types."""

import ast
import importlib
import shutil
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

import datum_core.timestamp as facade

CASES = Path(__file__).parent / "typing_cases"
PACKAGE = Path(facade.__file__ or "").parent
NO_PYRIGHT = shutil.which("node") is None and shutil.which("pyright") is None


def run_python(code: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(  # noqa: S603
        [sys.executable, "-I", "-c", textwrap.dedent(code)], capture_output=True, text=True, check=False, timeout=120
    )


def run_module(*command: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(  # noqa: S603
        [sys.executable, "-m", *command], capture_output=True, text=True, check=False, timeout=600
    )


def test_the_facade_and_the_protocols_import_without_asn1crypto_or_cryptography() -> None:
    result = run_python(
        """
        import sys
        for name in ("asn1crypto", "cryptography"):
            sys.modules[name] = None
        import datum_core.timestamp as t
        assert t.Reading.unavailable("x").instant is None
        assert t.every_channel(lambda d: None).applies_to("seal")
        assert "TimestampQuery" in dir(t) and "Reading" in dir(t)
        assert "asn1crypto" not in sys.modules or sys.modules["asn1crypto"] is None
        print("ok")
        """
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert result.stdout.strip() == "ok"


def test_importing_the_package_imports_no_submodule() -> None:
    result = run_python(
        """
        import sys
        import datum_core.timestamp
        loaded = sorted(m for m in sys.modules if m.startswith("datum_core.timestamp."))
        print(loaded)
        """
    )
    assert result.returncode == 0, result.stderr
    # protocols imports nothing third-party and is the one submodule Datum itself may import at module level.
    assert result.stdout.strip() in ("[]", "['datum_core.timestamp.protocols']")


def module_of(source: str) -> str:
    """The dotted module a `_SOURCES` entry names: a timestamp submodule, or a full path outside the package."""
    return source if "." in source else f"datum_core.timestamp.{source}"


def landed(source: str) -> bool:
    return "." in source or (PACKAGE / f"{source}.py").exists()


def test_each_name_resolves_once_and_is_kept_on_the_package() -> None:
    for name, module in sorted(facade._SOURCES.items()):
        if not landed(module):
            continue
        value = getattr(facade, name)
        assert value is getattr(importlib.import_module(module_of(module)), name)
        assert facade.__dict__[name] is value


def test_a_name_is_listed_and_dir_shows_it() -> None:
    assert set(facade.__all__) == set(facade._SOURCES)
    assert set(facade.__all__) <= set(dir(facade))
    assert facade.__all__ == sorted(facade.__all__)


def test_an_unknown_name_raises_attribute_error() -> None:
    with pytest.raises(AttributeError, match="NoSuchName"):
        facade.NoSuchName  # noqa: B018
    # Python binds an imported submodule on its package, so the facade never OFFERS _der rather than never holding it.
    assert "_der" not in facade.__all__
    assert "_der" not in facade._SOURCES  # pyright: ignore[reportPrivateUsage]
    with pytest.raises(AttributeError):
        facade.__getattr__("_der")


def test_a_name_whose_submodule_exists_is_imported_for_the_type_checkers() -> None:
    tree = ast.parse((PACKAGE / "__init__.py").read_text())
    shown: dict[str, set[str]] = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module and node.module.startswith("datum_core."):
            shown.setdefault(node.module, set()).update(a.name for a in node.names)
    for name, module in facade._SOURCES.items():
        if landed(module):
            assert name in shown.get(module_of(module), set()), f"{name} must be imported from {module}"
    for module, names in shown.items():
        assert {n for n, m in facade._SOURCES.items() if module_of(m) == module} >= names


def test_mypy_strict_sees_the_real_types_through_the_facade() -> None:
    good = CASES / "timestamp_facade_good.py"
    result = run_module("mypy", "--config-file", str(CASES / "mypy.ini"), "--no-incremental", str(good))
    assert result.returncode == 0, result.stdout + result.stderr


@pytest.mark.skipif(NO_PYRIGHT, reason="pyright needs node or its wrapper")
def test_pyright_strict_sees_the_same_types() -> None:
    good = CASES / "timestamp_facade_good.py"
    result = run_module("pyright", "--project", str(CASES), "--pythonpath", sys.executable, str(good))
    assert result.returncode == 0, result.stdout + result.stderr


def test_a_wrong_type_through_the_facade_is_an_error(tmp_path: Path) -> None:
    target = tmp_path / "timestamp_facade_bad.py"
    shutil.copy(CASES / "timestamp_facade_bad.py.txt", target)
    shutil.copy(CASES / "mypy.ini", tmp_path / "mypy.ini")
    mypy = run_module("mypy", "--config-file", str(tmp_path / "mypy.ini"), "--no-incremental", str(target))
    assert mypy.returncode == 1, mypy.stdout + mypy.stderr
    errors = [row for row in mypy.stdout.splitlines() if ": error: " in row]
    assert len(errors) == 1, mypy.stdout
    assert errors[0].startswith(f"{target}:9: error: "), mypy.stdout
    assert errors[0].endswith("[assignment]"), mypy.stdout


def test_a_not_yet_landed_name_fails_naming_its_module_and_the_facade_stays_lazy() -> None:
    pending = sorted(n for n, m in facade._SOURCES.items() if not landed(m))
    result = run_python(
        f"""
        import sys
        for name in ("asn1crypto", "cryptography"):
            sys.modules[name] = None
        import datum_core.timestamp as t
        import importlib
        for name in {pending!r}:
            module = t._SOURCES[name]
            try:
                getattr(t, name)
            except ModuleNotFoundError as exc:
                assert exc.name == "datum_core.timestamp." + module, (name, exc.name)
            else:
                print("landed", name)
        print("done")
        """
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert result.stdout.strip().endswith("done")


def test_the_facade_pins_the_briefs_names() -> None:
    protocols_part = {
        "HTTP_CHANNEL",
        "Reading",
        "TimestampChannel",
        "TimestampFailure",
        "TimestampGrant",
        "TimestampRefusedError",
        "TimestampRequestCustomizer",
        "TimestampRequestDraft",
        "TimestampRequestHook",
        "Timestamper",
        "TransportReply",
        "TsaKeyMaterial",
        "TsaTimeSource",
        "TsaTransport",
        "every_channel",
    }
    stores_part = {"TsaClientRecord", "TsaClientStore", "TsaLog", "TsaLogEntry", "TsaSerialAllocator"}
    others = {
        "TimestampQuery",
        "TimestampRefusal",
        "TimestampToken",
        "TimestampAuthority",
        "KeyFileTsaKeyMaterial",
        "TsaCertificateRules",
        "SelfSignedTsaCertificate",
        "TimestampClient",
        "ReceiptStatement",
        "TimestampAnswer",
        "TimestampClientError",
        "TimestampClientGrant",
        "HttpTsaTransport",
        "ReplyTooLargeError",
    }
    assert set(facade.__all__) == protocols_part | stores_part | others
    protocols = importlib.import_module("datum_core.timestamp.protocols")
    assert set(protocols.__all__) == protocols_part
    tree = ast.parse((PACKAGE / "__init__.py").read_text())
    shown = {
        a.name
        for node in ast.walk(tree)
        if isinstance(node, ast.ImportFrom) and node.module == "datum_core.timestamp.protocols"
        for a in node.names
    }
    assert shown == protocols_part
