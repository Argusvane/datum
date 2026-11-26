"""`datum_core.http.pdf`: admission and the answers of the five PDF operations.

Admission is the receiver's order for a body: 415 from `Content-Type` before a byte is read (`application/json` for
render, fill and sign; `application/pdf` ONLY for verify), then 413 from `Content-Length` and from a counted read (a
chunked or lying body cannot pass), then 400 for what is not usable (`bad_document`). The JSON routes read `{document,
layoutId?}` under `datum.web.api.max_body_size`; verify reads the file under `datum.runtime.verify_max_bytes` and judges
`%PDF-` in the service. The answers are held to the shared catalog per operation: a 200 render is `application/pdf` with
`X-Page-Count` and, when signed, `X-Signed-By` and `X-Signature-Field`, plus `X-Datum-Layout`, each percent-encoded
UTF-8 with no CR or LF possible (the kit decodes them as form data, so a raw `+` would read as a space); the
failures use the catalog's codes only (any other pair is the 500 `internal` answer, except the carried
`signing.not_set_up`); `/server/certificate` is PEM or 404 `certificate.notFound`.
"""

import dataclasses
import json
import logging
import urllib.parse
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import pytest
from pdf_support import fake_pdf, signature_report, started_pdf, verify_reply

from datum_core.hooks import HookProblem
from datum_core.http.admission import Refused
from datum_core.http.answer import HttpAnswer
from datum_core.http.errors import ANSWER_ROWS
from datum_core.http.pdf import (
    PDF_PROGRAM_ROWS,
    PEM_MEDIA_TYPE,
    PdfRequestBody,
    certificate_answer,
    check_pdf_request_headers,
    check_pdf_upload_headers,
    parse_pdf_request,
    pdf_answer,
    read_pdf_request,
    read_pdf_upload,
    verify_answer,
)
from datum_core.pdf import PdfTrustPolicy
from datum_core.pdf.outcomes import (
    LayoutNotFound,
    LayoutNotTemplate,
    NotAPdf,
    Printed,
    ResultRejected,
    Unreadable,
)
from datum_core.submissions import (
    Malformed,
    NotFound,
    Outdated,
    Reject,
    Rejected,
    Throttled,
    TooLarge,
    Unavailable,
)
from datum_core.submissions import (
    Refused as PreCheckRefused,
)
from datum_core.testing.tsa_pki import DocumentPki, build_document_pki
from datum_core.throttle import ThrottleKey
from datum_sandbox.protocol import PdfKernelError

CATALOG = json.loads(
    (Path(__file__).resolve().parents[4] / "shared" / "endpoint-catalog.json").read_text(encoding="utf-8")
)
OPERATIONS = {
    item["operationId"]: item
    for item in CATALOG["endpoints"]
    if item["operationId"] in {"renderPdf", "fillPdf", "signPdf", "verifyPdf", "serverCertificate"}
}
JSON_TYPE = "application/json"
PDF_TYPE = "application/pdf"
MAX = 1024
BODY = json.dumps({"document": {"a": 1}}).encode()


def chunks_of(data: bytes, size: int = 64) -> Iterator[bytes]:
    for at in range(0, len(data), size):
        yield data[at : at + size]


class Pulled:
    """An iterable of chunks that notes how many it gave away (a refused request pulls none)."""

    def __init__(self, data: bytes, size: int = 64) -> None:
        self.parts = list(chunks_of(data, size))
        self.given = 0

    def __iter__(self) -> Iterator[bytes]:
        for part in self.parts:
            self.given += 1
            yield part


def body_of(answer: HttpAnswer) -> Any:
    return json.loads(answer.body)


def code_of(answer: HttpAnswer) -> str | None:
    document = body_of(answer)
    return document["errors"][0]["code"] if isinstance(document, dict) and document.get("errors") else None


@pytest.fixture(scope="module")
def pki() -> DocumentPki:
    return build_document_pki()


# -- admission: the JSON routes ----------------------------------------------------------------------------------------
def test_a_good_request_is_the_document_and_no_layout() -> None:
    result = read_pdf_request({"Content-Type": JSON_TYPE}, chunks_of(BODY), max_bytes=MAX)
    assert isinstance(result, PdfRequestBody)
    assert result.document == {"a": 1}
    assert result.layout_id is None


def test_a_layout_id_is_read_as_a_string() -> None:
    body = json.dumps({"document": {}, "layoutId": "t1"}).encode()
    result = read_pdf_request({"Content-Type": JSON_TYPE}, chunks_of(body), max_bytes=MAX)
    assert isinstance(result, PdfRequestBody)
    assert result.layout_id == "t1"


@pytest.mark.parametrize(
    "media", ["text/plain", "application/pdf", "application/octet-stream", "multipart/form-data", ""]
)
def test_step_one_the_media_type_is_415_and_no_chunk_is_pulled(media: str) -> None:
    pulled = Pulled(BODY)
    result = read_pdf_request({"Content-Type": media}, pulled, max_bytes=MAX)
    assert isinstance(result, Refused)
    assert result.answer.status == 415
    assert code_of(result.answer) == "unsupported_media_type"
    assert pulled.given == 0


