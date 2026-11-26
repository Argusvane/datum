"""The import and exposure rules of the PDF package, read from the source (the layer rules are `lint-imports`'s).

`cryptography` only under the capability modules (`pdf`, `timestamp`, and the test PKI `testing/tsa_pki.py`);
`pyhanko_certvalidator` only in `pdf/revocation.py`, always beside `argusvane-datum-core[revocation]`; `asn1crypto`
stays in `timestamp/_der.py`, and neither it nor `oscrypto` nor `aiohttp` is imported anywhere under `pdf` (the adapter
hands the library bytes); nothing in `src/` runs a subprocess; the package imports no web framework, no HTTP client and
no `observe` (it keeps its own tracer, as `timestamp` does); `protocols.py` imports nothing third-party; no module
exports the private key (`private_bytes`, `private_numbers`) or unwraps a secret; and the package names no header and no
status: that is `datum_core.http`'s. Fresh-interpreter probes show `import datum_core.pdf` works without either extra
and that a name needing the missing extra fails naming it. The scan reads every file under `src/datum_core`, so a module
that lands later is covered when it lands.
"""

import ast
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

import datum_core

ROOT = Path(datum_core.__file__).parent
SOURCES = sorted(path for path in ROOT.rglob("*.py") if "__pycache__" not in path.parts)
PDF = sorted(path for path in SOURCES if path.relative_to(ROOT).parts[0] == "pdf")
WEB = {"fastapi", "starlette", "httpx", "httpx2", "requests", "urllib3", "aiohttp", "flask", "django", "anyio"}
FORBIDDEN_ATTRIBUTES = {"private_bytes", "private_bytes_raw", "private_numbers", "get_secret_value"}
THIRD_PARTY_OK_IN_PDF = {"cryptography", "pyhanko_certvalidator", "pydantic", "opentelemetry"}


def relative(path: Path) -> str:
    return path.relative_to(ROOT).as_posix()


def tree_of(path: Path) -> ast.Module:
    return ast.parse(path.read_text(encoding="utf-8"))


