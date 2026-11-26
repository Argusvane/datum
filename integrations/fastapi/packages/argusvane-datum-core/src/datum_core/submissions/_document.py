"""The steps of the receiver order that read only the document, before the throttle or any seam is asked.

In order: the one size cap (measured on the tree by `json_size`, which also refuses a number JSON cannot carry, a
lone surrogate and a value with no JSON form), the document rules (an object, at most 64 deep, the check members),
the plain `{document}` wrapper and the signed wrapper, the form id, the form key, the values, the journey id and the
locale. Each refusal is `TooLarge`, `Malformed` or `NotFound`; its reason is for the log and never names an input.
"""

import re
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Final, cast

from datum_core.forms.keys import parse_form_key
from datum_core.submissions._model import FormRef, JourneyCheck, SubmissionMode
from datum_core.submissions._outcomes import Malformed, NotFound, TooLarge, Unavailable
from datum_sandbox.json import BadDocumentError, JsonValue, json_size
from datum_sandbox.protocol import json_depth

__all__ = ["MAX_DOCUMENT_DEPTH", "Delivery", "read_delivery"]

MAX_DOCUMENT_DEPTH: Final = 64
"""The deepest a submitted document may nest, counted by `json_depth` (suite REC-04)."""

_LOCALE: Final = re.compile(r"[A-Za-z0-9-]{1,32}")
_CHECK_MEMBERS: Final = frozenset({"scope", "pageId"})
_WRAPPER: Final = "document"
_WRAPPED: Final = frozenset({SubmissionMode.VALIDATE, SubmissionMode.TEST})
"""The modes whose body is always the `{document, ...}` wrapper: a bare envelope is malformed there."""
_KEY: Final = "submissionKey"
"""Beside the document: the key of the submit attempt (`SubmissionContext.submission_key` carries it to the service)."""
_SIGNED: Final = frozenset({"format", "payload", "signatures"})
_DEFAULT_LOCALE: Final = "en"
_SIGNING_REASON: Final = "Signed submissions are not set up on this server yet."


@dataclass(frozen=True, slots=True)
class Delivery:
    """A document that passed the document rules: the envelope, the form it names and what the run reads of it.

    `journey_id` is what the envelope names as it came (`None` when it names none; a non-string id is kept so the
    journey step refuses it as unknown rather than ignoring it).
    """

    envelope: Mapping[str, JsonValue]
    form_key: str
    version: str
    values: Mapping[str, JsonValue]
    locale: str
    journey_id: JsonValue
    check: JourneyCheck | None


def _record(value: object) -> Mapping[str, JsonValue] | None:
    return cast("Mapping[str, JsonValue]", value) if isinstance(value, Mapping) else None


def read_delivery(  # noqa: PLR0911 - one return per rule, in the contract's order
    document: object,
    *,
    mode: SubmissionMode,
    form: FormRef,
    max_bytes: int,
    check: JourneyCheck | None = None,
) -> Delivery | Malformed | TooLarge | NotFound | Unavailable:
    """Read `document` through the steps before the throttle; the first refusal is the answer."""
    try:
        size = json_size(document)
    except BadDocumentError as error:
        return Malformed(f"the document has no JSON form ({error.reason})")
    if size > max_bytes:
        return TooLarge(max_bytes)
    given = _record(document)
    if given is None:
        return Malformed("a submission is a JSON object")
    members: Mapping[str, JsonValue] = {}
    strict = mode in _WRAPPED
    if strict and _WRAPPER not in given:
        return Malformed("a delivery is the wrapper: the envelope under document")
    if _WRAPPER in given and ("versionContext" not in given or strict):
        allowed = {_WRAPPER, _KEY} | (_CHECK_MEMBERS if mode is SubmissionMode.VALIDATE else frozenset[str]())
        if not set(given) <= allowed:
            return Malformed("the delivery holds members besides the document and the check")
        inner = _record(given[_WRAPPER])
        if inner is None:
            return Malformed("the delivered document is not an object")
        document = inner
        members = given
    delivered = cast("Mapping[str, JsonValue]", document)
    if json_depth(delivered) > MAX_DOCUMENT_DEPTH:
        return Malformed(f"the document nests deeper than {MAX_DOCUMENT_DEPTH}")
    asked = _check_of(members, check)
    if isinstance(asked, Malformed):
        return asked
    if mode is SubmissionMode.VALIDATE and asked is None:
        return Malformed("a check names its scope: journey or page")
    envelope = _envelope_of(delivered)
    if isinstance(envelope, Malformed | Unavailable):
        return envelope
    return _named(envelope, form, asked)