def test_a_missing_content_type_is_415() -> None:
    result = read_pdf_request({}, chunks_of(BODY), max_bytes=MAX)
    assert isinstance(result, Refused)
    assert result.answer.status == 415


@pytest.mark.parametrize("media", ["application/json", "Application/JSON", "application/json; charset=utf-8"])
def test_the_json_type_is_taken_with_any_case_and_parameters(media: str) -> None:
    assert isinstance(read_pdf_request({"Content-Type": media}, chunks_of(BODY), max_bytes=MAX), PdfRequestBody)


def test_step_two_a_declared_length_over_the_cap_is_413_before_any_chunk_is_pulled() -> None:
    pulled = Pulled(BODY)
    result = read_pdf_request({"Content-Type": JSON_TYPE, "Content-Length": str(MAX + 1)}, pulled, max_bytes=MAX)
    assert isinstance(result, Refused)
    assert result.answer.status == 413
    assert code_of(result.answer) == "bad_document"
    assert pulled.given == 0


def test_a_lying_length_and_a_chunked_body_are_counted_and_stop_at_the_cap() -> None:
    big = b'{"document": "' + b"x" * (MAX * 4) + b'"}'
    for headers in ({"Content-Type": JSON_TYPE, "Content-Length": "10"}, {"Content-Type": JSON_TYPE}):
        pulled = Pulled(big)
        result = read_pdf_request(headers, pulled, max_bytes=MAX)
        assert isinstance(result, Refused)
        assert result.answer.status == 413
        assert pulled.given <= MAX // 64 + 2, "the read stopped at the first chunk over the cap"


def test_the_cap_is_inclusive() -> None:
    exact = b'{"document":"' + b"x" * (MAX - len(b'{"document":""}')) + b'"}'
    assert len(exact) == MAX
    assert isinstance(read_pdf_request({"Content-Type": JSON_TYPE}, chunks_of(exact), max_bytes=MAX), PdfRequestBody)
    assert isinstance(read_pdf_request({"Content-Type": JSON_TYPE}, chunks_of(exact + b" "), max_bytes=MAX), Refused)


def test_step_three_what_is_not_usable_json_is_400_bad_document() -> None:
    bad = [
        b"",
        b"not json",
        b"{",
        b'{"document": NaN}',
        b'{"document": "\\ud800"}',
        b"\xff\xfe",
        b"[" * 400 + b"]" * 400,
    ]
    for body in bad:
        result = read_pdf_request({"Content-Type": JSON_TYPE}, chunks_of(body), max_bytes=1 << 20)
        assert isinstance(result, Refused), body
        assert (result.answer.status, code_of(result.answer)) == (400, "bad_document")


@pytest.mark.parametrize(
    "body",
    [
        b"[]",
        b'"x"',
        b"null",
        b"{}",
        b'{"layoutId": "t1"}',
        b'{"document": {}, "layoutId": 5}',
        b'{"document": {}, "layoutId": ""}',
        b'{"document": {}, "layoutId": null}',
    ],
)
def test_a_body_that_is_not_a_document_with_an_optional_layout_id_is_400_bad_document(body: bytes) -> None:
    result = read_pdf_request({"Content-Type": JSON_TYPE}, chunks_of(body), max_bytes=MAX)
    if body == b'{"document": {}, "layoutId": null}':
        assert isinstance(result, PdfRequestBody)
        assert result.layout_id is None
        return
    assert isinstance(result, Refused)
    assert (result.answer.status, code_of(result.answer)) == (400, "bad_document")


def test_the_three_steps_are_held_in_order_when_a_request_breaks_all_of_them() -> None:
    result = read_pdf_request(
        {"Content-Type": "text/plain", "Content-Length": str(MAX * 9)}, chunks_of(b"not json"), max_bytes=MAX
    )
    assert isinstance(result, Refused)
    assert result.answer.status == 415
    result = read_pdf_request(
        {"Content-Type": JSON_TYPE, "Content-Length": str(MAX * 9)}, chunks_of(b"not json"), max_bytes=MAX
    )
    assert isinstance(result, Refused)
    assert result.answer.status == 413
    for read in (read_pdf_request, read_pdf_upload):
        pulled = Pulled(b"not json")
        broken = read({"Content-Type": "text/plain", "Content-Length": "-1"}, pulled, max_bytes=MAX)
        assert isinstance(broken, Refused), read.__name__
        assert (broken.answer.status, code_of(broken.answer)) == (415, "unsupported_media_type"), read.__name__
        assert pulled.given == 0


