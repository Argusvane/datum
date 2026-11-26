"""The PDF facade: lazy imports, no cryptography until a name needs it, real types, the extras."""

import ast
import importlib
import shutil
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

import datum_core.pdf as facade

CASES = Path(__file__).parent / "typing_cases"
PACKAGE = Path(facade.__file__ or "").parent
NO_PYRIGHT = shutil.which("node") is None and shutil.which("pyright") is None

PROTOCOL_NAMES = {
    "PDF_TRUST_WORDS",
    "PdfKernelMiddleware",
    "PdfOperation",
    "PdfRequestCustomizer",
    "PdfRequestDraft",
    "PdfResultCandidate",
    "PdfResultValidator",
    "PdfSignatureAlgorithm",
    "PdfSigner",
    "PdfTrustVerdict",
    "PdfTrustWord",
    "PdfValidationTime",
    "PdfValueVerdict",
    "RevocationChecker",
    "RevocationStatus",
}
LATER_NAMES = {
    "KeyFilePdfSigner": "signer",
    "TestSealSigner": "signer",
    "PdfTrustPolicy": "trust",
    "PdfTrustPolicySummary": "trust",
    "CertvalidatorRevocationChecker": "revocation",
    "PdfVerifyReport": "verify",
    "SignatureVerdict": "verify",
    "PdfService": "service",
    "PdfSeal": "seal",
    "TimestampSource": "seal",
    "LayoutNotFound": "outcomes",
    "LayoutNotTemplate": "outcomes",
    "NotAPdf": "outcomes",
    "PdfError": "outcomes",
    "PdfSignatureError": "outcomes",
    "PdfOutcome": "outcomes",
    "PdfUnavailableError": "outcomes",
    "Printed": "outcomes",
    "ResultRejected": "outcomes",
    "SealWord": "outcomes",
    "Unreadable": "outcomes",
    "Verified": "outcomes",
    "VerifyOutcome": "outcomes",
}


