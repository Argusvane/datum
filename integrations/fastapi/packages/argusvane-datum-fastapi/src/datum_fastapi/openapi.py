"""OpenAPI support: tags, the shared `responses` dicts, operation options, group documents.

Built on: `fastapi.openapi.utils.get_openapi` builds a document from a list of routes, so a group
document is that call over a Datum-owned router's routes, never over the application's. The error body schemas are
pydantic models (`DatumWireModel`) so FastAPI registers them under `components.schemas` once; `http.HTTPStatus`
supplies the status phrases; `datum_core.http.error_envelope_schema` is the framework-free twin of the models for a
caller that has no FastAPI. Nothing here iterates the application's routes or sets `generate_unique_id_function`.

The route tables below are the catalog's rows for the routes this binding serves (`integrations/shared/
endpoint-catalog.json`); the drift test holds them to the catalog. Every operation also documents `500`, `503` and a
`default` response: the default is what keeps FastAPI from adding its own `422` (it adds that only when no `422`,
`4XX` or `default` is documented), and Datum answers a bad parameter as `400 bad_request`. A route that takes a body
adds the catalog's body defaults (400, 413, 415, 422) and a POST its `429`; the builder's two saves (`saveForm`,
`saveFormTranslations`) are PUTs, so they document no `429`, and they carry the catalog's `If-Match` header parameter
(`IfMatch`), which `createForm` does not.

The PDF routes (`routers.pdf`) document raw bodies: `{document, layoutId?}` JSON for the three that print and a
binary `application/pdf` for verify, which still takes the catalog's body defaults. The three that print document their
500 as `internal` and `signature` (a seal not made), the one 500 code beyond the catalog's. The printing routes answer a
binary PDF with `X-Page-Count` and the headers the kit reads beyond the catalog (`X-Signed-By`, `X-Signature-Field`,
`X-Datum-Layout`, `X-Datum-Pdf-Theme`; the drift test names them as an allowance); verify answers the catalog's
`PdfVerifyReport` with its
`PdfSignatureVerdict` and `PdfTrustPolicySummary` (models here, registered under `components.schemas` by name); the
server's certificate answers PEM text. The routes that write their own bytes (the PDF, PEM and timestamp answers) have
no JSON response class, so their JSON refusals are documented under `application/json`, with a note in problem mode.
"""

import copy
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import datetime
from http import HTTPStatus
from typing import Any, Final, Literal

from fastapi import APIRouter, Request, params
from fastapi.exceptions import HTTPException
from fastapi.openapi.utils import get_openapi
from fastapi.responses import JSONResponse
from pydantic.json_schema import SkipJsonSchema
from starlette.responses import Response

from datum_core.datum import Datum, core_version
from datum_core.http import DEFAULT_RESPONSE_DESCRIPTION, PDF_MEDIA_TYPE, DatumWireModel, openapi_extra
from datum_core.http.builder import NO_STORE
from datum_core.http.timestamp import (
    BASIC_CHALLENGE,
    CERTIFICATE_DER_MEDIA_TYPE,
    PEM_MEDIA_TYPE,
    QUERY_MEDIA_TYPES,
    REPLY_MEDIA_TYPE,
)

__all__ = [
    "DATUM_OPENAPI_TAGS",
    "IF_MATCH_PARAMETER",
    "MANAGEMENT",
    "ErrorItem",
    "ErrorsBody",
    "OperationDoc",
    "PdfSignatureVerdict",
    "PdfTrustPolicySummary",
    "PdfVerifyReport",
    "ProblemDetail",
    "ProblemJSONResponse",
    "add_group_document",
    "management_options",
    "openapi_tags",
    "operation_options",
]

JSON: Final = "application/json"
PROBLEM_JSON: Final = "application/problem+json"
_REFUSED_BY_APPLICATION: Final = (
    "Refused by the application's own security (access.denied); Datum adds no authentication of its own."
)
_ETAG: Final = {"ETag": {"description": "The strong entity tag of the representation.", "schema": {"type": "string"}}}
_RETRY_AFTER: Final = {
    "Retry-After": {
        "description": "Seconds to wait before trying again. On a 503 only server.busy carries it.",
        "schema": {"type": "integer", "minimum": 0},
    }
}
_BUILDER_HEADERS: Final = {
    "Location": {
        "description": "Where the created form's full definition is read.",
        "schema": {"type": "string"},
    },
    "X-Datum-Removed-Locales": {
        "description": "The locales a save removed, comma separated.",
        "schema": {"type": "string"},
    },
}
IF_MATCH_PARAMETER: Final = {
    "name": "If-Match",
    "in": "header",
    "required": False,
    "description": "The ETag of the version being replaced; a stale one answers 409.",
    "schema": {"type": "string"},
}
"""The catalog's `IfMatch` parameter, description verbatim, documented on `saveForm` and `saveFormTranslations`."""


# ---- the error bodies --------------------------------------------------------------------------------------------
class ErrorItem(DatumWireModel):
    """One error: the component id it belongs to (null when none), a stable code, and host-worded text."""

    field: str | None = None
    code: str
    message: str | None = None


class ErrorsBody(DatumWireModel):
    """An error answer: `{errors:[{field, code, message?}]}`."""

    errors: list[ErrorItem]


class ProblemDetail(DatumWireModel):
    """RFC 9457 problem details with the same codes (`datum.web.api.problem_details=true`)."""

    type: str = "about:blank"
    title: str
    status: int
    detail: str | None = None
    code: str
    correlation_id: str | None = None
    errors: list[ErrorItem]


# ---- the verify report (the catalog's three schemas) --------------------------------------------------------------
class _Documented(DatumWireModel):
    """A wire model whose members' docstrings are their schema descriptions (pydantic's own option)."""

    model_config = {"use_attribute_docstrings": True}  # noqa: RUF012 - pydantic's config, merged with the base's


class PdfTrustPolicySummary(_Documented):
    """The trust policy a verify report placed its signers under."""

    name: str
    """The policy's name; `default` for the configured anchors."""
    revocation_checking: bool
    """Whether revocation status was checked."""
    validation_time: Literal["now", "signing-time"]
    """When chains were judged."""


