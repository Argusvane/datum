"""The pieces of a PDF program request the service writes (`datum.pdf.fonts`, the verify caps).

`PdfService` stamps nothing here: the kernel service adds `abi` and `op`. This module answers the parts that are the
host's to supply and that no customizer chooses for it:

- the font faces of `datum.pdf.fonts`, read once from `argusvane-datum-programs` (`default`: DejaVu Sans and Sans Bold;
  `standard`: those, Sans Oblique, Serif and Serif Bold; `all`: those and Sans Mono, Mono Bold), each held to its
  SHA-256 in the package's `programs.json`; the ids, families, weights, styles and coverage are the PDF kernel's own
  font pack's;
- the document's identity and time (`env`): a fresh `secrets.token_hex(16)` for posted answers, the
  submission's digest for an accepted one; `createdAt` the clock's instant in UTC;
- the layouts of a definition and whether a template is inline base64, the only supported source;
- the known certificates of a verify request, within the program's caps (at most 64, each at most 16 KiB of DER);
- the program's warnings as `HookProblem`s.

Libraries: the standard library (`importlib.resources`, `hashlib`, `secrets`, `base64`, `json`, `functools`)
covers all of it; no class is written here.
"""

import base64
import functools
import hashlib
import importlib.resources
import importlib.util
import json
import secrets
from collections.abc import Iterable, Mapping, Sequence
from datetime import UTC, datetime
from importlib.resources.abc import Traversable
from typing import Final, cast

from datum_core.config.models import PdfFonts
from datum_core.hooks import HookProblem
from datum_sandbox.checks import DatumConfigurationError
from datum_sandbox.json import JsonValue
from datum_sandbox.protocol import PdfWarning

__all__ = [
    "KNOWN_CERTIFICATE_BYTES",
    "KNOWN_CERTIFICATE_COUNT",
    "b64",
    "find_layout",
    "font_resources",
    "iso_instant",
    "known_certificates",
    "new_document_id",
    "problems_of",
    "template_problem",
]

KNOWN_CERTIFICATE_COUNT: Final = 64
"""The most certificates a verify request may name (the program refuses more)."""
KNOWN_CERTIFICATE_BYTES: Final = 16 * 1024
"""The largest DER certificate a verify request may name (the program refuses larger)."""

_PROGRAMS: Final = "datum_programs"
_RESOURCES: Final = "resources"
_PROGRAM_LIST: Final = "programs.json"
_FACES: Final[tuple[tuple[str, str, int, str, str, tuple[str, ...]], ...]] = (
    ("dejavu-sans", "sans-serif", 400, "normal", "DejaVuSans.ttf", ("Latn", "Grek", "Cyrl", "Arab", "Hebr")),
    ("dejavu-sans-bold", "sans-serif", 700, "normal", "DejaVuSans-Bold.ttf", ("Latn", "Grek", "Cyrl", "Arab", "Hebr")),
    ("dejavu-sans-oblique", "sans-serif", 400, "italic", "DejaVuSans-Oblique.ttf", ("Latn", "Grek", "Cyrl")),
    ("dejavu-serif", "serif", 400, "normal", "DejaVuSerif.ttf", ("Latn", "Grek", "Cyrl")),
    ("dejavu-serif-bold", "serif", 700, "normal", "DejaVuSerif-Bold.ttf", ("Latn", "Grek", "Cyrl")),
    ("dejavu-mono", "monospace", 400, "normal", "DejaVuSansMono.ttf", ("Latn", "Grek", "Cyrl")),
    ("dejavu-mono-bold", "monospace", 700, "normal", "DejaVuSansMono-Bold.ttf", ("Latn", "Grek", "Cyrl")),
)
_FACE_COUNT: Final[Mapping[PdfFonts, int]] = {PdfFonts.DEFAULT: 2, PdfFonts.STANDARD: 5, PdfFonts.ALL: 7}
_WARNING_CODE: Final = "pdf.warning"


def b64(data: bytes) -> str:
    """Return the base64 text of `data`."""
    return base64.b64encode(data).decode("ascii")


def iso_instant(moment: datetime) -> str:
    """Return `moment` in UTC as ISO 8601 with a `Z` (a naive instant is read as UTC)."""
    aware = moment if moment.tzinfo is not None else moment.replace(tzinfo=UTC)
    return aware.astimezone(UTC).isoformat().replace("+00:00", "Z")


def new_document_id() -> str:
    """Return the identity of a document printed from posted answers: 32 random hex digits."""
    return secrets.token_hex(16)


# -- fonts -------------------------------------------------------------------------------------------------------------


