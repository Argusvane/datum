"""The one refusal type of the JSON reader and the canonical writers."""

import enum


class RefusalReason(enum.StrEnum):
    """Stable machine-readable reasons; the wire code is always `bad_document`."""

    NOT_UTF8 = "not_utf8"
    SYNTAX = "syntax"
    NON_FINITE = "non_finite_number"
    NUMBER_TOO_LONG = "number_too_long"
    NESTING = "nesting_too_deep"
    LONE_SURROGATE = "lone_surrogate"
    NO_JSON_FORM = "no_json_form"
    NUL_CHARACTER = "nul_character"
    DUPLICATE_KEY = "duplicate_key"


class BadDocumentError(ValueError):
    """Every refusal of the reader and of the writers: HTTP 400 `bad_document`.

    `reason` is a stable code, `position` the character offset in the decoded text (the byte offset for invalid UTF-8)
    when the refusal has one, else `None`. The message never echoes document content.
    """

    code = "bad_document"

    def __init__(self, reason: RefusalReason, message: str, position: int | None = None) -> None:
        """Record the reason, a content-free message and an optional position."""
        super().__init__(message)
        self.reason = reason
        self.position = position