def run_python(code: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(  # noqa: S603
        [sys.executable, "-I", "-c", textwrap.dedent(code)], capture_output=True, text=True, check=False, timeout=120
    )


def run_module(*command: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(  # noqa: S603
        [sys.executable, "-m", *command], capture_output=True, text=True, check=False, timeout=600
    )


def test_the_facade_and_the_protocols_import_without_cryptography_or_certvalidator() -> None:
    result = run_python(
        """
        import sys
        for name in ("cryptography", "pyhanko_certvalidator", "oscrypto", "aiohttp"):
            sys.modules[name] = None
        import datum_core.pdf as p
        assert p.PdfTrustVerdict("unknown").word == "unknown"
        assert p.PdfValidationTime.NOW == "now"
        assert p.PDF_TRUST_WORDS[0] == "site"
        assert "PdfSigner" in dir(p) and "PdfService" in dir(p)
        for name in ("cryptography", "pyhanko_certvalidator"):
            assert sys.modules[name] is None
        print("ok")
        """
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert result.stdout.strip() == "ok"


def test_importing_the_package_imports_no_submodule() -> None:
    result = run_python(
        """
        import sys
        import datum_core.pdf
        print(sorted(m for m in sys.modules if m.startswith("datum_core.pdf.")))
        """
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "[]"


def test_touching_a_name_imports_only_its_submodule() -> None:
    result = run_python(
        """
        import sys
        import datum_core.pdf as p
        p.PdfSigner
        print(sorted(m for m in sys.modules if m.startswith("datum_core.pdf.")))
        print("cryptography" in sys.modules)
        """
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout.splitlines() == ["['datum_core.pdf.protocols']", "False"]


def test_each_name_resolves_once_and_is_kept_on_the_package() -> None:
    for name, module in sorted(facade._SOURCES.items()):
        if not (PACKAGE / f"{module}.py").exists():
            continue
        value = getattr(facade, name)
        assert value is getattr(importlib.import_module(f"datum_core.pdf.{module}"), name)
        assert facade.__dict__[name] is value


def test_a_name_is_listed_and_dir_shows_it() -> None:
    assert set(facade.__all__) == set(facade._SOURCES)
    assert set(facade.__all__) <= set(dir(facade))
    assert len(facade.__all__) == len(set(facade.__all__))


def test_an_unknown_name_raises_attribute_error() -> None:
    with pytest.raises(AttributeError, match="NoSuchName"):
        facade.NoSuchName  # noqa: B018
    with pytest.raises(AttributeError):
        facade.__getattr__("protocols_private")


def test_a_name_whose_submodule_exists_is_imported_for_the_type_checkers() -> None:
    tree = ast.parse((PACKAGE / "__init__.py").read_text())
    shown: dict[str, set[str]] = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module and node.module.startswith("datum_core.pdf."):
            shown.setdefault(node.module.rsplit(".", 1)[1], set()).update(a.name for a in node.names)
    for name, module in facade._SOURCES.items():
        if (PACKAGE / f"{module}.py").exists():
            assert name in shown.get(module, set()), f"{name} must be imported from {module} under TYPE_CHECKING"
    for module, names in shown.items():
        assert {n for n, m in facade._SOURCES.items() if m == module} >= names


def test_the_imports_for_the_type_checkers_sit_under_type_checking_only() -> None:
    tree = ast.parse((PACKAGE / "__init__.py").read_text())
    for node in tree.body:
        if isinstance(node, ast.ImportFrom):
            assert node.module not in {f"datum_core.pdf.{x}" for x in ("protocols", *LATER_NAMES.values())}
        if isinstance(node, ast.Import):
            assert {a.name for a in node.names} <= {"importlib"}


def test_the_facade_pins_the_briefs_names() -> None:
    assert set(facade.__all__) == PROTOCOL_NAMES | set(LATER_NAMES)
    for name, module in LATER_NAMES.items():
        assert facade._SOURCES[name] == module
    protocols = importlib.import_module("datum_core.pdf.protocols")
    assert set(protocols.__all__) == PROTOCOL_NAMES
    assert {facade._SOURCES[n] for n in PROTOCOL_NAMES} == {"protocols"}
    tree = ast.parse((PACKAGE / "__init__.py").read_text())
    shown = {
        a.name
        for node in ast.walk(tree)
        if isinstance(node, ast.ImportFrom) and node.module == "datum_core.pdf.protocols"
        for a in node.names
    }
    assert shown == PROTOCOL_NAMES


def test_mypy_strict_sees_the_real_types_through_the_facade() -> None:
    good = CASES / "pdf_facade_good.py"
    result = run_module("mypy", "--config-file", str(CASES / "mypy.ini"), "--no-incremental", str(good))
    assert result.returncode == 0, result.stdout + result.stderr


@pytest.mark.skipif(NO_PYRIGHT, reason="pyright needs node or its wrapper")
def test_pyright_strict_sees_the_same_types() -> None:
    good = CASES / "pdf_facade_good.py"
    result = run_module("pyright", "--project", str(CASES), "--pythonpath", sys.executable, str(good))
    assert result.returncode == 0, result.stdout + result.stderr


def test_a_wrong_type_through_the_facade_is_an_error(tmp_path: Path) -> None:
    target = tmp_path / "pdf_facade_bad.py"
    shutil.copy(CASES / "pdf_facade_bad.py.txt", target)
    shutil.copy(CASES / "mypy.ini", tmp_path / "mypy.ini")
    mypy = run_module("mypy", "--config-file", str(tmp_path / "mypy.ini"), "--no-incremental", str(target))
    assert mypy.returncode == 1, mypy.stdout + mypy.stderr
    errors = [row for row in mypy.stdout.splitlines() if ": error: " in row]
    assert len(errors) == 1, mypy.stdout
    assert errors[0].startswith(f"{target}:16: error: "), mypy.stdout
    assert errors[0].endswith("[assignment]"), mypy.stdout


def test_a_not_yet_landed_name_fails_naming_its_module_and_the_facade_stays_lazy() -> None:
    pending = sorted(n for n, m in facade._SOURCES.items() if not (PACKAGE / f"{m}.py").exists())
    result = run_python(
        f"""
        import sys
        for name in ("cryptography", "pyhanko_certvalidator"):
            sys.modules[name] = None
        import datum_core.pdf as p
        for name in {pending!r}:
            module = p._SOURCES[name]
            try:
                getattr(p, name)
            except ModuleNotFoundError as exc:
                assert exc.name == "datum_core.pdf." + module, (name, exc.name)
            else:
                print("landed", name)
        print("done")
        """
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert result.stdout.strip().endswith("done")


@pytest.mark.parametrize(
    ("missing", "extra"),
    [("cryptography", "argusvane-datum-core[pdf]"), ("pyhanko_certvalidator", "argusvane-datum-core[revocation]")],
)
def test_a_missing_extra_is_named_in_the_error(monkeypatch: pytest.MonkeyPatch, missing: str, extra: str) -> None:
    def fake(name: str) -> object:
        raise ModuleNotFoundError(f"No module named {missing!r}", name=f"{missing}.hazmat")

    monkeypatch.setitem(facade._SOURCES, "FakeName", "fakemodule")
    monkeypatch.setattr(importlib, "import_module", fake)
    with pytest.raises(ModuleNotFoundError, match=extra.replace("[", r"\[").replace("]", r"\]")) as caught:
        facade.__getattr__("FakeName")
    assert "FakeName" in str(caught.value)
    assert caught.value.name == f"{missing}.hazmat"
    assert "FakeName" not in facade.__dict__


def test_a_missing_module_that_is_not_an_extra_is_raised_untouched(monkeypatch: pytest.MonkeyPatch) -> None:
    def fake(name: str) -> object:
        raise ModuleNotFoundError("No module named 'elsewhere'", name="elsewhere")

    monkeypatch.setitem(facade._SOURCES, "FakeName", "fakemodule")
    monkeypatch.setattr(importlib, "import_module", fake)
    with pytest.raises(ModuleNotFoundError) as caught:
        facade.__getattr__("FakeName")
    assert str(caught.value) == "No module named 'elsewhere'"


BLOCKED = [("pyhanko_certvalidator", "argusvane-datum-core[revocation]"), ("cryptography", "argusvane-datum-core[pdf]")]


@pytest.mark.parametrize(("blocked", "extra"), BLOCKED)
def test_a_blocked_dependency_names_its_extra_for_every_landed_name(blocked: str, extra: str) -> None:
    revocation = blocked == "pyhanko_certvalidator"
    names = sorted(
        n
        for n, m in facade._SOURCES.items()
        if m != "protocols" and (m == "revocation") == revocation and (PACKAGE / f"{m}.py").exists()
    )
    if not names:
        pytest.skip(f"no submodule needing {extra} has landed yet; it must turn green when one does")
    result = run_python(
        f"""
        import sys
        sys.modules[{blocked!r}] = None
        import datum_core.pdf as p
        for name in {names!r}:
            try:
                getattr(p, name)
            except ModuleNotFoundError as exc:
                assert {extra!r} in str(exc), (name, str(exc))
                assert exc.name == {blocked!r}, (name, exc.name)
            else:
                raise AssertionError(name + " resolved without {blocked}")
        assert p.PdfTrustVerdict("unknown").word == "unknown"
        print("done")
        """
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert result.stdout.strip().endswith("done")
