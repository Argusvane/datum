"""The program store: the packaged programs of argusvane-datum-programs, each held to its SHA-256, or an override.

`programs.json` lists every packaged file's digest and the ABIs the programs declare; a packaged file whose bytes do
not match its digest refuses the start. An override (`datum.runtime.programs.sandbox` or `.pdf`) is read as given and
still proved: the gate asks the program itself, so a declared ABI is never trusted.
"""

import hashlib
import importlib.resources
import importlib.util
import json
from importlib.resources.abc import Traversable
from pathlib import Path
from typing import Final

from datum_sandbox.checks import DatumConfigurationError
from datum_sandbox.protocol._abi import PDF_ABI_MIN, SANDBOX_ABI_MIN
from datum_sandbox.protocol._protocol import Program, ProgramKind

PROGRAMS_PACKAGE: Final = "datum_programs"
_PROGRAMS_DIR: Final = "resources"
SANDBOX_PROGRAM: Final = "datum-sandbox-program.js"
PDF_PROGRAM: Final = "datum-pdf-program.js"
FREEZE_SNIPPET: Final = "freeze-intrinsics.js"
PROGRAM_LIST: Final = "programs.json"


def _resources_of(package: str) -> Traversable:
    if importlib.util.find_spec(package) is None:
        raise DatumConfigurationError(
            f"the {package.replace('_', '-')} distribution is not installed; the runtime needs its programs",
            hint="install argusvane-datum-programs at the version of argusvane-datum-sandbox",
        )
    return importlib.resources.files(package) / _PROGRAMS_DIR


def _program_list() -> dict[str, object]:
    try:
        document: object = json.loads((_resources_of(PROGRAMS_PACKAGE) / PROGRAM_LIST).read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise DatumConfigurationError(
            f"argusvane-datum-programs' {PROGRAM_LIST} cannot be read ({type(error).__name__})",
            hint="reinstall argusvane-datum-programs",
        ) from error
    if not isinstance(document, dict):
        raise DatumConfigurationError(f"argusvane-datum-programs' {PROGRAM_LIST} is not an object", hint="reinstall it")
    return {str(key): value for key, value in document.items()}  # pyright: ignore[reportUnknownVariableType]


def packaged(name: str) -> bytes:
    """Read one of argusvane-datum-programs' files and hold it to its sha256 in `programs.json`."""
    files = _program_list().get("files")
    digest = files.get(name) if isinstance(files, dict) else None  # pyright: ignore[reportUnknownMemberType, reportUnknownVariableType]
    if not isinstance(digest, str):
        raise DatumConfigurationError(
            f"argusvane-datum-programs lists no {name}", hint="reinstall argusvane-datum-programs"
        )
    data = (_resources_of(PROGRAMS_PACKAGE) / name).read_bytes()
    if hashlib.sha256(data).hexdigest() != digest.lower():
        raise DatumConfigurationError(
            f"argusvane-datum-programs' {name} does not match its digest in {PROGRAM_LIST}",
            hint="reinstall argusvane-datum-programs",
        )
    return data


def sandbox_program(path: str | None = None) -> Program:
    """Return the sandbox program: the file `datum.runtime.programs.sandbox` names (still probed), else the packaged."""
    abi = declared_abis()[0]
    if path is None:
        return Program(ProgramKind.SANDBOX, packaged(SANDBOX_PROGRAM), abi)
    try:
        return Program(ProgramKind.SANDBOX, Path(path).read_bytes(), abi)
    except OSError as error:
        raise DatumConfigurationError(
            f"datum.runtime.programs.sandbox names {path}, which cannot be read ({type(error).__name__})",
            hint="point it at the sandbox program file, or unset it to use the packaged program",
        ) from error


def pdf_program(path: str | None = None) -> Program:
    """Return the PDF program: the file `datum.runtime.programs.pdf` names (still probed), else the packaged."""
    abi = declared_abis()[1]
    if path is None:
        return Program(ProgramKind.PDF, packaged(PDF_PROGRAM), abi)
    try:
        return Program(ProgramKind.PDF, Path(path).read_bytes(), abi)
    except OSError as error:
        raise DatumConfigurationError(
            f"datum.runtime.programs.pdf names {path}, which cannot be read ({type(error).__name__})",
            hint="point it at the PDF program file, or unset it to use the packaged program",
        ) from error


def freeze_snippet() -> str:
    """Return the freeze-intrinsics snippet the run script evaluates, from argusvane-datum-programs."""
    return packaged(FREEZE_SNIPPET).decode("utf-8")


def declared_abis() -> tuple[str, str]:
    """Return the sandbox and PDF ABIs argusvane-datum-programs declares, else the floors the gate proves."""
    if importlib.util.find_spec(PROGRAMS_PACKAGE) is None:
        return SANDBOX_ABI_MIN, PDF_ABI_MIN
    try:
        listed = _program_list()
    except DatumConfigurationError:
        return SANDBOX_ABI_MIN, PDF_ABI_MIN
    sandbox_abi, pdf_abi = listed.get("sandboxAbi"), listed.get("pdfAbi")
    return (
        sandbox_abi if isinstance(sandbox_abi, str) else SANDBOX_ABI_MIN,
        pdf_abi if isinstance(pdf_abi, str) else PDF_ABI_MIN,
    )