class PdfSignatureVerdict(_Documented):
    """One signature of a verify report, checked and placed."""

    field: str
    """The signature field, or empty when no field links it any more."""
    value: Literal["valid", "invalid", "unchecked"]
    """The signature value under the signer's key."""
    digest_matches: bool = False
    """The file still hashes to what was signed."""
    certificate_matches: bool = False
    """The signed attributes name the signer's certificate."""
    covers_document: bool = False
    """Nothing was appended after it."""
    intact: bool
    """The digest, the binding and the value all hold (and any later change is one the signature allows)."""
    trust: Literal["site", "site_retired", "trusted", "self_signed", "unknown"]
    """Where the signer's chain stands."""
    signing_time: str | None = None
    """The signed revision's /M: the signer's own claim, never used for trust."""
    trusted_at: datetime | None = None
    """The instant the chain to an anchor was judged at; only for a trusted chain."""


class PdfVerifyReport(_Documented):
    """A verify report: the file's hash and size, each signature, the document key, the warnings, the policy."""

    sha256: str
    """The file's SHA-256, lowercase hex."""
    bytes: int
    """The file's size in bytes."""
    signatures: tuple[PdfSignatureVerdict, ...]
    """Each signature, in the file's order."""
    document_id: str | None = None
    """The document key an intact signature signed, else the file's current one."""
    document_id_source: Literal["signed", "current"] | None = None
    """Where `documentId` came from: `signed` or `current`."""
    warnings: tuple[str, ...] = ()
    """The program's warnings, then the host's."""
    trust_policy: SkipJsonSchema[None] | PdfTrustPolicySummary = None
    """The policy the signers were placed under; absent or a policy, never null (the catalog's `nullable: false`)."""


class ProblemJSONResponse(JSONResponse):
    """The response class of a route in problem mode: only its media type is read, to document `problem+json`."""

    media_type = PROBLEM_JSON


# ---- tags --------------------------------------------------------------------------------------------------------
_TAG_DESCRIPTIONS: Final = {
    "forms": "Form definitions, their translations and their data sources.",
    "submissions": "Submit and validate a form's answers.",
    "ui": "The form builder's save routes.",
    "pdf": "Render, fill, sign and verify PDFs.",
    "tsa": "The RFC 3161 timestamp authority.",
    "webauthn": "The passkey ceremony for signed submissions.",
    "management": "Liveness, readiness, health and information about the running Datum.",
}


def openapi_tags(prefix: str = "datum-") -> list[dict[str, str]]:
    """Return the tag descriptions for `FastAPI(openapi_tags=...)`, named with `prefix` (the `tag_prefix` setting)."""
    return [{"name": f"{prefix}{name}", "description": text} for name, text in _TAG_DESCRIPTIONS.items()]


DATUM_OPENAPI_TAGS: Final = openapi_tags()
"""The tag descriptions under the default prefix; pass it as `FastAPI(openapi_tags=DATUM_OPENAPI_TAGS)`."""


# ---- the route tables --------------------------------------------------------------------------------------------
type _Row = tuple[int, tuple[str, ...], tuple[str, ...]]
"""(status, codes, headers): one status of a catalog row."""

_NOT_FOUND: Final = ("form.notFound",)
_UNAVAILABLE: Final = ("server.unavailable", "server.busy")
_SERVICE_UNAVAILABLE: Final = ("server.unavailable", "server.busy", "validator_unavailable", "data_source.unavailable")
_RUN_FAILED: Final = ("wasm.execution_error", "outcome_too_large", "definition.tooDeep")
"""A run that gave no verdict: 503 with the code, never 422 or 500, and no Retry-After."""
_INSPECT_UNAVAILABLE: Final = (*_UNAVAILABLE, "wasm.execution_error", "outcome_too_large")
_JUDGING_UNAVAILABLE: Final = (*_SERVICE_UNAVAILABLE, *_RUN_FAILED)
_JUDGING_503: Final[Mapping[int, Mapping[str, Any]]] = {
    503: {
        "description": (
            "Service Unavailable: no verdict was reached (server.unavailable, server.busy, validator_unavailable, "
            "data_source.unavailable). Only server.busy carries Retry-After. A run that failed (wasm.execution_error, "
            "outcome_too_large, definition.tooDeep of the registered form) answers with its own code, because the same "
            "run fails the same way."
        )
    }
}


@dataclass(frozen=True, slots=True)
class OperationDoc:
    """What the catalog says about one operation: its words, its statuses and its success body."""

    summary: str
    description: str
    rows: tuple[_Row, ...]
    success: Mapping[str, Any]
    request: Mapping[str, Any] | None = None
    """The JSON schema of a raw request body, or `None` for a route that takes none (a body route adds its own rows)."""
    method: str = "GET"
    """The operation's method: a POST that takes a body also documents the catalog's `429`."""
    if_match: bool = False
    """Whether the operation takes the catalog's `If-Match` header parameter (the builder's two saves)."""
    request_content: Mapping[str, Any] | None = None
    """The whole `content` of a raw request body that is not JSON (the timestamp query), replacing `request`."""
    replies: Mapping[int, Mapping[str, Any]] = field(default_factory=dict)
    """Per-status words, header names and `content` that replace the generic entry (the timestamp server answers text
    and DER, not the JSON error body); `errors: True` keeps the JSON error model beside the given content."""
    raw: bool = False
    """Whether the route writes its own bytes (no JSON response class, no problem-details media type)."""
    body: bool = False
    """Whether a route whose body is not JSON (`request_content`) still documents the catalog's body defaults."""
    success_model: type[DatumWireModel] | None = None
    """The model of the success body, registered under `components.schemas` (the verify report)."""

    @property
    def takes_body(self) -> bool:
        """Whether the route documents the catalog's body defaults (and, as a POST, its `429`)."""
        return self.request is not None or self.body


_DEFINITION_BODY: Final = {JSON: {"schema": {"type": "object", "additionalProperties": True}}}
_TRANSLATIONS_BODY: Final = {
    JSON: {
        "schema": {
            "type": "object",
            "additionalProperties": {"type": "object", "additionalProperties": {"type": "string"}},
        }
    }
}
_ITEMS_BODY: Final = {
    JSON: {
        "schema": {
            "type": "object",
            "properties": {"items": {"type": "array", "items": {"type": "object", "additionalProperties": True}}},
            "required": ["items"],
        }
    }
}

