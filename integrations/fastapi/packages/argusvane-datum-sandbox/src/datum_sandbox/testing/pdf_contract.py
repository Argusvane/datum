"""`PdfRenderContract`: the PDF program renders the ABI 3.8 documents to their pinned hashes.

Only a PDF-capable engine implements it.

The requests are the PDF kernel's compatibility test: the fixed environment and the whole DejaVu pack through the PDF
program, each output's SHA-256 equal to `documents-3.8/hashes.json`. An engine that cannot run the PDF program declares
`Capability.PDF` as lacking, so the case is an expected failure.
"""

# ruff: noqa: S101 - a contract is assertions

import base64
import json
from typing import Any, cast

from datum_sandbox.protocol import PDF_ABI_MIN, PDF_RUN_SCRIPT, ProgramLimits, program_run
from datum_sandbox.testing._base import ContractBase
from datum_sandbox.testing.fixtures import (
    PDF_FONTS,
    font_bytes,
    pdf_document,
    pdf_hashes,
    pdf_program,
    sha256_hex,
)
from datum_sandbox.testing.runtime_capabilities import Capability, requires
from datum_sandbox.wasi import GuestRuntime, RunEnd


def pdf_fonts() -> list[dict[str, Any]]:
    """Return the DejaVu pack as the render request carries it: id, family, weight, style and base64 data."""
    return [
        {
            "id": font_id,
            "family": family,
            "weight": weight,
            "style": style,
            "data": base64.b64encode(font_bytes(file)).decode("ascii"),
        }
        for font_id, family, weight, style, file in PDF_FONTS
    ]


def render_request(theme: str, fonts: list[dict[str, Any]]) -> bytes:
    """Return the render request of one theme document with the fixed environment, as UTF-8 JSON."""
    request = {
        "abi": PDF_ABI_MIN,
        "op": "render",
        "document": pdf_document(theme),
        "fonts": fonts,
        "env": {
            "createdAt": "2026-09-05T10:11:12.000Z",
            "documentId": "pdf-theme-sheet",
            "producer": "Datum pdf-theme-sheet",
        },
    }
    return json.dumps(request, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


class PdfRenderContract(ContractBase):
    """The PDF contract; implement it only for a runtime that says it is PDF-capable."""

    @requires(Capability.PDF)
    def test_the_abi_3_8_documents_render_to_their_pinned_hashes(self, runtime: GuestRuntime) -> None:
        """Each theme renders to the PDF whose SHA-256 `hashes.json` pins."""
        # A parity test, not a speed test: 60 s per render rather than the production 15 s, so a loaded runner
        # cannot fail it with a budget stop; the budget itself is proved by the budget cases.
        pdf_budget = ProgramLimits(pdf_time_limit=60).pdf_budget()
        program = pdf_program()
        fonts = pdf_fonts()
        hashes = pdf_hashes()
        assert hashes, "the fixtures pin at least one document"
        for theme, want in hashes.items():
            result = runtime.run(
                program_run(program.data, PDF_RUN_SCRIPT.encode("utf-8"), render_request(theme, fonts), pdf_budget)
            )
            assert result.end is RunEnd.CLEAN, f"{theme}: {result.stderr.decode('utf-8', 'replace')}"
            answer = cast("dict[str, Any]", json.loads(result.stdout))
            assert answer.get("ok") is True, f"{theme}: the program refused the request"
            rendered = base64.b64decode(answer["bytes"])
            assert sha256_hex(rendered) == want, theme
