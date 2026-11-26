import { accepted, all, vector } from "./helpers.js";
import type { Attacker, Severity, Vector } from "./schema.js";

/**
 * OUT: the PDF output vectors. They run only in the pdf runner
 * (`--pdf-program`, `src/runners/pdf`), against a PDF program of ABI 4 that lists the
 * `output-safety` feature: the program renders a fixture form with hostile answers and the suite
 * inspects the OUTPUT bytes. `applies.*` are false so the sandbox-program and endpoint
 * runners skip them; `expect` is a placeholder (the check is code, `predicate` says what it
 * proves). Every row carries its time bound in `limits.programMs`.
 */
const TEST = "packages/pdf-kernel/tests/pdf-output-safety.test.ts";
const NOT_PROGRAM = { program: false, endpoint: false, parity: false } as const;
const input = { kind: "values", values: {} } as const;
const placeholder = all(accepted(true));

function out(
  n: number,
  title: string,
  severity: Severity,
  attacker: Attacker,
  predicate: string,
  programMs: number
): Vector {
  return vector({
    id: `OUT-${String(n).padStart(2, "0")}`,
    title,
    class: "output",
    severity,
    attacker,
    provenance: { tests: [{ path: TEST }] },
    input,
    expect: placeholder,
    predicate,
    limits: { programMs },
    applies: NOT_PROGRAM
  });
}

export const OUTPUT_VECTORS: Vector[] = [
  out(
    1,
    "Hostile answers stay string data in the content stream",
    "S2",
    "filler",
    "answers holding PDF syntax (parentheses, dictionary and stream keywords, NUL, surrogates, %%EOF, page tokens) add no object, no injected operator or name and no active key, and the extracted text equals the answer, with embedded and standard-14 fonts",
    60_000
  ),
  out(
    2,
    "No active content or link in a generated PDF",
    "S1",
    "filler",
    "no /JS /JavaScript /Launch /OpenAction /AA /SubmitForm /GoToR /RichMedia /URI (or other action key) in the objects or the raw bytes, and no link annotation, for URL-looking answers, hostile widget values and HTML or PDF uploads",
    60_000
  ),
  out(
    3,
    "An attachment's Filespec parses whatever the file is called",
    "S3",
    "filler",
    "file names with unbalanced parentheses and dictionary-closing tokens read back through pdf.js exactly as sent, and add no active key",
    60_000
  ),
  out(
    4,
    "Attachment names are sanitised and type claims are kept only when well formed",
    "S3",
    "filler",
    "paths, control, bidi and zero-width characters, dot runs and 4,000-character names are cleaned (at most 255 characters), duplicates are renamed, and a malformed MIME claim becomes application/octet-stream",
    60_000
  ),
  out(
    5,
    "The attachment budget charges the bytes carried, not the size claimed",
    "S2",
    "filler",
    "a file declared as size 0 that carries more bytes than the layout's budget is skipped with attachment.skipped, while an honest small file in the same document is embedded",
    60_000
  ),
  out(
    6,
    "Bidi controls typed into an answer cannot reorder the author's text",
    "S3",
    "filler",
    "text extracted with U+202E in one answer equals the text without it, and the removal is reported as text.bidiStripped",
    60_000
  ),
  out(
    7,
    "An over-wide unbreakable answer stays on the page",
    "S3",
    "filler",
    "no drawn text item ends past the page width for a 120-character answer without a break opportunity, and the text layer still holds all of it",
    60_000
  ),
  out(
    8,
    "A character the font cannot draw is reported",
    "S3",
    "filler",
    "CJK text with a Latin font produces text.glyphMissing (embedded font) or font.unencodable (standard-14), and plain text produces neither",
    60_000
  ),
  out(
    9,
    "Template field values are escaped and clamped, and no stale appearance contradicts /V",
    "S3",
    "filler",
    "in appearances=viewer mode a changed field loses its old /AP and NeedAppearances is true; hostile values read back as typed without active keys; /MaxLen and the 4,096 cap hold with field.overflow",
    90_000
  ),
  out(
    10,
    "Document metadata is escaped and never carries an answer",
    "S3",
    "author",
    "a form title with PDF and XML syntax round-trips through the Info dictionary, the XMP packet is well formed, and no answer appears in either",
    60_000
  ),
  out(
    11,
    "PDF/A-3b conformance holds over hostile answers and attachment names",
    "S3",
    "filler",
    "veraPDF (flavour 3b) reports the document compliant; SKIP with the reason when veraPDF is absent",
    180_000
  ),
  out(
    12,
    "A sealed signature over hostile text verifies",
    "S3",
    "filler",
    "the program's verify and an independent public-key check both accept the seal, the sealed text layer equals the unsealed one, and no active key is present; SKIP with the reason when openssl is absent",
    90_000
  ),
  out(
    13,
    "An over-long answer or a runaway document cannot pin a render slot",
    "S2",
    "filler",
    "a 64,800-character answer is cut at the 20,000-character cap with a render.truncated warning (the tail is not in the text layer, fewer than 60 pages, drawn promptly), a layout's limits.answerChars is honoured, and a document past limits.pages is refused as render_limit; a short answer raises no warning",
    90_000
  ),
  out(
    14,
    "A file that carries more bytes than it declares is not embedded",
    "S3",
    "filler",
    "bytes past the declared size by more than 1% + 1 KiB (declared 0 or 100) are skipped with file.sizeMismatch and refused under onExceeded fail, while a 4,096-byte file declared 4,000 is embedded",
    60_000
  ),
  out(
    15,
    "Executable, script and HTML attachments are refused by claimed type and by magic bytes",
    "S3",
    "filler",
    "Windows, ELF and Mach-O binaries, shebang scripts, HTML and SVG with script are skipped with attachment.refusedType whatever type they claim, an executable refuses under onExceeded fail, and honest text and PDF attachments are embedded",
    60_000
  )
];