_DOCUMENT_REQUEST: Final = {
    "type": "object",
    "description": 'The delivery: `{"document": envelope}`, with `submissionKey` on a submit.',
    "additionalProperties": True,
}
_VALIDATE_REQUEST: Final = {
    "type": "object",
    "description": (
        "The check: the envelope under `document` and the `scope` of the check. A body that is the bare envelope, or "
        "has no `scope`, is 400 bad_document."
    ),
    "properties": {
        "document": {"type": "object", "additionalProperties": True, "description": "The envelope the form emits."},
        "scope": {"type": "string", "enum": ["journey", "page"], "description": "Required: what is checked."},
        "pageId": {"type": "string", "description": "The page to check: required with `page`, refused with `journey`."},
        "submissionKey": {"type": "string", "description": "Accepted and ignored."},
    },
    "required": ["document", "scope"],
    "additionalProperties": False,
}
_INSPECT_REQUEST: Final = {
    "type": "object",
    "properties": {
        "op": {"type": "string", "description": "What to ask: a word of at most 64 letters."},
        "definition": {"type": "object", "additionalProperties": True},
    },
    "required": ["op", "definition"],
}
_ERROR_ITEMS: Final = {"type": "array", "items": {"type": "object", "additionalProperties": True}}
_RECEIPT_BODY: Final = {
    JSON: {
        "schema": {
            "type": "object",
            "properties": {
                "id": {"type": "string"},
                "reference": {"type": "string"},
                "status": {"type": "string", "enum": ["accepted"]},
                "digest": {"type": "string"},
                "handled": {"type": "boolean"},
                "receipt": {"type": "object", "additionalProperties": True},
                "warnings": _ERROR_ITEMS,
            },
            "required": ["id", "reference", "status", "digest", "handled"],
        }
    }
}
_CHECKED_BODY: Final = {
    JSON: {
        "schema": {
            "type": "object",
            "properties": {
                "accepted": {"type": "boolean"},
                "errors": {
                    "type": "array",
                    "description": "The blocking errors only: `{field?, code, message?}`. Empty when accepted.",
                    "items": {"type": "object", "additionalProperties": True},
                },
                "notes": {
                    "type": "array",
                    "description": (
                        "The warnings and info items, never blocking: `{field?, code, severity, message?}` with "
                        "`severity` `warning` or `info`, and `message` only when the sandbox or a validator gave one. "
                        "The member is absent (never an empty list) when there are none."
                    ),
                    "items": {
                        "type": "object",
                        "properties": {
                            "field": {"type": "string"},
                            "code": {"type": "string"},
                            "severity": {"type": "string", "enum": ["warning", "info"]},
                            "message": {"type": "string", "description": "Text for a person; absent when none."},
                        },
                        "required": ["code", "severity"],
                    },
                },
            },
            "required": ["accepted", "errors"],
        }
    }
}


def _id_list(description: str) -> dict[str, object]:
    return {"type": "array", "items": {"type": "string"}, "description": description}


_FINDING: Final = {
    "type": "object",
    "description": "One finding of the run, with its severity.",
    "properties": {
        "field": {"type": ["string", "null"], "description": "The component id the finding names, or null."},
        "code": {"type": "string", "description": "The finding's stable code."},
        "message": {"type": ["string", "null"], "description": "The words for a person, or null when none was given."},
        "severity": {
            "type": "string",
            "description": "error blocks; warning and info do not. A finding with no severity is an error.",
        },
        "stage": {"type": ["string", "null"], "description": "Where the run found it, or null."},
        "source": {"type": ["string", "null"], "description": "What found it (the sandbox or the server), or null."},
    },
    "required": ["field", "code", "message", "severity", "stage", "source"],
}
_DRY_RUN_BODY: Final = {
    JSON: {
        "schema": {
            "type": "object",
            "description": "The dry run's report: one flat object, the same on every Datum host.",
            "properties": {
                "outcome": {
                    "type": "string",
                    "enum": ["accepted", "rejected"],
                    "description": "Whether a delivery of the document would be accepted.",
                },
                "stage": {
                    "type": ["string", "null"],
                    "description": "Where a rejection happened (journey, sandbox or server); null when accepted.",
                },
                "errors": {
                    "type": "array",
                    "items": _FINDING,
                    "description": (
                        "Every finding, in the order found, with its severity: warnings and info sit beside the "
                        "blocking errors, and an accepted document can still list some."
                    ),
                },
                "sent": {
                    "type": "object",
                    "additionalProperties": True,
                    "description": "The answers as the caller sent them, before the run kept or dropped any.",
                },
                "values": {
                    "type": ["object", "null"],
                    "additionalProperties": True,
                    "description": "The answers the run kept, or null when it kept none.",
                },
                "clientDerived": _id_list("Components whose answers were worked out in the browser and kept as sent."),
                "clockDependent": _id_list("Components and pages whose rules read the clock."),
                "serverRules": _id_list("Components whose server or server-secret rules the run applied."),
                "visibilitySkipped": _id_list(
                    "Components whose own visibleWhen the server could not replay; treated as hidden for requiredness."
                ),
                "document": {
                    "type": ["string", "null"],
                    "description": "The canonical text of the document that was digested; null when no run happened.",
                },
                "digest": {
                    "type": ["string", "null"],
                    "description": "The SHA-256 of the canonical document, in hex; null when no run happened.",
                },
                "logs": {
                    "type": "array",
                    "items": {"type": "object", "additionalProperties": True},
                    "description": "The run's own log entries, empty when it logged none.",
                },
                "sandbox": {
                    "type": ["object", "null"],
                    "description": "How the run was set; null when no run happened.",
                    "properties": {
                        "elapsedMs": {"type": "number", "description": "The run's wall time in milliseconds."},
                        "rules": {
                            "type": "array",
                            "items": {"type": "string"},
                            "description": "The ids of the server rule modules the run loaded.",
                        },
                        "unknownFields": {
                            "type": ["string", "null"],
                            "description": "What the run did with answers the form does not know.",
                        },
                        "logLevel": {"type": ["string", "null"], "description": "The run's log level."},
                    },
                    "required": ["elapsedMs", "rules", "unknownFields", "logLevel"],
                },
                "signature": {
                    "type": ["object", "null"],
                    "description": "The signature check's verdict (status and errors); null when no check ran.",
                    "additionalProperties": True,
                },
            },
            "required": [
                "outcome",
                "stage",
                "errors",
                "sent",
                "values",
                "clientDerived",
                "clockDependent",
                "serverRules",
                "visibilitySkipped",
                "document",
                "digest",
                "logs",
                "sandbox",
                "signature",
            ],
        }
    }
}
_INSPECT_BODY: Final = {JSON: {"schema": {"type": "object", "additionalProperties": True}}}
_FORM_DEFINITION_REQUEST: Final = {
    "type": "object",
    "description": "The form definition to store, its `id` the form's key.",
    "additionalProperties": True,
}
_CATALOG_REQUEST: Final = {
    "type": "object",
    "description": (
        "The translation catalog (locale, then kind, then owner, then property segments down to text), as "
        '`{"catalog": catalog}` or the catalog itself.'
    ),
    "additionalProperties": True,
}
_SAVED_BODY: Final = {
    JSON: {
        "schema": {
            "type": "object",
            "properties": {
                "key": {"type": "string"},
                "version": {"type": ["string", "null"]},
                "sha256": {"type": "string"},
                "savedAt": {"type": "string", "format": "date-time"},
                "catalog": {"type": "object", "additionalProperties": True},
                "warnings": {"type": "array", "items": {"type": "string"}},
                "kernelWarnings": _ERROR_ITEMS,
                "removedLocales": {"type": "array", "items": {"type": "string"}},
            },
            "required": ["key", "sha256", "savedAt", "catalog", "warnings", "kernelWarnings", "removedLocales"],
        }
    }
}
_CATALOG_SAVED_BODY: Final = {
    JSON: {
        "schema": {
            "type": "object",
            "properties": {
                "catalog": {"type": "object", "additionalProperties": True},
                "savedAt": {"type": "string", "format": "date-time"},
            },
            "required": ["catalog", "savedAt"],
        }
    }
}
_BUILDER_WORDS: Final = "For the form builder: the application guards this route."

