"""Admission: what a binding does with a request body before a service sees it.

The order is fixed: 415 from `Content-Type` before a byte is read, 413 from `Content-Length`, a counted read that stops
at the first byte over the cap (a chunked body cannot pass), then the strict parse (`datum_sandbox.json.read`); every
parse refusal is 400 `bad_document`. The pieces take bytes and a header mapping so a binding can stream the chunks
itself (`check_request_headers`, `BodyBudget`, `parse_json_body`); `admit_body` and `admit_json` compose them over an
iterable of chunks. Refusals never echo the body. A binding that serves a throttled route asks the address limit
(`datum_core.aio.count_address`) between the 415 and the `Content-Length` checks, so every request with an accepted
`Content-Type` is counted before its body is read.

Libraries: `starlette` and `anyio` are forbidden here, and the standard library
has no byte counter that refuses at a cap (`io.BytesIO` has no limit, `http.client` reads a declared length only), so
the counter is a dozen lines here.
"""

import re
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from typing import Final

from datum_core.http._headers import header
from datum_core.http.answer import HttpAnswer
from datum_core.http.errors import error_answer
from datum_sandbox.json import BadDocumentError, JsonValue, read

JSON_MEDIA_TYPES: Final = ("application/json",)
MAX_BODY_DEPTH: Final = 256
_UNSUPPORTED_MEDIA_TYPE: Final = 415

_DIGITS: Final = re.compile(r"[0-9]+", re.ASCII)


class BodyTooLargeError(Exception):
    """A streamed body went over its cap; the binding answers 413 `bad_document`."""


class BodyBudget:
    """Count the bytes of a streamed body and refuse the chunk that takes the total over `max_bytes`."""

    __slots__ = ("_max_bytes", "_size")

    def __init__(self, max_bytes: int) -> None:
        """Start an empty count under a cap of `max_bytes`."""
        self._max_bytes = max_bytes
        self._size = 0

    @property
    def size(self) -> int:
        """The bytes counted so far."""
        return self._size

    def add(self, chunk: bytes) -> None:
        """Count `chunk`; raise `BodyTooLargeError` when the total would pass the cap (the count is then unchanged)."""
        total = self._size + len(chunk)
        if total > self._max_bytes:
            raise BodyTooLargeError
        self._size = total


@dataclass(frozen=True, slots=True)
class Refused:
    """The request was refused at admission; `answer` is what the binding writes."""

    answer: HttpAnswer


def _refuse(status: int, code: str, message: str, *, problem_details: bool) -> Refused:
    return Refused(error_answer(status, code, message=message, problem_details=problem_details))


def refuses_media_type(refused: Refused) -> bool:
    """Whether `refused` is the 415 of a `Content-Type` check; every other refusal of the header checks is the length's.

    A binding that counts the address limit between the two asks this of the header checks' answer.
    """
    return refused.answer.status == _UNSUPPORTED_MEDIA_TYPE


def refuse_too_large(*, problem_details: bool = False) -> Refused:
    """Return the 413 `bad_document` refusal, for a binding that counts chunks with `BodyBudget` itself."""
    return _refuse(413, "bad_document", "The body is larger than the limit.", problem_details=problem_details)


def _media_type(value: str | None) -> str:
    return "" if value is None else value.partition(";")[0].strip().lower()


def check_request_headers(
    headers: Mapping[str, str],
    *,
    max_bytes: int,
    media_types: Iterable[str] = JSON_MEDIA_TYPES,
    problem_details: bool = False,
) -> Refused | None:
    """Refuse before reading, or return `None`.

    415 for a `Content-Type` outside `media_types`, 400 for a `Content-Length` that is not a whole number, 413 for one
    over `max_bytes`. Parameters (`; charset=utf-8`) and case are ignored in the media type.
    """
    if _media_type(header(headers, "Content-Type")) not in {name.lower() for name in media_types}:
        return _refuse(
            _UNSUPPORTED_MEDIA_TYPE,
            "unsupported_media_type",
            "The Content-Type is not supported.",
            problem_details=problem_details,
        )
    length = header(headers, "Content-Length")
    if length is None:
        return None
    if not _DIGITS.fullmatch(length):
        return _refuse(400, "bad_document", "The Content-Length is not a number.", problem_details=problem_details)
    if int(length) > max_bytes:
        return refuse_too_large(problem_details=problem_details)
    return None


def count_body(chunks: Iterable[bytes], *, max_bytes: int, problem_details: bool = False) -> bytes | Refused:
    """Return the chunks joined, or the 413 refusal at the first chunk that takes the total over `max_bytes`.

    The one counted read of the synchronous admission functions (`admit_body` and the PDF readers); an asynchronous
    binding counts its own chunks with `BodyBudget`.
    """
    budget = BodyBudget(max_bytes)
    received: list[bytes] = []
    for chunk in chunks:
        try:
            budget.add(chunk)
        except BodyTooLargeError:
            return refuse_too_large(problem_details=problem_details)
        received.append(chunk)
    return b"".join(received)


def admit_body(
    headers: Mapping[str, str],
    chunks: Iterable[bytes],
    *,
    max_bytes: int,
    media_types: Iterable[str] = JSON_MEDIA_TYPES,
    problem_details: bool = False,
) -> bytes | Refused:
    """Return the whole body, or the refusal: header checks first (no chunk is pulled), then the counted read."""
    refused = check_request_headers(
        headers, max_bytes=max_bytes, media_types=media_types, problem_details=problem_details
    )
    if refused is not None:
        return refused
    return count_body(chunks, max_bytes=max_bytes, problem_details=problem_details)


def parse_json_body(
    body: bytes, *, max_depth: int = MAX_BODY_DEPTH, problem_details: bool = False
) -> JsonValue | Refused:
    """Read an untrusted JSON body with the bounded JSON reader, refusing an object that repeats a key.

    Any refusal is 400 `bad_document` and echoes nothing.
    """
    try:
        return read(body, max_depth=max_depth, unique_keys=True)
    except BadDocumentError:
        return _refuse(400, "bad_document", "The body is not usable JSON.", problem_details=problem_details)


def admit_json(
    headers: Mapping[str, str],
    chunks: Iterable[bytes],
    *,
    max_bytes: int,
    max_depth: int = MAX_BODY_DEPTH,
    problem_details: bool = False,
) -> JsonValue | Refused:
    """Admit a JSON body: 415, then the cap, then the strict parse. A JSON `null` body is a value, not a refusal."""
    body = admit_body(headers, chunks, max_bytes=max_bytes, problem_details=problem_details)
    if isinstance(body, Refused):
        return body
    return parse_json_body(body, max_depth=max_depth, problem_details=problem_details)
