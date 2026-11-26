"""The programs and fixtures the contract kits run on, read from where the asset build puts them.

Programs, the freeze snippet and fonts come from `argusvane-datum-programs` (checked against its `programs.json`
digests). The fixtures the conformance suite and the PDF kernel pin (the sandbox ABI's golden file, the hardening rules
and the stale program, the endpoint fixture form, the PDF documents and their hashes) are written by the asset build
under `integrations/fastapi/build/fixtures/`; `DATUM_TEST_FIXTURES` names another directory with the same layout.
"""

import hashlib
import json
import os
from functools import cache
from importlib import resources
from pathlib import Path
from typing import Any, Final, cast

from datum_sandbox.protocol import Program, ProgramKind

FIXTURES_ENV: Final = "DATUM_TEST_FIXTURES"
GOLDEN: Final = "abi-4.1.json"
"""The golden file's name; its presence marks a fixtures directory."""
FORM: Final = "endpoint-fixture.definition.json"
HARDENING_RULES: Final = "host-check/hardening-rules.js"
STALE_PROGRAM: Final = "host-check/stale-program.js"
DOCUMENTS: Final = "documents-3.8"

PDF_FONTS: Final[tuple[tuple[str, str, int, str, str], ...]] = (
    ("dejavu-sans", "sans-serif", 400, "normal", "DejaVuSans.ttf"),
    ("dejavu-sans-bold", "sans-serif", 700, "normal", "DejaVuSans-Bold.ttf"),
    ("dejavu-sans-oblique", "sans-serif", 400, "italic", "DejaVuSans-Oblique.ttf"),
    ("dejavu-serif", "serif", 400, "normal", "DejaVuSerif.ttf"),
    ("dejavu-serif-bold", "serif", 700, "normal", "DejaVuSerif-Bold.ttf"),
    ("dejavu-mono", "monospace", 400, "normal", "DejaVuSansMono.ttf"),
    ("dejavu-mono-bold", "monospace", 700, "normal", "DejaVuSansMono-Bold.ttf"),
)
"""The DejaVu pack in the font loader's order: id, family, weight, style, file."""


class FixturesNotFoundError(FileNotFoundError):
    """The asset-built fixtures are not where they are expected."""


def sha256_hex(data: bytes) -> str:
    """Return the lower-case hex SHA-256 of `data`."""
    return hashlib.sha256(data).hexdigest()


@cache
def fixtures_dir() -> Path:
    """Return the fixtures directory: `DATUM_TEST_FIXTURES`, else `build/fixtures` found above this file."""
    named = os.environ.get(FIXTURES_ENV)
    if named:
        found = Path(named)
        if not (found / GOLDEN).is_file():
            raise FixturesNotFoundError(f"{FIXTURES_ENV}={named} has no {GOLDEN}")
        return found
    for parent in Path(__file__).resolve().parents:
        candidate = parent / "build" / "fixtures"
        if (candidate / GOLDEN).is_file():
            return candidate
    raise FixturesNotFoundError(
        f"no build/fixtures/{GOLDEN} above {__file__}: run the asset build (npm run fastapi:assets) "
        f"or set {FIXTURES_ENV}"
    )


def fixture_bytes(name: str) -> bytes:
    """Return one fixture file by its path under the fixtures directory (`documents-3.8/hashes.json`)."""
    path = fixtures_dir() / name
    try:
        return path.read_bytes()
    except FileNotFoundError:
        raise FixturesNotFoundError(f"the fixtures directory has no {name}: run the asset build") from None


def fixture_json(name: str) -> Any:  # noqa: ANN401 - fixtures are plain JSON of many shapes
    """Return a JSON fixture parsed."""
    return json.loads(fixture_bytes(name))


def _resource(name: str) -> bytes:
    return (resources.files("datum_programs") / "resources" / name).read_bytes()


@cache
def _digests() -> dict[str, str]:
    files = json.loads(_resource("programs.json"))["files"]
    return cast("dict[str, str]", files)


def program_file(name: str) -> bytes:
    """Return one `argusvane-datum-programs` file; its digest is checked.

    For example `datum-sandbox-program.js` or `fonts/DejaVuSans.ttf`.
    """
    data = _resource(name)
    want = _digests().get(name)
    if want is None:
        raise FixturesNotFoundError(f"argusvane-datum-programs lists no {name} in programs.json")
    if sha256_hex(data) != want:
        raise FixturesNotFoundError(
            f"argusvane-datum-programs' {name} does not match its digest in programs.json: rebuild the assets"
        )
    return data


def sandbox_program() -> Program:
    """Return the real sandbox program."""
    return Program(ProgramKind.SANDBOX, program_file("datum-sandbox-program.js"))


def pdf_program() -> Program:
    """Return the real PDF program."""
    return Program(ProgramKind.PDF, program_file("datum-pdf-program.js"))


def freeze_snippet() -> str:
    """Return the freeze-intrinsics snippet `run.js` evaluates."""
    return program_file("freeze-intrinsics.js").decode("utf-8")


def font_bytes(file: str) -> bytes:
    """Return one of the bundled DejaVu fonts."""
    return program_file(f"fonts/{file}")


def golden() -> dict[str, Any]:
    """Return the sandbox ABI's golden file: the golden case's length and digest and the control verdicts."""
    return cast("dict[str, Any]", fixture_json(GOLDEN))


def endpoint_form() -> dict[str, Any]:
    """Return the endpoint fixture definition the control vectors run against."""
    return cast("dict[str, Any]", fixture_json(FORM))


def hardening_rules() -> str:
    """Return the security suite's rule module that loops, allocates, answers huge or prints a stray line by `name`."""
    return fixture_bytes(HARDENING_RULES).decode("utf-8")


def stale_program() -> bytes:
    """Return the stand-in program that answers for ABI 2.11.0 only."""
    return fixture_bytes(STALE_PROGRAM)


def pdf_hashes() -> dict[str, str]:
    """Return the SHA-256 each ABI 3.8 theme document must render to, by theme."""
    return cast("dict[str, str]", fixture_json(f"{DOCUMENTS}/hashes.json"))


def pdf_document(theme: str) -> dict[str, Any]:
    """Return one ABI 3.8 theme document."""
    return cast("dict[str, Any]", fixture_json(f"{DOCUMENTS}/{theme}.json"))