_BINARY: Final = {"type": "string", "format": "binary"}
_TEXT: Final = "text/plain"
_TEXT_BODY: Final = {_TEXT: {"schema": {"type": "string"}}}
_REPLY_BODY: Final = {REPLY_MEDIA_TYPE: {"schema": _BINARY}}
_QUERY_BODY: Final = {media_type: {"schema": _BINARY} for media_type in QUERY_MEDIA_TYPES}
_CERTIFICATE_HEADERS: Final = ("Cache-Control",)
_TSA_WORDS: Final = "Public: it has its own client-key rule, and no cookie, session or application state is read."

_PDF_BODY: Final = {PDF_MEDIA_TYPE: {"schema": _BINARY}}
_PRINTED_DOCUMENT: Final[dict[str, Any]] = {
    "type": "object",
    "description": "The submission document (the envelope a delivery takes), judged as a delivery is.",
    "additionalProperties": True,
}
_PDF_REQUEST: Final[dict[str, Any]] = {
    "type": "object",
    "description": "The submission document to print and, optionally, the layout to print it with.",
    "properties": {
        "document": _PRINTED_DOCUMENT,
        "layoutId": {
            "type": ["string", "null"],
            "minLength": 1,
            "description": "The definition's layout to print; absent or null lets the definition choose.",
        },
    },
    "required": ["document"],
}
_FILL_REQUEST: Final[dict[str, Any]] = {
    "type": "object",
    "description": "The submission document and the template layout to fill with its answers.",
    "properties": {
        "document": _PRINTED_DOCUMENT,
        "layoutId": {"type": "string", "minLength": 1, "description": "The template layout to fill."},
    },
    "required": ["document", "layoutId"],
}
_PRINTED_HEADERS: Final = (
    "Cache-Control",
    "X-Page-Count",
    "X-Signed-By",
    "X-Signature-Field",
    "X-Datum-Layout",
    "X-Datum-Pdf-Theme",
)
_PDF_400: Final = ("bad_request", "bad_document")
VERIFY_ADMISSION_ALLOWANCE: Final = ("bad_request",)
"""The one code beyond the catalog's on verifyPdf's 400: a `Content-Length` that is not a whole number is the
malformed-framing `bad_request` on every PDF operation, and the catalog's verify row does not list it (a named drift
allowance in the drift test; an owner item for the catalog)."""
_PDF_404: Final = ("form.notFound", "layout.notFound")
_PDF_500: Final = ("internal", "signature")
"""The 500 of the three printing routes: `signature` is a seal not made (no server key for a seal that needs one, a
handoff the seal refuses, a signer that raised, the PDF program's own signing refusal); like `internal`, no message."""
_PDF_422_WORDS: Final = (
    "The answers were refused (the form's error codes, or a pre-check's, a customizer's or a result validator's own), "
    "the document names a version that is not the current one (form.outdated), or the PDF program refused the "
    "definition or the answers (template, render_limit, unknown_component, conformance, attachment_budget)."
)
_PRINT_WORDS: Final = (
    "Takes `{document, layoutId?}` as JSON. The document is judged as a delivery would be (the form's rules, the "
    "application's pre-checks and validators), with no handler, no stored record and no submission event; refused "
    "answers are not printed. The application guards this route."
)
_PRINTED_CACHE: Final = {
    "Cache-Control": {"description": "Always no-store: the file carries the answers.", "schema": {"type": "string"}}
}
_REPORT_CACHE: Final = {
    "Cache-Control": {"description": "Always no-store.", "schema": {"type": "string"}},
}
_PEM_CACHE: Final = {
    "Cache-Control": {"description": "no-cache: the chain may be revalidated.", "schema": {"type": "string"}},
}
_PDF_RAW: Final = frozenset({"renderPdf", "fillPdf", "signPdf", "serverCertificate"})
"""The PDF routes that write their own bytes: in problem mode their JSON refusals carry the timestamp routes' note."""