def imports_of(path: Path) -> set[str]:
    found: set[str] = set()
    for node in ast.walk(tree_of(path)):
        if isinstance(node, ast.Import):
            found.update(alias.name.split(".")[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
            found.add(node.module.split(".")[0])
    return found


def modules_imported(path: Path) -> set[str]:
    found: set[str] = set()
    for node in ast.walk(tree_of(path)):
        if isinstance(node, ast.Import):
            found.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
            found.add(node.module)
    return found


def run_python(code: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(  # noqa: S603
        [sys.executable, "-I", "-c", textwrap.dedent(code)], capture_output=True, text=True, check=False, timeout=180
    )


def test_the_scan_finds_the_pdf_package_and_the_expected_modules() -> None:
    names = {relative(path) for path in PDF}
    assert {"pdf/__init__.py", "pdf/protocols.py"} <= names
    assert {
        "pdf/signer.py",
        "pdf/trust.py",
        "pdf/revocation.py",
        "pdf/verify.py",
        "pdf/seal.py",
        "pdf/service.py",
        "pdf/outcomes.py",
    } <= names, "the PDF signing, trust, revocation, verify, seal, service and outcome modules exist"


def test_cryptography_is_imported_only_under_its_homes() -> None:
    homes = ("timestamp/", "pdf/", "testing/tsa_pki.py")
    stray = [relative(p) for p in SOURCES if "cryptography" in imports_of(p) and not relative(p).startswith(homes)]
    assert stray == []


def test_pyhanko_certvalidator_is_imported_in_the_revocation_adapter_and_nowhere_else() -> None:
    importers = [relative(path) for path in SOURCES if "pyhanko_certvalidator" in imports_of(path)]
    assert importers == ["pdf/revocation.py"]


@pytest.mark.parametrize("name", ["asn1crypto", "oscrypto", "aiohttp"])
def test_the_pdf_package_never_imports_the_certvalidators_hard_requirements(name: str) -> None:
    assert [relative(path) for path in PDF if name in imports_of(path)] == []


def test_asn1crypto_is_still_imported_in_der_py_and_nowhere_else() -> None:
    assert [relative(path) for path in SOURCES if "asn1crypto" in imports_of(path)] == ["timestamp/_der.py"]


def test_oscrypto_and_aiohttp_are_imported_nowhere_in_src() -> None:
    assert [relative(path) for path in SOURCES if imports_of(path) & {"oscrypto", "aiohttp"}] == []


def test_nothing_in_src_runs_a_subprocess_or_a_shell() -> None:
    runners = [
        relative(path)
        for path in SOURCES
        if imports_of(path) & {"subprocess", "pty"}
        or any(
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and node.func.attr in {"system", "popen"}
            and isinstance(node.func.value, ast.Name)
            and node.func.value.id == "os"
            for node in ast.walk(tree_of(path))
        )
    ]
    assert runners == []


def test_the_pdf_package_imports_no_web_framework_no_http_client_and_no_anyio() -> None:
    assert {relative(path): imports_of(path) & WEB for path in PDF if imports_of(path) & WEB} == {}
    assert [relative(path) for path in PDF if "datum_fastapi" in imports_of(path)] == []


def test_the_pdf_package_imports_only_the_standard_library_datum_and_the_libraries_it_is_for() -> None:
    stdlib = set(sys.stdlib_module_names)
    stray = {
        relative(path): sorted(imports_of(path) - stdlib - {"datum_core", "datum_sandbox"} - THIRD_PARTY_OK_IN_PDF)
        for path in PDF
        if imports_of(path) - stdlib - {"datum_core", "datum_sandbox"} - THIRD_PARTY_OK_IN_PDF
    }
    assert stray == {}


def test_the_protocols_import_nothing_third_party() -> None:
    stdlib = set(sys.stdlib_module_names)
    assert imports_of(ROOT / "pdf" / "protocols.py") - stdlib - {"datum_core", "datum_sandbox"} == set()


def test_the_pdf_package_keeps_its_own_tracer_and_does_not_import_observe() -> None:
    importers = [relative(path) for path in PDF if "datum_core.observe" in modules_imported(path)]
    assert importers == []


def test_timestamp_and_sandbox_never_import_pdf_and_nothing_below_the_capabilities_does() -> None:
    below = ("timestamp/", "sandbox/", "stores/", "hooks.py", "events.py", "config/", "json/")
    importers = [
        relative(path)
        for path in SOURCES
        if relative(path).startswith(below) and any(m.startswith("datum_core.pdf") for m in modules_imported(path))
    ]
    # `sandbox/_pdf.py` and `events.py` hold the kernel Protocol and the event records; they never import the package.
    assert importers == []


def test_the_pdf_package_may_use_the_timestamp_and_sandbox_packages() -> None:
    used = {m for path in PDF for m in modules_imported(path) if m.startswith(("datum_core.", "datum_sandbox."))}
    assert any(m.startswith("datum_core.timestamp") for m in used)
    assert any(m.startswith("datum_sandbox.protocol") for m in used)


def test_no_pdf_module_exports_the_private_key_or_unwraps_a_secret() -> None:
    offenders = [
        f"{relative(path)}:{node.attr}"
        for path in PDF
        for node in ast.walk(tree_of(path))
        if isinstance(node, ast.Attribute) and node.attr in FORBIDDEN_ATTRIBUTES
    ]
    assert offenders == []


def test_no_pdf_module_prints_or_names_a_header_or_a_status_line() -> None:
    forbidden_words = (
        "X-Signed-By",
        "X-Page-Count",
        "X-Signature-Field",
        "X-Datum-Layout",
        "X-Datum-Pdf-Theme",
        "Content-Type",
        "Retry-After",
    )
    offenders: list[str] = []
    for path in PDF:
        text = path.read_text(encoding="utf-8")
        offenders += [f"{relative(path)}:{word}" for word in forbidden_words if word in text]
        offenders += [
            f"{relative(path)}:print"
            for node in ast.walk(tree_of(path))
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "print"
        ]
    assert offenders == []


def test_the_http_module_is_where_the_headers_are() -> None:
    text = (ROOT / "http" / "pdf.py").read_text(encoding="utf-8")
    for word in ("X-Signed-By", "X-Page-Count", "X-Signature-Field", "X-Datum-Layout", "X-Datum-Pdf-Theme"):
        assert word in text


# -- fresh interpreters: the extras ------------------------------------------------------------------------------------
def test_the_package_imports_without_cryptography_and_without_the_revocation_library() -> None:
    done = run_python(
        """
        import sys
        for name in ("cryptography", "pyhanko_certvalidator", "asn1crypto"):
            sys.modules[name] = None
        import datum_core, datum_core.datum, datum_core.pdf, datum_core.pdf.protocols
        import datum_sandbox.protocol
        from datum_sandbox.protocol import PdfKernelService, compose_pdf_kernel
        assert "PdfSigner" in dir(datum_core.pdf)
        loaded = sorted(m for m in sys.modules if m.startswith("datum_core.pdf."))
        print(loaded)
        """
    )
    assert done.returncode == 0, done.stderr
    assert done.stdout.strip() in ("[]", "['datum_core.pdf.protocols']")


def test_a_name_that_needs_cryptography_fails_naming_the_pdf_extra() -> None:
    done = run_python(
        """
        import sys
        sys.modules["cryptography"] = None
        import datum_core.pdf as pdf
        try:
            pdf.KeyFilePdfSigner
        except ModuleNotFoundError as error:
            print(str(error))
        else:
            print("imported")
        """
    )
    assert done.returncode == 0, done.stderr
    assert "argusvane-datum-core[pdf]" in done.stdout


def test_the_trust_policy_works_without_the_revocation_extra_and_the_adapter_names_the_extra() -> None:
    done = run_python(
        """
        import sys
        sys.modules["pyhanko_certvalidator"] = None
        from datum_core.pdf import PdfTrustPolicy
        policy = PdfTrustPolicy(anchors=())
        assert policy.revocation is None
        try:
            from datum_core.pdf import CertvalidatorRevocationChecker
        except ModuleNotFoundError as error:
            print(str(error))
        else:
            print("imported")
        """
    )
    assert done.returncode == 0, done.stderr
    assert "argusvane-datum-core[revocation]" in done.stdout