@pytest.mark.parametrize("length", ["ten", "-1", "+5", "1.0", " ", "0x10", "\u00b2"])
def test_a_content_length_that_is_not_a_whole_number_is_the_malformed_framing_400_bad_request(length: str) -> None:
    """`bad_request` is the malformed-framing answer on the pdf operations (no chunk is pulled)."""
    for read in (read_pdf_request, read_pdf_upload):
        media = JSON_TYPE if read is read_pdf_request else PDF_TYPE
        pulled = Pulled(BODY)
        result = read({"Content-Type": media, "Content-Length": length}, pulled, max_bytes=MAX)
        assert isinstance(result, Refused), (read.__name__, length)
        assert (result.answer.status, code_of(result.answer)) == (400, "bad_request"), (read.__name__, length)
        assert pulled.given == 0


# The catalog's verifyPdf 400 row lists the program words only; the malformed-framing `bad_request` is a named drift
# allowance (the catalog row does not list it).
ADMISSION_ALLOWANCE = {("verifyPdf", 400, "bad_request")}


def _admission_refusals(operation: str) -> list[HttpAnswer]:
    """Every admission refusal the operation's reader can make: media, framing, declared length, counted, bad body."""
    answers: list[object] = []
    if operation == "verifyPdf":
        answers.extend(
            read_pdf_upload(headers, Pulled(BODY), max_bytes=MAX)
            for headers in (
                {"Content-Type": JSON_TYPE},
                {"Content-Type": PDF_TYPE, "Content-Length": "ten"},
                {"Content-Type": PDF_TYPE, "Content-Length": str(MAX + 1)},
            )
        )
        answers.append(read_pdf_upload({"Content-Type": PDF_TYPE}, Pulled(b"x" * (MAX * 4)), max_bytes=MAX))
        answers.append(check_pdf_upload_headers({"Content-Type": JSON_TYPE}, max_bytes=MAX))
    else:
        answers.extend(
            read_pdf_request(headers, Pulled(BODY), max_bytes=MAX)
            for headers in (
                {"Content-Type": "text/plain"},
                {"Content-Type": JSON_TYPE, "Content-Length": "ten"},
                {"Content-Type": JSON_TYPE, "Content-Length": str(MAX + 1)},
            )
        )
        answers.append(read_pdf_request({"Content-Type": JSON_TYPE}, Pulled(b"x" * (MAX * 4)), max_bytes=MAX))
        answers.append(check_pdf_request_headers({"Content-Type": "text/plain"}, max_bytes=MAX))
        answers.extend(parse_pdf_request(body) for body in (b"not json", b"[]", b'{"layoutId": "t1"}'))
        answers.append(parse_pdf_request(b'{"document": {}}', layout_required=True))
    refusals = [item.answer for item in answers if isinstance(item, Refused)]
    assert len(refusals) == len(answers), operation
    return refusals


@pytest.mark.parametrize("operation", ["renderPdf", "fillPdf", "signPdf", "verifyPdf"])
def test_every_admission_refusal_is_a_status_and_code_the_catalog_lists_or_a_named_allowance(operation: str) -> None:
    listed = {int(item["status"]): item["codes"] for item in OPERATIONS[operation]["statuses"]}
    seen = set()
    for answer in _admission_refusals(operation):
        code = code_of(answer)
        seen.add((answer.status, code))
        if (operation, answer.status, code) in ADMISSION_ALLOWANCE:
            continue
        assert answer.status in listed, (operation, answer.status, code)
        assert not listed[answer.status] or code in listed[answer.status], (operation, answer.status, code)
    assert {status for status, _ in seen} >= {400, 413, 415}


def test_a_declared_length_too_long_to_be_a_number_is_413_not_a_crash() -> None:
    result = read_pdf_request({"Content-Type": JSON_TYPE, "Content-Length": "9" * 5000}, chunks_of(BODY), max_bytes=MAX)
    assert isinstance(result, Refused)
    assert (result.answer.status, code_of(result.answer)) == (413, "bad_document")


def test_problem_details_mode_changes_the_shape_not_the_status_or_the_code() -> None:
    result = read_pdf_request({"Content-Type": "text/plain"}, chunks_of(BODY), max_bytes=MAX, problem_details=True)
    assert isinstance(result, Refused)
    assert result.answer.headers["Content-Type"] == "application/problem+json"
    assert (result.answer.status, body_of(result.answer)["code"]) == (415, "unsupported_media_type")


# -- admission: verify ------------------------------------------------------------------------------------------------
@pytest.mark.parametrize(
    "media", ["application/json", "text/plain", "application/octet-stream", "application/x-pdf", ""]
)
def test_verify_takes_application_pdf_only_everything_else_is_415(media: str) -> None:
    pulled = Pulled(b"%PDF-1.7 xxxx")
    result = read_pdf_upload({"Content-Type": media}, pulled, max_bytes=MAX)
    assert isinstance(result, Refused)
    assert result.answer.status == 415
    assert pulled.given == 0


@pytest.mark.parametrize("media", ["application/pdf", "Application/PDF", "application/pdf; version=1.7"])
def test_the_pdf_type_is_taken_with_any_case_and_parameters(media: str) -> None:
    assert read_pdf_upload({"Content-Type": media}, chunks_of(b"%PDF-1.7 xxxx"), max_bytes=MAX) == b"%PDF-1.7 xxxx"