OPERATIONS: Final[Mapping[str, OperationDoc]] = {
    "getFormDefinition": OperationDoc(
        summary="Read a form definition",
        description=(
            "Returns the form's public definition: server-secret rules are removed, and the application's "
            "customizers have run. `key` is the form id, or `id@version` for the current version. Answers 304 for a "
            "matching `If-None-Match`."
        ),
        rows=(
            (200, (), ("ETag",)),
            (304, (), ("ETag",)),
            (400, ("bad_request",), ()),
            (403, ("access.denied",), ()),
            (404, _NOT_FOUND, ()),
        ),
        success=_DEFINITION_BODY,
    ),
    "getFormTranslations": OperationDoc(
        summary="Read a form's translations",
        description=(
            "Returns the form's translation catalog (locale, then kind, then owner, then property segments), with a "
            "strong ETag. Answers 304 for a matching `If-None-Match`."
        ),
        rows=(
            (200, (), ("ETag",)),
            (304, (), ("ETag",)),
            (403, ("access.denied",), ()),
            (404, _NOT_FOUND, ()),
        ),
        success=_TRANSLATIONS_BODY,
    ),
    "getDataSourceItems": OperationDoc(
        summary="Read the items of a data source",
        description=(
            "Returns the items the application's data-source provider offers for the id, optionally for a locale "
            "and a form. The providers share one deadline (`datum.forms.data_sources.timeout`)."
        ),
        rows=(
            (200, (), ()),
            (403, ("access.denied",), ()),
            (404, ("data_source.notFound",), ()),
            (503, ("server.unavailable", "server.busy", "data_source.unavailable"), ("Retry-After",)),
        ),
        success=_ITEMS_BODY,
    ),
    "submitSubmission": OperationDoc(
        summary="Submit a form's answers",
        description=(
            "Judges a submission document, sent as `{document, submissionKey}` (the key the browser mints once per "
            "submit attempt, the same on a retry), as the form's rules say, and hands an accepted one to the "
            "application's handler once. Answers the receipt; the same key and document again answers the first "
            "receipt with `handled: true`. A body without a key is 400 `bad_document`. A run that fails is no verdict: "
            "503 with the run's code."
        ),
        rows=(
            (200, (), ()),
            (403, ("access.denied",), ()),
            (404, _NOT_FOUND, ()),
            (409, ("form.outdated", "submission.keyConflict"), ()),
            (503, _JUDGING_UNAVAILABLE, ("Retry-After",)),
        ),
        replies=_JUDGING_503,
        success=_RECEIPT_BODY,
        request=_DOCUMENT_REQUEST,
        method="POST",
    ),
    "validateSubmission": OperationDoc(
        summary="Validate a form's answers",
        description=(
            "Judges a submission document as a delivery would and keeps nothing: `accepted`, the blocking `errors` "
            "and, when there are any, the non-blocking `notes`. The body is `{document, scope}` with `pageId` for a "
            "page check; `scope` is required. A verdict of not accepted is still a 200; a run that fails is no "
            "verdict: 503 with the run's code, as when the sandbox is busy or unavailable."
        ),
        rows=(
            (200, (), ()),
            (403, ("access.denied",), ()),
            (404, _NOT_FOUND, ()),
            (409, ("form.outdated",), ()),
            (503, _JUDGING_UNAVAILABLE, ("Retry-After",)),
        ),
        replies=_JUDGING_503,
        success=_CHECKED_BODY,
        request=_VALIDATE_REQUEST,
        method="POST",
    ),
    "testSubmission": OperationDoc(
        summary="Dry-run a submission",
        description=(
            "Runs every check as a delivery would, with no handler, no stored record and no event, and answers the "
            "verdict with the run's report. A run that fails is no verdict: 503 with the run's code. For authoring: "
            "the application guards this route."
        ),
        rows=(
            (200, (), ()),
            (403, ("access.denied",), ()),
            (404, _NOT_FOUND, ()),
            (503, _JUDGING_UNAVAILABLE, ("Retry-After",)),
        ),
        replies=_JUDGING_503,
        success=_DRY_RUN_BODY,
        request=_DOCUMENT_REQUEST,
        method="POST",
    ),
    "inspectDefinition": OperationDoc(
        summary="Inspect a form definition",
        description=(
            "Asks the program a question about a form definition given in the body (`op` and `definition`) and "
            "answers the program's answer as it gave it. A definition nested past the depth guard is refused before "
            "any run: 422 definition.tooDeep. A run that fails is the server's failure: 503 with the run's code. "
            "For authoring: the application guards this route."
        ),
        rows=(
            (200, (), ()),
            (403, ("access.denied",), ()),
            (404, _NOT_FOUND, ()),
            (422, ("definition.tooDeep",), ()),
            (503, _INSPECT_UNAVAILABLE, ("Retry-After",)),
        ),
        replies=_JUDGING_503,
        success=_INSPECT_BODY,
        request=_INSPECT_REQUEST,
        method="POST",
    ),
    "createForm": OperationDoc(
        summary="Create a form",
        description=(
            "Stores a new form under the `id` its definition carries, after the host's shape rules, the "
            "application's hooks and the kernel's check. Takes no precondition. Answers 201 with the stored "
            f"version's `ETag` and the `Location` of its full definition. {_BUILDER_WORDS}"
        ),
        rows=(
            (201, (), ("ETag", "Location")),
            (403, ("access.denied",), ()),
            (409, ("form.exists",), ()),
            (422, (), ()),
            (501, ("forms.readOnly",), ()),
        ),
        success=_SAVED_BODY,
        request=_FORM_DEFINITION_REQUEST,
        method="POST",
    ),
    "saveForm": OperationDoc(
        summary="Save a form",
        description=(
            "Stores a new version of the form after the host's shape rules, the application's hooks and the "
            "kernel's check. `If-Match` names the version being replaced: a stale one answers 409 `form.outdated` "
            "with the current `ETag`. `X-Datum-Locale-Changes` moves the translation catalog with the save; the "
            f"locales it removed come back in `X-Datum-Removed-Locales`. {_BUILDER_WORDS}"
        ),
        rows=(
            (200, (), ("ETag", "X-Datum-Removed-Locales")),
            (403, ("access.denied",), ()),
            (404, _NOT_FOUND, ()),
            (409, ("form.outdated",), ("ETag",)),
            (422, (), ()),
            (501, ("forms.readOnly",), ()),
        ),
        success=_SAVED_BODY,
        request=_FORM_DEFINITION_REQUEST,
        method="PUT",
        if_match=True,
    ),
    "saveFormTranslations": OperationDoc(
        summary="Save a form's translations",
        description=(
            "Stores the form's translation catalog. `If-Match` names the catalog being replaced (the `ETag` of "
            f"the translations read): a stale one answers 409 `form.outdated` with the current `ETag`. {_BUILDER_WORDS}"
        ),
        rows=(
            (200, (), ("ETag",)),
            (403, ("access.denied",), ()),
            (404, _NOT_FOUND, ()),
            (409, ("form.outdated",), ("ETag",)),
            (422, ("catalog.invalid",), ()),
        ),
        success=_CATALOG_SAVED_BODY,
        request=_CATALOG_REQUEST,
        method="PUT",
        if_match=True,
    ),
    "issueTimestamp": OperationDoc(
        summary="Issue a timestamp token",
        description=(
            "Takes a DER `TimeStampReq` (RFC 3161) as `application/timestamp-query` and answers a DER `TimeStampResp` "
            "as `application/timestamp-reply`: 200 with the token, or 400 / 503 with a rejection whose failure info "
            "says why. Refusals before the service are plain text, in this order: a cookie (403), the media type "
            "(415), the client key (401, or 429 for too many wrong keys), the flood limit (429), the size (413). "
            f"{_TSA_WORDS}"
        ),
        rows=(
            (200, (), ("Cache-Control",)),
            (400, (), ("Cache-Control",)),
            (401, (), ("Cache-Control", "WWW-Authenticate")),
            (403, (), ("Cache-Control",)),
            (413, (), ("Cache-Control",)),
            (415, (), ("Cache-Control",)),
            (429, (), ("Cache-Control", "Retry-After")),
            (503, (), ("Cache-Control", "Retry-After")),
        ),
        success=_REPLY_BODY,
        request_content=_QUERY_BODY,
        method="POST",
        raw=True,
        replies={
            200: {"description": "The token: a DER TimeStampResp with PKIStatus granted.", "content": _REPLY_BODY},
            400: {
                "description": "Rejected: a DER TimeStampResp whose failure info names the fault.",
                "content": _REPLY_BODY,
            },
            401: {
                "description": f"No known client key. Challenge: {BASIC_CHALLENGE}.",
                "content": _TEXT_BODY,
            },
            403: {
                "description": (
                    "Refused: the request carries a cookie named by datum.tsa.session_cookies (by default any), "
                    "which no timestamp client sends; the application's session cookies are not accepted here."
                ),
                "content": _TEXT_BODY,
            },
            413: {"description": "The request is larger than datum.tsa.max_request_size.", "content": _TEXT_BODY},
            415: {
                "description": "The Content-Type is not application/timestamp-query or application/timestamp-request.",
                "content": _TEXT_BODY,
            },
            429: {
                "description": "Too many requests, or too many wrong client keys from this address; wait Retry-After.",
                "content": _TEXT_BODY,
            },
            503: {
                "description": (
                    "A DER rejection (time not available, system failure), or the JSON server.unavailable / "
                    "server.busy refusal; try again."
                ),
                "content": _REPLY_BODY,
                "errors": True,
            },
        },
    ),
    "getTimestampCertificate": OperationDoc(
        summary="Read the timestamp certificate",
        description=(
            "Answers the signing certificate chain, leaf first, as PEM; `?format=der` answers the leaf alone as "
            f"`application/pkix-cert`; any other value answers PEM. {_TSA_WORDS}"
        ),
        rows=((200, (), _CERTIFICATE_HEADERS), (503, ("server.unavailable",), ())),
        success={PEM_MEDIA_TYPE: {"schema": {"type": "string"}}, CERTIFICATE_DER_MEDIA_TYPE: {"schema": _BINARY}},
        raw=True,
    ),
    "renderPdf": OperationDoc(
        summary="Print posted answers as a PDF",
        description=(
            f"{_PRINT_WORDS} Prints the layout named by `layoutId`, else the one the definition chooses. With "
            "datum.pdf.seal on, the file is sealed with a throwaway test certificate: posted answers are never sealed "
            "with the server's key."
        ),
        rows=(
            (200, (), _PRINTED_HEADERS),
            (400, _PDF_400, ()),
            (403, ("access.denied",), ()),
            (404, _PDF_404, ()),
            (413, ("bad_document",), ()),
            (415, ("unsupported_media_type",), ()),
            (422, (), ()),
            (429, ("flood",), ("Retry-After",)),
            (500, _PDF_500, ()),
            (503, _JUDGING_UNAVAILABLE, ("Retry-After",)),
        ),
        success=_PDF_BODY,
        request=_PDF_REQUEST,
        method="POST",
        raw=True,
        replies={200: {"headers": _PRINTED_CACHE}, 422: {"description": _PDF_422_WORDS}, **_JUDGING_503},
    ),
    "fillPdf": OperationDoc(
        summary="Fill a template layout with posted answers",
        description=(
            f"{_PRINT_WORDS} Fills the template layout `layoutId` names (a layout of another kind answers 400 "
            "layout.notTemplate); sealed as the render route's files are."
        ),
        rows=(
            (200, (), _PRINTED_HEADERS),
            (400, (*_PDF_400, "layout.notTemplate"), ()),
            (403, ("access.denied",), ()),
            (404, _PDF_404, ()),
            (413, ("bad_document",), ()),
            (415, ("unsupported_media_type",), ()),
            (422, (), ()),
            (429, ("flood",), ("Retry-After",)),
            (500, _PDF_500, ()),
            (503, _JUDGING_UNAVAILABLE, ("Retry-After",)),
        ),
        success=_PDF_BODY,
        request=_FILL_REQUEST,
        method="POST",
        raw=True,
        replies={200: {"headers": _PRINTED_CACHE}, 422: {"description": _PDF_422_WORDS}, **_JUDGING_503},
    ),
    "signPdf": OperationDoc(
        summary="Print posted answers and sign them with the server's key",
        description=(
            f"{_PRINT_WORDS} Prints as the render route does and signs the file with the server's own key (503 "
            "server.unavailable while the server has none); `X-Signed-By` names the signer."
        ),
        rows=(
            (200, (), _PRINTED_HEADERS),
            (400, _PDF_400, ()),
            (403, ("access.denied",), ()),
            (404, _PDF_404, ()),
            (413, ("bad_document",), ()),
            (415, ("unsupported_media_type",), ()),
            (422, (), ()),
            (429, ("flood",), ("Retry-After",)),
            (500, _PDF_500, ()),
            (503, _JUDGING_UNAVAILABLE, ("Retry-After",)),
        ),
        success=_PDF_BODY,
        request=_PDF_REQUEST,
        method="POST",
        raw=True,
        replies={200: {"headers": _PRINTED_CACHE}, 422: {"description": _PDF_422_WORDS}, **_JUDGING_503},
    ),
    "verifyPdf": OperationDoc(
        summary="Verify the signatures of a PDF",
        description=(
            "Takes the file as `application/pdf` (at most datum.runtime.verify_max_bytes) and answers a report of "
            "every signature: its value under the signer's key, whether it is intact, and where the signer's chain "
            "stands under the server's trust policy. Bytes that are not a PDF answer 400 pdf.notAPdf; a file the PDF "
            "program cannot read, 400 pdf.unreadable; a Content-Length that is not a whole number, 400 bad_request. "
            "Public: no dependency of the application runs."
        ),
        rows=(
            (200, (), ("Cache-Control",)),
            (400, ("pdf.notAPdf", "pdf.unreadable", *VERIFY_ADMISSION_ALLOWANCE), ()),
            (413, ("bad_document",), ()),
            (415, ("unsupported_media_type",), ()),
            (429, ("flood",), ("Retry-After",)),
            (503, _INSPECT_UNAVAILABLE, ("Retry-After",)),
        ),
        success={JSON: {"schema": {"$ref": "#/components/schemas/PdfVerifyReport"}}},
        request_content=_PDF_BODY,
        method="POST",
        body=True,
        success_model=PdfVerifyReport,
        replies={200: {"headers": _REPORT_CACHE}, **_JUDGING_503},
    ),
    "serverCertificate": OperationDoc(
        summary="Read the server's signing certificate",
        description=(
            "Answers the certificate chain of the server's signing key, leaf first, as PEM; 404 certificate.notFound "
            "while the server has no key. Public: no dependency of the application runs."
        ),
        rows=((200, (), ("Cache-Control",)), (404, ("certificate.notFound",), ())),
        success={PEM_MEDIA_TYPE: {"schema": {"type": "string"}}},
        raw=True,
        replies={200: {"headers": _PEM_CACHE}},
    ),
    "getTimestampCertificates": OperationDoc(
        summary="Read every timestamp certificate",
        description=(
            "Answers the current chain and then the retired certificates (those of keys no longer used, which still "
            f"verify older tokens), as PEM. {_TSA_WORDS}"
        ),
        rows=((200, (), _CERTIFICATE_HEADERS), (503, ("server.unavailable",), ())),
        success={PEM_MEDIA_TYPE: {"schema": {"type": "string"}}},
        raw=True,
    ),
}
"""The operations this binding serves, by operation id."""

