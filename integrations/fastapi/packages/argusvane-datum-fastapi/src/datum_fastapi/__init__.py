"""Datum for FastAPI: routers, settings and OpenAPI over argusvane-datum-core."""

from datum_fastapi import routers
from datum_fastapi.access import access_errors
from datum_fastapi.body import bounded_body, read_bounded_body
from datum_fastapi.datum import Datum, accept_language, preferred_language
from datum_fastapi.openapi import DATUM_OPENAPI_TAGS, openapi_tags
from datum_fastapi.routing import AnswerError, DatumRoute
from datum_fastapi.settings import DatumSettings

__all__: list[str] = [
    "DATUM_OPENAPI_TAGS",
    "AnswerError",
    "Datum",
    "DatumRoute",
    "DatumSettings",
    "accept_language",
    "access_errors",
    "bounded_body",
    "openapi_tags",
    "preferred_language",
    "read_bounded_body",
    "routers",
]