def test_the_upload_is_counted_and_a_big_one_is_413_without_the_rest_being_read() -> None:
    pulled = Pulled(b"%PDF-" + b"x" * (MAX * 8))
    result = read_pdf_upload({"Content-Type": PDF_TYPE}, pulled, max_bytes=MAX)
    assert isinstance(result, Refused)
    assert result.answer.status == 413
    assert code_of(result.answer) == "bad_document"
    assert pulled.given <= MAX // 64 + 2
    declared = Pulled(b"%PDF-1.7")
    result = read_pdf_upload({"Content-Type": PDF_TYPE, "Content-Length": str(MAX + 1)}, declared, max_bytes=MAX)
    assert isinstance(result, Refused)
    assert result.answer.status == 413
    assert declared.given == 0


def test_the_upload_cap_is_inclusive_and_the_bytes_are_returned_whole() -> None:
    exact = b"%PDF-" + b"y" * (MAX - 5)
    assert read_pdf_upload({"Content-Type": PDF_TYPE}, chunks_of(exact, 7), max_bytes=MAX) == exact
    assert isinstance(read_pdf_upload({"Content-Type": PDF_TYPE}, chunks_of(exact + b"z"), max_bytes=MAX), Refused)


def test_an_upload_that_is_not_a_pdf_is_the_services_to_judge_so_admission_returns_it() -> None:
    assert read_pdf_upload({"Content-Type": PDF_TYPE}, chunks_of(b"hello"), max_bytes=MAX) == b"hello"


# -- the 200 answer ---------------------------------------------------------------------------------------------------
def printed(**more: Any) -> Printed:
    fields: dict[str, Any] = {
        "data": fake_pdf("answer"),
        "page_count": 3,
        "layout_id": "default",
        "signed_by": None,
        "signature_field": None,
        "timestamped": False,
        "warnings": (),
    }
    fields.update(more)
    return Printed(**fields)


def test_a_printed_pdf_is_200_application_pdf_with_the_page_count_and_the_layout() -> None:
    answer = pdf_answer(printed(), retry_after=5)
    assert answer.status == 200
    assert answer.body == fake_pdf("answer")
    assert answer.headers["Content-Type"] == PDF_TYPE
    assert answer.headers["X-Page-Count"] == "3"
    assert answer.headers["X-Datum-Layout"] == "default"
    assert "X-Signed-By" not in answer.headers
    assert "X-Signature-Field" not in answer.headers


def test_a_sealed_pdf_names_its_signer_and_field() -> None:
    answer = pdf_answer(
        printed(signed_by="Datum test seal", signature_field="Signature1", timestamped=True), retry_after=5
    )
    assert answer.headers["X-Signed-By"] == "Datum%20test%20seal"
    assert answer.headers["X-Signature-Field"] == "Signature1"


def test_the_pdf_theme_of_the_forms_binding_is_named_when_the_binding_suggests_one() -> None:
    assert "X-Datum-Pdf-Theme" not in pdf_answer(printed(), retry_after=5).headers
    answer = pdf_answer(printed(pdf_theme="gcds"), retry_after=5)
    assert answer.headers["X-Datum-Pdf-Theme"] == "gcds"


def test_a_layout_less_answer_sends_no_layout_header() -> None:
    assert "X-Datum-Layout" not in pdf_answer(printed(layout_id=None), retry_after=5).headers


@pytest.mark.parametrize(
    "value",
    [
        "Zoë O'Brien",
        "ACME / Ottawa (CA)",
        "a+b c",
        "Ünïcödé 😀",
        "tab\there",
        "A\r\nSet-Cookie: x=1",
        "100%",
        "semi;colon,comma",
        "x" * 300,
    ],
)
def test_the_headers_are_percent_encoded_utf8_that_the_kits_decoder_reads_back_and_never_carry_cr_lf_or_non_ascii(
    value: str,
) -> None:
    answer = pdf_answer(printed(signed_by=value, signature_field=value, layout_id=value), retry_after=5)
    for name in ("X-Signed-By", "X-Signature-Field", "X-Datum-Layout"):
        sent = answer.headers[name]
        assert sent.isascii()
        assert "\r" not in sent
        assert "\n" not in sent
        assert " " not in sent
        assert "+" not in sent
        assert urllib.parse.unquote_plus(sent) == value, "the kit's decoder reads '+' as a space: '+' travels as %2B"
        assert urllib.parse.unquote(sent) == value


def test_a_blank_signer_name_is_not_a_signed_by_header() -> None:
    answer = pdf_answer(printed(signed_by="", signature_field=""), retry_after=5)
    assert "X-Signed-By" not in answer.headers


def test_no_other_header_is_added_to_a_printed_pdf() -> None:
    names = set(pdf_answer(printed(signed_by="a", signature_field="b"), retry_after=5).headers)
    assert names <= {
        "Content-Type",
        "X-Page-Count",
        "X-Signed-By",
        "X-Signature-Field",
        "X-Datum-Layout",
        "X-Datum-Pdf-Theme",
        "Cache-Control",
        "Content-Length",
    }