_TSA_OPERATIONS: Final = frozenset({"issueTimestamp", "getTimestampCertificate", "getTimestampCertificates"})
_PROBLEM_503_NOTE: Final = " (application/problem+json when datum.web.api.problem_details is on)"
"""Appended in problem mode to the three timestamp routes' 503 and to every refusal of the PDF routes that write their
own bytes: their JSON refusals go out as problem details, documented under `application/json`."""

_DEFAULT_ROWS: Final[tuple[_Row, ...]] = (
    (500, ("internal",), ()),
    (503, _UNAVAILABLE, ("Retry-After",)),
)
"""The 500 and the 503 every route adds: the 503 documents Retry-After for `server.busy`, the one code that sends it."""
_BODY_ROWS: Final[tuple[_Row, ...]] = (
    (400, ("bad_document",), ()),
    (413, ("bad_document",), ()),
    (415, ("unsupported_media_type",), ()),
    (422, (), ()),
)
"""What a route that takes a raw body adds (the catalog's `defaultResponses` for `body`)."""
_POST_ROWS: Final[tuple[_Row, ...]] = ((429, ("flood",), ("Retry-After",)),)
"""What a POST adds (the catalog's `defaultResponses` for `post`)."""
_TSA_HEADERS: Final = {
    "Cache-Control": {
        "description": "Always no-store for a token and for a refusal; the certificates may be revalidated.",
        "schema": {"type": "string"},
    },
    "WWW-Authenticate": {
        "description": f"The challenge: {BASIC_CHALLENGE}.",
        "schema": {"type": "string"},
    },
}
_PERCENT: Final = "Percent-encoded UTF-8 (a space is %20, a plus %2B), so a client reads it with a URL decoder."
_PDF_HEADERS: Final = {
    "X-Page-Count": {"description": "The number of pages of the PDF.", "schema": {"type": "integer"}},
    "X-Signed-By": {
        "description": f"The signing certificate's common name (else its subject), when the file is signed. {_PERCENT}",
        "schema": {"type": "string"},
    },
    "X-Signature-Field": {
        "description": f"The signature field the file was signed into, when it is signed. {_PERCENT}",
        "schema": {"type": "string"},
    },
    "X-Datum-Layout": {
        "description": f"The id of the layout printed. {_PERCENT}",
        "schema": {"type": "string"},
    },
    "X-Datum-Pdf-Theme": {
        "description": f"The id of the PDF theme the form's binding suggests, when it suggests one. {_PERCENT}",
        "schema": {"type": "string"},
    },
}
_HEADERS: Final = {**_ETAG, **_RETRY_AFTER, **_BUILDER_HEADERS, **_TSA_HEADERS, **_PDF_HEADERS}