def font_resources(choice: PdfFonts | str) -> tuple[Mapping[str, JsonValue], ...]:
    """Return the font resources of `datum.pdf.fonts` (read once per choice); each request gets its own list of them."""
    return _fonts(PdfFonts(choice))


@functools.cache
def _fonts(choice: PdfFonts) -> tuple[Mapping[str, JsonValue], ...]:
    listed = _listed_files()
    resources: list[Mapping[str, JsonValue]] = []
    for face_id, family, weight, style, file, coverage in _FACES[: _FACE_COUNT[choice]]:
        name = f"fonts/{file}"
        data = (_resources() / name).read_bytes()
        digest = listed.get(name)
        if not isinstance(digest, str) or hashlib.sha256(data).hexdigest() != digest.lower():
            raise DatumConfigurationError(
                f"argusvane-datum-programs' {name} does not match its digest in {_PROGRAM_LIST}",
                hint="reinstall argusvane-datum-programs",
            )
        resources.append(
            {
                "id": face_id,
                "family": family,
                "weight": weight,
                "style": style,
                "data": b64(data),
                "coverage": list(coverage),
            }
        )
    return tuple(resources)


def _resources() -> Traversable:
    if importlib.util.find_spec(_PROGRAMS) is None:
        raise DatumConfigurationError(
            "the argusvane-datum-programs distribution is not installed; PDFs need its fonts",
            hint="install argusvane-datum-programs at the version of argusvane-datum-core",
        )
    return importlib.resources.files(_PROGRAMS) / _RESOURCES


def _listed_files() -> Mapping[str, object]:
    try:
        listed: object = json.loads((_resources() / _PROGRAM_LIST).read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise DatumConfigurationError(
            f"argusvane-datum-programs' {_PROGRAM_LIST} cannot be read ({type(error).__name__})",
            hint="reinstall argusvane-datum-programs",
        ) from error
    files = cast("Mapping[str, object]", listed).get("files") if isinstance(listed, dict) else None
    return cast("Mapping[str, object]", files) if isinstance(files, dict) else {}


# -- layouts -----------------------------------------------------------------------------------------------------------


def find_layout(definition: Mapping[str, JsonValue], layout_id: str) -> Mapping[str, JsonValue] | None:
    """Return the layout of `definition`'s `pdf` block whose `id` is `layout_id`, or None."""
    block = definition.get("pdf")
    layouts = block.get("layouts") if isinstance(block, dict) else None
    if not isinstance(layouts, list):
        return None
    for layout in layouts:
        if isinstance(layout, dict) and layout.get("id") == layout_id:
            return layout
    return None


def template_problem(layout: Mapping[str, JsonValue]) -> str | None:
    """Return why a template layout cannot be printed, or None when its template is inline base64.

    The reason names the storage word only, never a reference or a path (it is logged, not answered).
    """
    template = layout.get("template")
    if not isinstance(template, dict):
        return "the template layout has no template"
    storage = template.get("storage", "base64")
    if storage != "base64":
        word = storage if isinstance(storage, str) and storage.isascii() and len(storage) <= 32 else "another"  # noqa: PLR2004
        return f"its template is kept in {word} storage, and only an inline base64 template is read"
    if not isinstance(template.get("data"), str) or not template.get("data"):
        return "its template carries no inline base64 data"
    return None


# -- verify ------------------------------------------------------------------------------------------------------------


def known_certificates(groups: Iterable[Iterable[bytes]]) -> list[str]:
    """Return the DER certificates of `groups`, in order, each once, within the program's caps, as base64.

    The first group's certificates come first, so the server's own chain is never the one cut; a certificate over
    16 KiB is left out.
    """
    seen: set[bytes] = set()
    kept: list[str] = []
    for group in groups:
        for der in group:
            item = bytes(der)
            if item in seen or not item or len(item) > KNOWN_CERTIFICATE_BYTES:
                continue
            seen.add(item)
            kept.append(b64(item))
            if len(kept) == KNOWN_CERTIFICATE_COUNT:
                return kept
    return kept


# -- warnings ----------------------------------------------------------------------------------------------------------


def problems_of(warnings: Sequence[PdfWarning]) -> tuple[HookProblem, ...]:
    """Return the program's warnings as findings: the component (else the block) as the field, the code and message.

    A code outside the hook alphabet reads `pdf.warning`.
    """
    found: list[HookProblem] = []
    for warning in warnings:
        place = warning.component_id or warning.block_id
        try:
            found.append(HookProblem(place, warning.code, warning.message))
        except ValueError:
            found.append(HookProblem(place, _WARNING_CODE, warning.message))
    return tuple(found)