# -- the refusals, one by one ------------------------------------------------------------------------------------------
KEY = ThrottleKey(ip="203.0.113.7")
ROWS: list[tuple[Any, int, str | None]] = [
    (NotFound("nope"), 404, "form.notFound"),
    (LayoutNotFound("nope"), 404, "layout.notFound"),
    (LayoutNotTemplate("g1"), 400, "layout.notTemplate"),
    (Malformed("a reason"), 400, "bad_document"),
    (TooLarge(10), 413, "bad_document"),
    (Throttled(7, KEY), 429, "flood"),
    (Unavailable("server.unavailable", "words"), 503, "server.unavailable"),
    (Unavailable("server.busy", "words"), 503, "server.busy"),
    (Unavailable("pdf_unavailable", "words"), 503, "server.unavailable"),
    (Unavailable("signing.not_set_up", "words"), 503, "signing.not_set_up"),
    (Unavailable("wasm.execution_error", "words"), 503, "wasm.execution_error"),
    (Unavailable("outcome_too_large", "words"), 503, "outcome_too_large"),
    (Unavailable("definition.tooDeep", "words"), 503, "definition.tooDeep"),
    (Rejected(((None, "required", None),), "sandbox"), 422, "required"),
    (ResultRejected((HookProblem("f", "pdf.first", "one"), HookProblem(None, "pdf.second", "two"))), 422, "pdf.first"),
]


@pytest.mark.parametrize(("outcome", "status", "code"), ROWS, ids=[type(row[0]).__name__ + str(row[1]) for row in ROWS])
def test_each_outcome_answers_its_status_and_code(outcome: Any, status: int, code: str | None) -> None:
    answer = pdf_answer(outcome, retry_after=9)
    assert (answer.status, code_of(answer)) == (status, code)
    if status == 429 or code == "server.busy":
        assert answer.headers["Retry-After"] == ("7" if status == 429 else "9")
    else:
        assert "Retry-After" not in answer.headers
    assert "nope" not in answer.body.decode()
    assert "a reason" not in answer.body.decode()
    assert "words" not in answer.body.decode()


def test_a_validators_errors_come_whole_and_in_order_in_the_422_body() -> None:
    answer = pdf_answer(ROWS[-1][0], retry_after=5)
    assert answer.status == 422
    assert [(item.get("field"), item["code"]) for item in body_of(answer)["errors"]] == [
        ("f", "pdf.first"),
        (None, "pdf.second"),
    ]
    assert all("message" not in item or item["message"] for item in body_of(answer)["errors"])


# -- the program's own refusals (PdfKernelError keeps the program's word) -----------------------------------
@pytest.mark.parametrize(
    ("word", "status", "code"),
    [
        ("layout", 404, "layout.notFound"),
        ("template", 422, "template"),
        ("render_limit", 422, "render_limit"),
        ("unknown_component", 422, "unknown_component"),
        ("conformance", 422, "conformance"),
        ("attachment_budget", 422, "attachment_budget"),
        ("signature", 500, "signature"),
        ("font", 500, "internal"),
        ("invalid_request", 500, "internal"),
        ("abi_mismatch", 500, "internal"),
        ("internal", 500, "internal"),
        ("unknown", 500, "internal"),
        ("form.notFound", 500, "internal"),
    ],
)
def test_a_program_refusal_answers_by_its_word_and_never_carries_the_programs_text(
    word: str, status: int, code: str, caplog: pytest.LogCaptureFixture
) -> None:
    with caplog.at_level(logging.DEBUG, logger="datum.pdf"):
        answer = pdf_answer(PdfKernelError(word, "SECRET-PROGRAM-WORDS /opt/fonts"), retry_after=5)
    assert (answer.status, code_of(answer)) == (status, code)
    assert "SECRET-PROGRAM-WORDS" not in answer.body.decode()
    assert "Retry-After" not in answer.headers
    assert any(word in record.getMessage() for record in caplog.records if record.name == "datum.pdf")
    for operation in ("renderPdf", "fillPdf", "signPdf"):
        listed = {int(item["status"]): item["codes"] for item in OPERATIONS[operation]["statuses"]}
        assert status == 500 or (status in listed and (not listed[status] or code in listed[status]))


def test_the_program_rows_are_exactly_the_table_the_module_publishes() -> None:
    assert dict(PDF_PROGRAM_ROWS) == {
        "layout": (404, "layout.notFound"),
        "template": (422, "template"),
        "render_limit": (422, "render_limit"),
        "unknown_component": (422, "unknown_component"),
        "conformance": (422, "conformance"),
        "attachment_budget": (422, "attachment_budget"),
        "signature": (500, "signature"),
    }