def _description(status: int, codes: tuple[str, ...]) -> str:
    if status == HTTPStatus.FORBIDDEN:
        return _REFUSED_BY_APPLICATION
    phrase = HTTPStatus(status).phrase
    text = f"{phrase} ({', '.join(codes)})." if codes else f"{phrase}."
    if status == HTTPStatus.SERVICE_UNAVAILABLE and "server.busy" in codes:
        text += " Only server.busy carries Retry-After."
    return text


def _entry(status: int, codes: tuple[str, ...], headers: tuple[str, ...], *, problem_details: bool) -> dict[str, Any]:
    entry: dict[str, Any] = {"description": _description(status, codes)}
    if headers:
        entry["headers"] = {name: _HEADERS[name] for name in headers}
    if status >= HTTPStatus.BAD_REQUEST:
        entry["model"] = ProblemDetail if problem_details else ErrorsBody
    return entry


def _success_status(doc: OperationDoc) -> int:
    """Return the operation's success status: its first row below 300 (200, or 201 for a create)."""
    return next(status for status, _, _ in doc.rows if status < HTTPStatus.MULTIPLE_CHOICES)


def responses_for(operation_id: str, *, problem_details: bool) -> dict[int | str, dict[str, Any]]:
    """Build the `responses=` dict of one operation: the catalog's statuses, the defaults, and the `default` entry."""
    doc = OPERATIONS[operation_id]
    responses: dict[int | str, dict[str, Any]] = {}
    given = {row[0] for row in doc.rows}
    defaults = (
        *(_BODY_ROWS if doc.takes_body else ()),
        *(_POST_ROWS if doc.takes_body and doc.method == "POST" else ()),
        *_DEFAULT_ROWS,
    )
    for status, codes, headers in (*doc.rows, *(row for row in defaults if row[0] not in given)):
        responses[status] = _entry(status, codes, headers, problem_details=problem_details)
    success = responses[_success_status(doc)]
    success["content"] = dict(doc.success)
    if doc.success_model is not None:
        success["model"] = doc.success_model
    for status, reply in doc.replies.items():
        entry = responses[status]
        if "content" in reply and not reply.get("errors", False):
            entry.pop("model", None)  # the given content replaces the JSON error body (the timestamp server's)
        entry["description"] = reply.get("description", entry["description"])
        if "content" in reply:
            entry["content"] = dict(reply["content"])
        if "headers" in reply:
            entry["headers"] = {**entry.get("headers", {}), **copy.deepcopy(dict(reply["headers"]))}
    if problem_details and operation_id in _TSA_OPERATIONS:
        responses[HTTPStatus.SERVICE_UNAVAILABLE]["description"] += _PROBLEM_503_NOTE
    if problem_details and operation_id in _PDF_RAW:
        for code, refusal in responses.items():
            if isinstance(code, int) and code >= HTTPStatus.BAD_REQUEST:
                refusal["description"] += _PROBLEM_503_NOTE
    responses["default"] = {
        "description": DEFAULT_RESPONSE_DESCRIPTION,
        "model": ProblemDetail if problem_details else ErrorsBody,
    }
    return responses