def _check_of(body: Mapping[str, JsonValue], given: JourneyCheck | None) -> JourneyCheck | Malformed | None:
    """Read the check members a `validate` delivery carries beside its document (the wrapper allows them nowhere else).

    The caller's `check` stands when the body has none; naming it in both places is malformed.
    """
    if not _CHECK_MEMBERS.intersection(body):
        return given
    if given is not None:
        return Malformed("the check is named both by the caller and by the body")
    scope = body.get("scope")
    page_id = body.get("pageId")
    if scope not in ("journey", "page"):  # a tuple: a list or object scope is compared, never hashed
        return Malformed('a check\'s scope is "journey" or "page"')
    if scope == "page" and (not isinstance(page_id, str) or not page_id):
        return Malformed("a page check names the page it checks")
    if scope == "journey" and page_id is not None:
        return Malformed("a page id goes with a page check only")
    return JourneyCheck("page", cast("str", page_id)) if scope == "page" else JourneyCheck("journey")


def _envelope_of(delivered: Mapping[str, JsonValue]) -> Mapping[str, JsonValue] | Malformed | Unavailable:  # noqa: PLR0911 - one return per rule
    """Return the envelope, or the refusal.

    The plain document is its own envelope. A signed wrapper of the right shape is refused as `signing.not_set_up`
    until the signature check exists; one out of shape is `Malformed`.
    """
    if "payload" not in delivered:
        if _CHECK_MEMBERS.intersection(delivered):
            return Malformed("the envelope carries check members")
        return delivered
    if frozenset(delivered) != _SIGNED:
        return Malformed("a signed document holds exactly format, payload and signatures")
    if not isinstance(delivered["signatures"], list):
        return Malformed("a signed document lists its signatures")
    if _record(delivered["format"]) is None:
        return Malformed("a signed document says its signing format")
    if _record(delivered["payload"]) is None:
        return Malformed("a signed document's payload is an object")
    return Unavailable("signing.not_set_up", _SIGNING_REASON)


def _named(
    envelope: Mapping[str, JsonValue], form: FormRef, check: JourneyCheck | None
) -> Delivery | Malformed | NotFound:
    """Read the form id, the form key, the values, the journey id and the locale, in that order."""
    context = _record(envelope.get("versionContext"))
    named = _record(context.get("form")) if context is not None else None
    form_id = named.get("id") if named is not None else None
    version = named.get("version") if named is not None else None
    if not isinstance(form_id, str) or not isinstance(version, str):
        return Malformed("a submission names its form: versionContext.form.id and version")
    if form.key is not None and form_id != form.key:
        return Malformed("the document names another form than the one asked for")
    parsed = parse_form_key(form_id)
    if parsed is None or parsed[1] is not None:
        return NotFound(form_id)
    submission = _record(envelope.get("submission"))
    values = _record(submission.get("values")) if submission is not None else None
    if submission is None or values is None:
        return Malformed("a submission holds its answers as submission.values")
    journey = submission.get("journey")
    journey_id: JsonValue = None
    if isinstance(journey, dict):
        journey_id = journey.get("id")
    elif journey is not None:
        journey_id = journey
    locale = submission.get("locale", _DEFAULT_LOCALE)
    if not isinstance(locale, str) or _LOCALE.fullmatch(locale) is None:
        return Malformed("the locale is a short language tag")
    return Delivery(envelope, form_id, version, values, locale, journey_id, check)