def test_the_programs_signature_refusal_is_the_hosts_own_500_signature_with_no_message_and_a_warning(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """The program's word for a seal it would not make is the code the seal's own refusals answer."""
    with caplog.at_level(logging.DEBUG, logger="datum.pdf"):
        answer = pdf_answer(
            PdfKernelError("signature", "A signature needs at least the signer's certificate"), retry_after=5
        )
    assert (answer.status, code_of(answer)) == (500, "signature")
    assert all("message" not in item for item in body_of(answer)["errors"])
    assert "certificate" not in answer.body.decode()
    assert any(
        record.levelno == logging.WARNING and "signature" in record.getMessage()
        for record in caplog.records
        if record.name == "datum.pdf"
    )


@pytest.mark.parametrize("code", ["validator_unavailable", "data_source.unavailable", "keys_unavailable"])
def test_a_typed_503_of_another_capability_is_the_catalogs_server_unavailable_on_a_pdf_route(code: str) -> None:
    answer = pdf_answer(Unavailable(code, "w"), retry_after=4)
    assert (answer.status, code_of(answer)) == (503, "server.unavailable")
    assert "Retry-After" not in answer.headers
    assert verify_answer(Unavailable(code, "w"), retry_after=4).status == 503


def test_an_unavailable_code_no_row_lists_is_the_500_internal_on_both_kinds_of_route() -> None:
    assert (pdf_answer(Unavailable("made.up", "w"), retry_after=5).status, "internal") == (500, "internal")
    assert code_of(pdf_answer(Unavailable("made.up", "w"), retry_after=5)) == "internal"
    assert code_of(verify_answer(Unavailable("made.up", "w"), retry_after=5)) == "internal"


def test_a_printed_pdf_is_never_kept_by_a_cache() -> None:
    assert pdf_answer(printed(), retry_after=5).headers["Cache-Control"] == "no-store"


def test_a_pre_check_refusal_goes_through_the_pre_check_statuses_like_a_submissions() -> None:
    refusal = PreCheckRefused(Reject("access.denied", "closed"))
    assert pdf_answer(refusal, retry_after=5).status == 403


def test_a_version_mismatch_is_422_form_outdated_with_no_hash_and_no_etag() -> None:
    """The pdf operations list no 409 and their 422 row is open, so a stale version is 422."""
    answer = pdf_answer(Outdated("2", "0" * 64), retry_after=5)
    assert (answer.status, code_of(answer)) == (422, "form.outdated")
    assert len(body_of(answer)["errors"]) == 1
    for operation in ("renderPdf", "fillPdf", "signPdf"):
        listed = {int(item["status"]): item["codes"] for item in OPERATIONS[operation]["statuses"]}
        assert 422 in listed
        assert listed[422] == []
    assert "0" * 64 not in answer.body.decode()
    assert "ETag" not in answer.headers
    assert "Retry-After" not in answer.headers


def test_the_problem_details_mode_carries_the_same_status_and_code() -> None:
    answer = pdf_answer(LayoutNotFound("x"), retry_after=5, problem_details=True, correlation_id="abc")
    assert answer.status == 404
    assert answer.headers["Content-Type"] == "application/problem+json"
    document = body_of(answer)
    assert (document["code"], document["status"]) == ("layout.notFound", 404)


@pytest.mark.parametrize("operation", ["renderPdf", "fillPdf", "signPdf"])
def test_every_answer_of_a_body_route_is_a_status_and_code_the_catalog_lists_or_the_500_internal(
    operation: str,
) -> None:
    listed = {int(item["status"]): item["codes"] for item in OPERATIONS[operation]["statuses"]}
    for outcome, _status, _code in ROWS:
        answer = pdf_answer(outcome, retry_after=5, operation=operation)
        if answer.status == 500:
            assert code_of(answer) == "internal"
            continue
        if (answer.status, code_of(answer)) == (503, "signing.not_set_up"):
            continue  # the submission row for signed wrappers, until they are set up
        assert answer.status in listed, (type(outcome).__name__, answer.status)
        assert not listed[answer.status] or code_of(answer) in listed[answer.status], (
            type(outcome).__name__,
            code_of(answer),
        )


def test_each_body_status_the_datum_side_owns_is_produced_by_some_outcome() -> None:
    produced = {(pdf_answer(outcome, retry_after=5).status, code) for outcome, _s, code in ROWS}
    for operation in ("renderPdf", "signPdf"):
        for item in OPERATIONS[operation]["statuses"]:
            status = int(item["status"])
            if status in {200, 403, 415}:
                continue  # 200 is the printed answer, 403 the application's dependency, 415 admission
            assert any(s == status for s, _c in produced), (operation, status)
    assert any(s == 400 and c == "layout.notTemplate" for s, c in produced)


def test_layout_not_template_is_the_fill_routes_alone_and_the_500_on_the_other_two(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """The catalog lists `layout.notTemplate` on `fillPdf` only: held per operation, as every other code is."""
    refusal = LayoutNotTemplate("g1")
    assert (pdf_answer(refusal, retry_after=5, operation="fillPdf").status, 400) == (400, 400)
    with caplog.at_level(logging.ERROR, logger="datum.pdf"):
        for operation in ("renderPdf", "signPdf"):
            answer = pdf_answer(refusal, retry_after=5, operation=operation)
            assert (answer.status, code_of(answer)) == (500, "internal"), operation
    assert caplog.records


# -- verify ------------------------------------------------------------------------------------------------------------
VERIFY_ROWS: list[tuple[Any, int, str]] = [
    (NotAPdf(), 400, "pdf.notAPdf"),
    (Unreadable(), 400, "pdf.unreadable"),
    (TooLarge(10), 413, "bad_document"),
    (Throttled(7, KEY), 429, "flood"),
    (Unavailable("server.unavailable", "w"), 503, "server.unavailable"),
    (Unavailable("server.busy", "w"), 503, "server.busy"),
    (Unavailable("pdf_unavailable", "w"), 503, "server.unavailable"),
    (Unavailable("wasm.execution_error", "w"), 503, "wasm.execution_error"),
    (Unavailable("outcome_too_large", "w"), 503, "outcome_too_large"),
]


@pytest.mark.parametrize(
    ("outcome", "status", "code"), VERIFY_ROWS, ids=[type(row[0]).__name__ + str(row[1]) for row in VERIFY_ROWS]
)
def test_each_verify_refusal_answers_its_status_and_code(outcome: Any, status: int, code: str) -> None:
    answer = verify_answer(outcome, retry_after=9)
    assert (answer.status, code_of(answer)) == (status, code)
    assert ("Retry-After" in answer.headers) == (status == 429 or code == "server.busy")


def test_verify_never_answers_a_status_the_catalog_does_not_list_for_it() -> None:
    listed = {int(item["status"]) for item in OPERATIONS["verifyPdf"]["statuses"]}
    assert listed == {200, 400, 413, 415, 429, 503}
    for outcome, _status, _code in VERIFY_ROWS:
        assert verify_answer(outcome, retry_after=5).status in listed


def verified_answer(pki: DocumentPki, *reports: dict[str, Any], **more: Any) -> tuple[HttpAnswer, Any]:
    with started_pdf(pdf_trust_policy=PdfTrustPolicy(anchors=(pki.signer.root_der,))) as rig:
        rig.runtime.on("verify", lambda _r: verify_reply(*reports, **more))
        outcome = rig.verify(fake_pdf("signed") + b"x" * 20)
    return verify_answer(outcome, retry_after=5), outcome


def test_a_verified_file_is_200_json_with_exactly_the_catalogs_report_members(pki: DocumentPki) -> None:
    answer, outcome = verified_answer(
        pki, signature_report(pki.signer, signed_document_id="11" * 16), document_id="22" * 16
    )
    assert answer.status == 200
    assert answer.headers["Content-Type"] == JSON_TYPE
    document = body_of(answer)
    schema = {item["name"]: item for item in CATALOG["schemas"]}["PdfVerifyReport"]
    assert set(document) <= {prop["name"] for prop in schema["properties"]}
    assert set(schema["required"]) <= set(document)
    assert document["sha256"] == outcome.report.sha256
    assert document["bytes"] == outcome.report.size
    assert (document["documentId"], document["documentIdSource"]) == ("11" * 16, "signed")
    assert isinstance(document["warnings"], list)
    assert all(isinstance(item, str) for item in document["warnings"])
    assert document["trustPolicy"] == {"name": "default", "revocationChecking": False, "validationTime": "now"}
    assert answer.headers["Cache-Control"] == "no-store"


def test_each_signature_carries_the_required_members_in_the_right_types(pki: DocumentPki) -> None:
    answer, _ = verified_answer(
        pki, signature_report(pki.signer), signature_report(pki.stranger, field_name="Signature2", forge=True)
    )
    verdicts = body_of(answer)["signatures"]
    schema = {item["name"]: item for item in CATALOG["schemas"]}["PdfSignatureVerdict"]
    for verdict in verdicts:
        assert set(schema["required"]) <= set(verdict)
        assert set(verdict) <= {prop["name"] for prop in schema["properties"]}
        assert not {"trustReason", "timestamped", "timestampTime"} & set(verdict)
        assert isinstance(verdict["intact"], bool)
        assert verdict["value"] in {"valid", "invalid", "unchecked"}
        assert verdict["trust"] in {"site", "site_retired", "trusted", "self_signed", "unknown"}
        for flag in ("digestMatches", "certificateMatches", "coversDocument"):
            assert isinstance(verdict[flag], bool)
    assert (verdicts[0]["value"], verdicts[0]["intact"], verdicts[0]["trust"]) == ("valid", True, "trusted")
    assert (verdicts[1]["value"], verdicts[1]["intact"], verdicts[1]["trust"]) == ("invalid", False, "unknown")


def test_trusted_at_is_there_only_for_a_trusted_chain_and_is_iso_8601(pki: DocumentPki) -> None:
    answer, _ = verified_answer(
        pki, signature_report(pki.signer), signature_report(pki.stranger, field_name="Signature2")
    )
    trusted, unknown = body_of(answer)["signatures"]
    assert trusted["trustedAt"] == "2026-10-20T12:00:00Z"
    assert "trustedAt" not in unknown or unknown["trustedAt"] is None


@pytest.mark.parametrize(
    ("moment", "written"),
    [
        (datetime(2026, 10, 20, 12, 0, 0, tzinfo=UTC), "2026-10-20T12:00:00Z"),
        (datetime(2026, 10, 20, 14, 0, 0, tzinfo=timezone(timedelta(hours=2))), "2026-10-20T12:00:00Z"),
        (datetime(2026, 10, 20, 12, 0, 0), "2026-10-20T12:00:00Z"),
        (datetime(2026, 10, 20, 12, 0, 0, 500000, tzinfo=UTC), "2026-10-20T12:00:00.500000Z"),
    ],
)
def test_trusted_at_is_written_in_utc_with_a_z_and_never_a_numeric_offset(
    pki: DocumentPki, moment: datetime, written: str
) -> None:
    _, outcome = verified_answer(pki, signature_report(pki.signer))
    verdict = dataclasses.replace(outcome.report.signatures[0], trusted_at=moment)
    report = dataclasses.replace(outcome.report, signatures=(verdict,))
    answer = verify_answer(dataclasses.replace(outcome, report=report), retry_after=5)
    (item,) = body_of(answer)["signatures"]
    assert item["trustedAt"] == written
    assert "+" not in item["trustedAt"]


def test_the_report_carries_no_certificate_key_signature_value_or_attribute_bytes(pki: DocumentPki) -> None:
    answer, _ = verified_answer(pki, signature_report(pki.signer))
    text = answer.body.decode()
    for needle in ("toBeVerified", "publicKey", 'signature":', 'certificate":', "MII"):
        assert needle not in text
    assert pki.signer.leaf_der.hex() not in text


def test_a_file_with_no_signature_is_a_report_with_an_empty_list(pki: DocumentPki) -> None:
    answer, _ = verified_answer(pki)
    assert answer.status == 200
    assert body_of(answer)["signatures"] == []


# -- /server/certificate ----------------------------------------------------------------------------------------------
PEM = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n"


def test_the_servers_chain_is_pem_200_with_the_pem_media_type() -> None:
    answer = certificate_answer(PEM)
    assert answer.status == 200
    assert answer.headers["Content-Type"] == PEM_MEDIA_TYPE == "application/x-pem-file"
    assert answer.body == PEM.encode("ascii")
    assert answer.headers["Cache-Control"] == "no-cache"
    assert answer.body.startswith(b"-----BEGIN CERTIFICATE-----")


def test_no_key_is_404_certificate_not_found() -> None:
    answer = certificate_answer(None)
    assert (answer.status, code_of(answer)) == (404, "certificate.notFound")
    assert certificate_answer(None, problem_details=True).headers["Content-Type"] == "application/problem+json"


def test_the_certificate_answer_is_one_of_the_two_statuses_the_catalog_lists() -> None:
    listed = {int(item["status"]) for item in OPERATIONS["serverCertificate"]["statuses"]}
    assert listed == {200, 404}
    assert {certificate_answer(PEM).status, certificate_answer(None).status} == listed


def test_the_table_holds_the_pdf_codes_and_the_one_carried_row() -> None:
    codes = {code for row in ANSWER_ROWS for code in row.codes}
    assert {
        "layout.notTemplate",
        "pdf.notAPdf",
        "pdf.unreadable",
        "layout.notFound",
        "certificate.notFound",
        "signing.not_set_up",
    } <= codes


# -- further PDF route cases ------------------------------------------------------------------------------------------
@pytest.mark.parametrize("word", ["layout", "template", "render_limit"])
def test_the_programs_listed_word_info_line_carries_the_correlation_id(
    word: str, caplog: pytest.LogCaptureFixture
) -> None:
    with caplog.at_level(logging.INFO, logger="datum.pdf"):
        pdf_answer(PdfKernelError(word, "words"), retry_after=5, correlation_id="corr-7")
    info = [record for record in caplog.records if record.levelno == logging.INFO]
    assert len(info) == 1
    assert getattr(info[0], "datum_correlation_id", None) == "corr-7"


def test_there_is_one_counted_read_the_admission_modules_and_the_pdf_readers_share(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import datum_core.http.pdf as module  # noqa: PLC0415 - the module's own text is the subject

    calls: list[int] = []
    real = module.count_body

    def spy(chunks: Any, **kw: Any) -> Any:
        calls.append(kw["max_bytes"])
        return real(chunks, **kw)

    monkeypatch.setattr(module, "count_body", spy)
    over = read_pdf_upload({"Content-Type": "application/pdf"}, iter([b"abc", b"de"]), max_bytes=4)
    assert isinstance(over, Refused)
    assert over.answer.status == 413
    assert read_pdf_upload({"Content-Type": "application/pdf"}, iter([b"abc", b"d"]), max_bytes=4) == b"abcd"
    calls.clear()
    read_pdf_upload({"Content-Type": "application/pdf"}, iter([b"abc", b"de"]), max_bytes=4)
    read_pdf_request({"Content-Type": "application/json"}, iter([b'{"document": 1}']), max_bytes=64)
    assert calls == [4, 64]