def operation_options(datum: Datum, operation_id: str) -> dict[str, Any]:
    """Return the keywords a route passes to `@router.get(...)`: id, words, responses, visibility, request body."""
    doc = OPERATIONS[operation_id]
    config = datum.config.web
    options: dict[str, Any] = {
        "operation_id": operation_id,
        "summary": doc.summary,
        "description": doc.description,
        "responses": responses_for(operation_id, problem_details=config.api.problem_details),
        "include_in_schema": config.openapi.enabled,
    }
    success = _success_status(doc)
    if success != HTTPStatus.OK:
        options["status_code"] = success  # the documented success; the route writes its own response
    if doc.raw:
        options["response_class"] = Response  # no media type of its own: the documented content is the whole truth
    elif config.api.problem_details:
        options["response_class"] = ProblemJSONResponse
    if doc.request is not None:
        options["openapi_extra"] = openapi_extra(dict(doc.request))
    if doc.request_content is not None:
        options["openapi_extra"] = {
            "requestBody": {"required": True, "content": copy.deepcopy(dict(doc.request_content))}
        }
    if doc.if_match:
        options.setdefault("openapi_extra", {})["parameters"] = [copy.deepcopy(IF_MATCH_PARAMETER)]
    return options


# ---- the management routes --------------------------------------------------------------------------------------
_HEALTH_BODY: Final = {
    JSON: {
        "schema": {
            "type": "object",
            "properties": {
                "status": {"type": "string", "enum": ["up", "down"]},
                "components": {"type": "object", "additionalProperties": {"type": "object"}},
            },
            "required": ["status", "components"],
        }
    }
}
_INFO_BODY: Final = {JSON: {"schema": {"type": "object", "additionalProperties": True}}}
_NO_BODY: Final = "No body."
MANAGEMENT: Final[Mapping[str, tuple[str, str, Mapping[int, tuple[str, Mapping[str, Any] | None]]]]] = {
    "datumLivez": (
        "Liveness",
        "Answers 200 with no body while the process answers. Public: it builds no report and asks no dependency.",
        {200: (_NO_BODY, None)},
    ),
    "datumReadyz": (
        "Readiness",
        (
            "Answers 200 with no body when the runtime is up and 503 until it probed. Reads the runtime alone, so "
            "another component's problem never fails it. Public."
        ),
        {200: (_NO_BODY, None), 503: (_NO_BODY, None)},
    ),
    "datumHealth": (
        "Health",
        "Answers the flat report `{status, components}`: 200 when every component is up, 503 when one is down.",
        {200: ("The report.", _HEALTH_BODY), 503: ("The report, with a component down.", _HEALTH_BODY)},
    ),
    "datumInfo": (
        "Information",
        (
            "Answers Datum's version, the ABIs, the build id, the engine and the capabilities in use, and under "
            "`settings` the sandbox's effective settings, each with its source (no host path)."
        ),
        {200: ("The information.", _INFO_BODY)},
    ),
    "datumRecheck": (
        "Recheck",
        (
            "Re-proves the sandbox (or builds a down runtime again) and answers the health report afterwards: 200 up, "
            "503 down."
        ),
        {200: ("The report.", _HEALTH_BODY), 503: ("The report, with a component down.", _HEALTH_BODY)},
    ),
}
"""The management routes by operation id: summary, description, and the responses (description, content)."""


def management_options(datum: Datum, operation_id: str) -> dict[str, Any]:
    """Return the keywords a management route passes to `@router.get(...)`; its ids are outside the catalog's."""
    summary, description, answers = MANAGEMENT[operation_id]
    responses: dict[int | str, dict[str, Any]] = {}
    for status, (words, content) in answers.items():
        responses[status] = {"description": words, **({"content": dict(content)} if content is not None else {})}
    return {
        "operation_id": operation_id,
        "summary": summary,
        "description": description,
        "responses": responses,
        "include_in_schema": datum.config.web.openapi.enabled,
    }


# ---- group documents ---------------------------------------------------------------------------------------------
def add_group_document(
    router: APIRouter,
    datum: Datum,
    *,
    prefix: str,
    factory: str,
    privileged: bool = False,
    dependencies: Sequence[params.Depends] = (),
) -> None:
    """Add `GET {prefix}/openapi/{factory}.json` to `router` when `datum.web.openapi.group_documents` is on.

    The document is `get_openapi(routes=...)` over the routes `router` holds, which it owns (its tag list holds only
    the tags those routes use); the route is hidden from the application's schema. Its paths are the factory's own
    `prefix` and ignore a prefix the application gives `include_router`. The factory runs before it knows the
    application, so the route answers the application's own 404 when `request.app.openapi_url` is `None`. A router
    with no route has no document. A `privileged` factory's document (builder, authoring) describes routes the
    application guards, so it answers `Cache-Control: no-store`; a public one is unchanged. `dependencies` are the
    document route's own, for a router whose dependencies sit on its routes rather than on the router (the PDF
    router: its document describes the printing routes the application guards and the two public ones, so the
    document route carries the guarded list).
    """
    web = datum.config.web
    if not web.openapi.group_documents or not router.routes:
        return
    documented = list(router.routes)
    used = {tag for route in documented for tag in getattr(route, "tags", None) or ()}
    tags = [tag for tag in openapi_tags(web.openapi.tag_prefix) if tag["name"] in used]

    @router.get(
        f"{prefix}/openapi/{factory}.json",
        include_in_schema=False,
        operation_id=f"get{factory.title()}OpenApiDocument",
        dependencies=list(dependencies),
    )
    async def group_document(request: Request) -> Response:
        if request.app.openapi_url is None:
            raise HTTPException(status_code=HTTPStatus.NOT_FOUND)
        document = get_openapi(
            title=f"Datum {factory}",
            version=core_version(),
            openapi_version=request.app.openapi_version,
            routes=documented,
            tags=tags,
        )
        return JSONResponse(document, headers={"Cache-Control": NO_STORE} if privileged else None)
