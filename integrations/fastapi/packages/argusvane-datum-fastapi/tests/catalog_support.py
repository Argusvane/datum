"""The shared endpoint catalog, as the route tests read it."""

import json
from functools import cache
from pathlib import Path
from typing import Any, cast

CATALOG_PATH = Path(__file__).resolve().parents[4] / "shared" / "endpoint-catalog.json"
PRESENT = (
    "getFormDefinition",
    "getFormTranslations",
    "getDataSourceItems",
    "submitSubmission",
    "validateSubmission",
    "testSubmission",
    "inspectDefinition",
    "createForm",
    "saveForm",
    "saveFormTranslations",
    "issueTimestamp",
    "getTimestampCertificate",
    "getTimestampCertificates",
    "renderPdf",
    "fillPdf",
    "signPdf",
    "verifyPdf",
    "serverCertificate",
)
"""The catalog operations the binding serves: the forms router's three, four for submissions and authoring, three for
the builder, the timestamp
server's three and the PDF router's five (18)."""


@cache
def catalog() -> dict[str, Any]:
    return cast("dict[str, Any]", json.loads(CATALOG_PATH.read_text(encoding="utf-8")))


def endpoint(operation_id: str) -> dict[str, Any]:
    (found,) = [e for e in catalog()["endpoints"] if e["operationId"] == operation_id]
    return cast("dict[str, Any]", found)


def full_path(row: dict[str, Any]) -> str:
    return str(catalog()["bases"][row["base"]]) + str(row["path"])


def default_statuses(row: dict[str, Any]) -> set[int]:
    """The statuses the catalog's default responses add to a route, by whether it takes a body."""
    found: set[int] = set()
    for item in catalog()["defaultResponses"]:
        if (
            item["when"] == "always"
            or (item["when"] == "body" and row["body"])
            or (item["when"] == "post" and row["method"] == "POST")
        ):
            found.add(int(item["status"]))
    return found
