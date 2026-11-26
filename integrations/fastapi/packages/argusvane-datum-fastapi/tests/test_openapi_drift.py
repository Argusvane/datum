"""The OpenAPI drift test for the routes present: eighteen of the catalog's 24.

The forms router serves three; `submitSubmission` and `validateSubmission` (`routers.submissions`) and `testSubmission`
and `inspectDefinition` (`routers.authoring`) add four; `createForm`, `saveForm` and `saveFormTranslations`
(`routers.builder`) add three; `issueTimestamp`, `getTimestampCertificate` and `getTimestampCertificates`
(`routers.tsa`, with what only the TSA documents: raw bytes in and out under the timestamp
media types, plain-text refusals and `Retry-After` on 429 and 503) add three; `renderPdf`, `fillPdf`, `signPdf`,
`verifyPdf` and `serverCertificate` (`routers.pdf`: raw JSON bodies answered by a binary PDF with `X-Page-Count`, a raw
`application/pdf` body answered by the `PdfVerifyReport` schema with no 403, and PEM or 404 `certificate.notFound`).
Four response headers the catalog does not list but the kit reads are sent on the 200 of the three printing routes and
documented with them: `X-Signed-By`, `X-Signature-Field`, `X-Datum-Layout` and `X-Datum-Pdf-Theme`.
That allowance is the NAMED,
exact set below; the gap in the catalog is an owner item (hosts README), and any other header beyond the catalog's on a
PDF route fails here. The author's copy (`GET ...?public=false`) is a hidden route of the builder factory and in no
document. The management routes are documented under their own tag; they are not catalog operations and stay out of
this count."""

import json
from typing import Any

import pdf_fakes
import pytest
from catalog_support import PRESENT, catalog, default_statuses, endpoint, full_path
from datum_fakes import StubRepository, StubRuntime, StubSandbox, config, definition, runtime_of, sandbox_of
from fastapi import FastAPI
from fastapi.testclient import TestClient
from tsa_fakes import QUERY_TYPE, REPLY_TYPE, build_app, make_datum, tsa_sections
from tsa_fakes import config as tsa_config

from datum_core import DatumConfig
from datum_core.testing.tsa_pki import TsaPki
from datum_fastapi import DATUM_OPENAPI_TAGS, Datum, routers

SUBMISSION_ENDPOINTS = {"submissions": True, "validate": True, "test": True, "inspect": True}
BODY_OPERATIONS = ("submitSubmission", "validateSubmission", "testSubmission", "inspectDefinition")
BUILDER_OPERATIONS = ("createForm", "saveForm", "saveFormTranslations")
TSA_OPERATIONS = ("issueTimestamp", "getTimestampCertificate", "getTimestampCertificates")
PDF_OPERATIONS = ("renderPdf", "fillPdf", "signPdf", "verifyPdf", "serverCertificate")
PDF_ENDPOINTS = {"pdf": True, "fill": True, "sign": True, "verify": True, "certificate": True}
PRINTING = ("renderPdf", "fillPdf", "signPdf")
HEADER_ALLOWANCE = {"X-Signed-By", "X-Signature-Field", "X-Datum-Layout", "X-Datum-Pdf-Theme"}
"""The headers beyond the catalog's `X-Page-Count` that the three printing routes send, and nothing else."""
ADMISSION_ALLOWANCE = {"verifyPdf": {"bad_request"}}
"""The one code beyond the catalog's on a PDF operation's 400: verify answers a malformed `Content-Length` as
`bad_request` (render, fill and sign list it; the catalog's verify row does not)."""
PEM_MEDIA_TYPE = "application/x-pem-file"


def document(cfg: DatumConfig | None = None, **app_kwargs: Any) -> dict[str, Any]:
    datum = Datum(
        config=cfg
        or config(
            builder={"enabled": True},
            web={
                "assets": {"enabled": True},
                "openapi": {"group_documents": True},
                "api": {"endpoints": {**SUBMISSION_ENDPOINTS, **PDF_ENDPOINTS}},
            },
            **tsa_sections(),
        ),
        runtime=runtime_of(StubRuntime()),
        sandbox=sandbox_of(StubSandbox()),
        form_repository=StubRepository(definition("contact")),
    )
    app = FastAPI(**app_kwargs)
    app.include_router(routers.forms(datum))
    app.include_router(routers.assets(datum))
    app.include_router(routers.submissions(datum))
    app.include_router(routers.authoring(datum, dependencies=[]))
    app.include_router(routers.builder(datum, dependencies=[]))
    app.include_router(routers.tsa(datum))
    app.include_router(routers.pdf(datum, dependencies=[]))
    return app.openapi()


def pdf_document(cfg: DatumConfig | None = None, **app_kwargs: Any) -> dict[str, Any]:
    """The document of an application holding the PDF router alone (the PDF fakes' `Datum`)."""
    datum, _ = pdf_fakes.make_datum(cfg)
    app = FastAPI(**app_kwargs)
    app.include_router(routers.pdf(datum, dependencies=[]))
    return app.openapi()


def operations(doc: dict[str, Any]) -> dict[str, tuple[str, str, dict[str, Any]]]:
    return {
        operation["operationId"]: (method.upper(), path, operation)
        for path, item in doc["paths"].items()
        for method, operation in item.items()
    }


@pytest.fixture(scope="module")
def doc() -> dict[str, Any]:
    return document()


def test_the_document_holds_exactly_the_present_catalog_routes_and_nothing_hidden(doc: dict[str, Any]) -> None:
    found = {op: (method, path) for op, (method, path, _) in operations(doc).items()}
    expected = {op: (endpoint(op)["method"], full_path(endpoint(op))) for op in PRESENT}
    assert found == expected


def test_assets_host_json_the_glue_and_group_documents_are_absent(doc: dict[str, Any]) -> None:
    text = json.dumps(doc["paths"])
    assert "/datum/assets" not in text
    hidden_documents = (
        "openapi/forms.json",
        "openapi/submissions.json",
        "openapi/authoring.json",
        "openapi/builder.json",
        "openapi/tsa.json",
        "openapi/pdf.json",
    )
    for hidden in hidden_documents:
        assert hidden not in text
    assert "host.json" not in text


@pytest.mark.parametrize("operation_id", PRESENT)
def test_each_route_carries_the_catalogs_tag_summary_and_description(doc: dict[str, Any], operation_id: str) -> None:
    operation = operations(doc)[operation_id][2]
    assert operation["tags"] == [endpoint(operation_id)["tag"]]
    assert operation["summary"]
    assert operation["description"]


@pytest.mark.parametrize("operation_id", PRESENT)
def test_each_route_documents_the_catalogs_statuses_and_only_those_plus_the_defaults(
    doc: dict[str, Any], operation_id: str
) -> None:
    row = endpoint(operation_id)
    responses = operations(doc)[operation_id][2]["responses"]
    # Every operation documents a `default` response, which keeps FastAPI from adding its own 422.
    assert "default" in responses
    documented = {int(status) for status in responses if status != "default"}
    listed = {item["status"] for item in row["statuses"]}
    assert listed <= documented
    assert documented <= listed | default_statuses(row)


@pytest.mark.parametrize("operation_id", PRESENT)
def test_each_error_response_names_its_codes_and_the_403_is_described_as_the_applications_security(
    doc: dict[str, Any], operation_id: str
) -> None:
    row = endpoint(operation_id)
    responses = operations(doc)[operation_id][2]["responses"]
    for item in row["statuses"]:
        description = responses[str(item["status"])]["description"]
        for code in item["codes"]:
            assert code in description, (item["status"], code)
        if item["status"] == 403:
            assert "application" in description.lower()


@pytest.mark.parametrize("operation_id", PRESENT)
def test_each_response_documents_the_headers_the_catalog_lists(doc: dict[str, Any], operation_id: str) -> None:
    row = endpoint(operation_id)
    responses = operations(doc)[operation_id][2]["responses"]
    for item in row["statuses"]:
        documented = set(responses[str(item["status"])].get("headers", {}))
        assert set(item["headers"]) <= documented, (item["status"], item["headers"], documented)


def test_the_retry_after_header_is_an_integer_with_a_minimum_of_zero(doc: dict[str, Any]) -> None:
    header = operations(doc)["getDataSourceItems"][2]["responses"]["503"]["headers"]["Retry-After"]
    assert header["schema"]["type"] == "integer"
    assert header["schema"]["minimum"] == 0


def test_the_error_responses_use_the_errors_body_in_the_default_mode(doc: dict[str, Any]) -> None:
    reply = operations(doc)["getFormDefinition"][2]["responses"]["404"]["content"]
    assert list(reply) == ["application/json"]
    assert reply["application/json"]["schema"]["$ref"].endswith("/ErrorsBody")
    assert {"ErrorsBody", "ErrorItem"} <= set(doc["components"]["schemas"])
    assert "ProblemDetail" not in doc["components"]["schemas"]


def test_the_error_responses_use_problem_details_in_the_problem_mode() -> None:
    doc = document(config(web={"api": {"problem_details": True}}))
    reply = operations(doc)["getFormDefinition"][2]["responses"]["404"]["content"]
    assert list(reply) == ["application/problem+json"]
    assert reply["application/problem+json"]["schema"]["$ref"].endswith("/ProblemDetail")
    assert "ProblemDetail" in doc["components"]["schemas"]
    assert "ErrorsBody" not in doc["components"]["schemas"]  # one shape per document


def test_the_timestamp_routes_503_names_the_problem_media_type_only_in_the_problem_mode() -> None:
    note = "application/problem+json when datum.web.api.problem_details is on"
    ids = ("issueTimestamp", "getTimestampCertificate", "getTimestampCertificates")
    on = operations(document(config(web={"api": {"problem_details": True}}, **tsa_sections())))
    off = operations(document(config(**tsa_sections())))
    for operation_id in ids:
        assert note in on[operation_id][2]["responses"]["503"]["description"]
        assert note not in off[operation_id][2]["responses"]["503"]["description"]


def test_the_defaults_every_route_gets_are_the_500_and_the_503(doc: dict[str, Any]) -> None:
    for operation_id in PRESENT:
        responses = operations(doc)[operation_id][2]["responses"]
        assert "500" in responses
        assert "503" in responses
        if operation_id in ("getTimestampCertificate", "getTimestampCertificates"):
            assert "headers" not in responses["503"]  # only the started guard's server.unavailable: no Retry-After
        else:
            assert "Retry-After" in responses["503"]["headers"]  # for server.busy, the one 503 that carries it
    sources = {int(s) for s in operations(doc)["getDataSourceItems"][2]["responses"] if s != "default"}
    assert not sources & {413, 415, 429}  # these are for routes that take a body


def test_the_parameters_the_routes_take_are_documented(doc: dict[str, Any]) -> None:
    definition_params = {p["name"]: p for p in operations(doc)["getFormDefinition"][2]["parameters"]}
    assert {name: p["in"] for name, p in definition_params.items()} == {"key": "path"}  # no `public` parameter
    sources = {p["name"]: p["in"] for p in operations(doc)["getDataSourceItems"][2]["parameters"]}
    assert sources == {"id": "path", "locale": "query", "form": "query"}


def test_the_dry_run_reply_is_the_flat_report_every_member_described(doc: dict[str, Any]) -> None:
    schema = operations(doc)["testSubmission"][2]["responses"]["200"]["content"]["application/json"]["schema"]
    members = [
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
    ]
    assert list(schema["properties"]) == members
    assert schema["required"] == members
    assert all(schema["properties"][name]["description"] for name in members)
    assert "accepted" not in schema["properties"]
    assert "report" not in schema["properties"]
    finding = schema["properties"]["errors"]["items"]
    assert list(finding["properties"]) == ["field", "code", "message", "severity", "stage", "source"]
    assert all(finding["properties"][name]["description"] for name in finding["properties"])
    assert schema["properties"]["sandbox"]["required"] == ["elapsedMs", "rules", "unknownFields", "logLevel"]


def test_the_dry_run_reply_names_its_four_always_present_id_lists(doc: dict[str, Any]) -> None:
    schema = operations(doc)["testSubmission"][2]["responses"]["200"]["content"]["application/json"]["schema"]
    lists = ("visibilitySkipped", "clientDerived", "clockDependent", "serverRules")
    for name in lists:
        assert schema["properties"][name]["type"] == "array"
        assert schema["properties"][name]["items"] == {"type": "string"}
        assert schema["properties"][name]["description"]
    assert set(lists) <= set(schema["required"])


def test_tag_descriptions_are_exported_for_the_application_to_pass_on() -> None:
    names = {tag["name"] for tag in DATUM_OPENAPI_TAGS}
    assert {endpoint(op)["tag"] for op in PRESENT} <= names
    assert {e["tag"] for e in catalog()["endpoints"]} <= names
    assert "datum-management" in names
    assert all(tag["description"] for tag in DATUM_OPENAPI_TAGS)
    doc = document(openapi_tags=DATUM_OPENAPI_TAGS)
    assert {tag["name"] for tag in doc["tags"]} == names


def test_the_tag_prefix_setting_renames_the_tags() -> None:
    doc = document(config(web={"openapi": {"tag_prefix": "acme-"}}))
    assert operations(doc)["getFormDefinition"][2]["tags"] == ["acme-forms"]


def test_the_openapi_switch_off_hides_the_routes_from_the_document_but_keeps_them_working() -> None:
    cfg = config(web={"openapi": {"enabled": False}})
    datum = Datum(
        config=cfg,
        runtime=runtime_of(StubRuntime()),
        sandbox=sandbox_of(StubSandbox()),
        form_repository=StubRepository(definition("contact")),
    )
    app = FastAPI()
    app.include_router(routers.forms(datum))
    assert app.openapi()["paths"] == {}
    with TestClient(app) as client:
        assert client.get("/api/forms/contact/definition").status_code == 200


def test_the_catalog_is_still_twenty_four_routes_of_which_eighteen_are_served() -> None:
    assert len(catalog()["endpoints"]) == 24
    assert len(PRESENT) == 18
    assert len(set(PRESENT)) == 3 + 4 + 3 + 3 + 5
    assert [e["operationId"] for e in catalog()["endpoints"] if e["capability"] == "timestamp"] == list(TSA_OPERATIONS)
    assert [e["operationId"] for e in catalog()["endpoints"] if e["capability"] == "pdf"] == list(PDF_OPERATIONS)
    assert set(PDF_OPERATIONS) <= set(PRESENT)


def test_no_pdf_route_documents_a_header_beyond_the_catalogs_but_the_named_allowance(doc: dict[str, Any]) -> None:
    """Held on the whole document too: the allowance is exact, and only the printing routes' 200 carries it."""
    for operation_id in PDF_OPERATIONS:
        listed = {name for item in endpoint(operation_id)["statuses"] for name in item["headers"]}
        for status, response in operations(doc)[operation_id][2]["responses"].items():
            extra = set(response.get("headers", {})) - listed - {"Retry-After", "Cache-Control"}
            wanted = HEADER_ALLOWANCE if status == "200" and operation_id in PRINTING else set()
            assert extra == wanted, (operation_id, status, extra)


@pytest.mark.parametrize("operation_id", BODY_OPERATIONS)
def test_each_raw_body_route_documents_a_json_request_body_through_openapi_extra(
    doc: dict[str, Any], operation_id: str
) -> None:
    body = operations(doc)[operation_id][2]["requestBody"]
    assert "application/json" in body["content"]
    assert body["required"] is True


@pytest.mark.parametrize("operation_id", BODY_OPERATIONS)
def test_each_body_route_documents_the_defaults_for_a_body_and_for_a_post(
    doc: dict[str, Any], operation_id: str
) -> None:
    responses = operations(doc)[operation_id][2]["responses"]
    assert {"400", "413", "415", "422", "429", "500", "503"} <= set(responses)
    assert "Retry-After" in responses["429"]["headers"]


def test_the_builder_factory_carries_the_ui_tag_and_the_author_copy_is_in_no_document(doc: dict[str, Any]) -> None:
    assert [operations(doc)[op][2]["tags"] for op in BUILDER_OPERATIONS] == [["datum-ui"]] * 3
    assert {endpoint(op)["tag"] for op in BUILDER_OPERATIONS} == {"datum-ui"}
    definition_path = doc["paths"]["/api/forms/{key}/definition"]
    assert list(definition_path) == ["get"]
    assert definition_path["get"]["operationId"] == "getFormDefinition"
    assert "public" not in [p["name"] for p in definition_path["get"]["parameters"]]


@pytest.mark.parametrize("operation_id", BUILDER_OPERATIONS)
def test_each_builder_route_documents_a_json_request_body_and_the_defaults_for_a_body(
    doc: dict[str, Any], operation_id: str
) -> None:
    operation = operations(doc)[operation_id][2]
    assert operation["requestBody"]["required"] is True
    assert "application/json" in operation["requestBody"]["content"]
    assert {"400", "413", "415", "422", "500", "503"} <= set(operation["responses"])
    assert {str(status) for status in default_statuses(endpoint(operation_id))} <= set(operation["responses"])


def test_the_if_match_parameter_is_on_the_two_writes_that_replace_a_version_and_not_on_the_create(
    doc: dict[str, Any],
) -> None:
    parameter = next(item for item in catalog()["parameters"] if item["component"] == "IfMatch")
    assert parameter["name"] == "If-Match"
    for operation_id in ("saveForm", "saveFormTranslations"):
        found = {p["name"]: p for p in operations(doc)[operation_id][2]["parameters"]}
        assert found["If-Match"]["in"] == "header"
        assert found["If-Match"]["schema"]["type"] == "string"
        assert found["If-Match"]["description"] == parameter["description"]
        assert found["key"]["in"] == "path"
    created = {p["name"] for p in operations(doc)["createForm"][2].get("parameters", [])}
    assert "If-Match" not in created


def test_the_builder_headers_are_documented_where_the_catalog_puts_them(doc: dict[str, Any]) -> None:
    save = operations(doc)["saveForm"][2]["responses"]
    create = operations(doc)["createForm"][2]["responses"]
    translations = operations(doc)["saveFormTranslations"][2]["responses"]
    assert {"ETag", "X-Datum-Removed-Locales"} <= set(save["200"]["headers"])
    assert "ETag" in save["409"]["headers"]
    assert {"ETag", "Location"} <= set(create["201"]["headers"])
    assert "ETag" in translations["200"]["headers"]
    assert "ETag" in translations["409"]["headers"]
    assert "ETag" not in create["409"].get("headers", {})  # form.exists carries none


def test_the_two_factories_share_the_submissions_tag_and_the_management_routes_stay_out_of_the_count(
    doc: dict[str, Any],
) -> None:
    tags = {op: operations(doc)[op][2]["tags"] for op in BODY_OPERATIONS}
    assert all(value == ["datum-submissions"] for value in tags.values())
    datum = Datum(
        config=config(),
        runtime=runtime_of(StubRuntime()),
        sandbox=sandbox_of(StubSandbox()),
        form_repository=StubRepository(definition("contact")),
    )
    app = FastAPI()
    app.include_router(routers.management(datum, dependencies=[]))
    ids = {op["operationId"] for item in app.openapi()["paths"].values() for op in item.values()}
    assert ids
    assert ids.isdisjoint({entry["operationId"] for entry in catalog()["endpoints"]})


# -- the timestamp server's routes: what only they document ------------------------------------------------------------
def test_retry_after_is_documented_on_the_timestamp_429_and_503_as_a_non_negative_integer(doc: dict[str, Any]) -> None:
    responses = operations(doc)["issueTimestamp"][2]["responses"]
    for status in ("429", "503"):
        header = responses[status]["headers"]["Retry-After"]
        assert header["schema"]["type"] == "integer"
        assert header["schema"]["minimum"] == 0


def test_issue_timestamp_takes_raw_bytes_in_the_query_media_types_and_answers_raw_bytes(doc: dict[str, Any]) -> None:
    operation = operations(doc)["issueTimestamp"][2]
    body = operation["requestBody"]
    assert body["required"] is True
    assert set(body["content"]) == {QUERY_TYPE, "application/timestamp-request"}
    for media in body["content"].values():
        assert media["schema"] == {"type": "string", "format": "binary"}
    ok = operation["responses"]["200"]["content"]
    assert list(ok) == [REPLY_TYPE]
    assert ok[REPLY_TYPE]["schema"] == {"type": "string", "format": "binary"}
    assert "no-store" in operation["responses"]["200"]["headers"]["Cache-Control"]["description"]


def test_the_der_rejections_are_documented_as_timestamp_replies(doc: dict[str, Any]) -> None:
    responses = operations(doc)["issueTimestamp"][2]["responses"]
    for status in ("400", "503"):
        assert REPLY_TYPE in responses[status]["content"], status


def test_the_plain_text_refusals_are_documented_as_text_never_the_json_error_body(doc: dict[str, Any]) -> None:
    responses = operations(doc)["issueTimestamp"][2]["responses"]
    for status in ("401", "403", "413", "415", "429"):
        content = responses[status].get("content", {})
        assert "application/json" not in content, status
        assert "text/plain" in content, status
    text = json.dumps(responses["401"])
    assert "WWW-Authenticate" in text
    assert "timestamp server" in text


def test_the_timestamp_503_keeps_the_json_refusal_of_the_started_guard_beside_the_der_rejection(
    doc: dict[str, Any],
) -> None:
    content = operations(doc)["issueTimestamp"][2]["responses"]["503"]["content"]
    assert set(content) == {REPLY_TYPE, "application/json"}


def test_the_403_describes_the_session_cookie_rule(doc: dict[str, Any]) -> None:
    assert "cookie" in operations(doc)["issueTimestamp"][2]["responses"]["403"]["description"].lower()


def test_the_certificate_routes_document_pem_and_the_der_format(doc: dict[str, Any]) -> None:
    one = operations(doc)["getTimestampCertificate"][2]
    parameters = {p["name"]: p for p in one.get("parameters", [])}
    assert parameters["format"]["in"] == "query"
    assert parameters["format"]["required"] is False
    media = set(one["responses"]["200"]["content"])
    assert "application/pkix-cert" in media
    assert media - {"application/pkix-cert"}, "the PEM chain has a media type too"
    many = operations(doc)["getTimestampCertificates"][2]
    assert set(many["responses"]["200"]["content"]) - {"application/pkix-cert"}
    assert "application/json" not in one["responses"]["200"]["content"]


def test_the_timestamp_group_document_holds_only_the_three_tsa_routes(tsa_pki: TsaPki) -> None:
    datum, _ = make_datum(tsa_pki.ec, tsa_config(web={"openapi": {"group_documents": True}}))
    with TestClient(build_app(datum)) as running:
        reply = running.get("/tsa/openapi/tsa.json")
    assert reply.status_code == 200
    assert set(reply.json()["paths"]) == {"/tsa", "/tsa/certificate", "/tsa/certificates"}


def test_without_group_documents_no_timestamp_group_document_route_exists(tsa_pki: TsaPki) -> None:
    datum, _ = make_datum(tsa_pki.ec)
    paths = {getattr(route, "path", "") for route in build_app(datum).routes}
    assert not any(path.endswith("tsa.json") for path in paths)


def test_the_openapi_switch_off_hides_the_timestamp_routes_from_the_document_but_keeps_them_working(
    tsa_pki: TsaPki,
) -> None:
    datum, _ = make_datum(tsa_pki.ec, tsa_config(web={"openapi": {"enabled": False}}))
    app = build_app(datum)
    assert app.openapi()["paths"] == {}
    with TestClient(app) as running:
        assert running.get("/tsa/certificate").status_code == 200


def test_the_tag_prefix_setting_renames_the_tsa_tag(tsa_pki: TsaPki) -> None:
    datum, _ = make_datum(tsa_pki.ec, tsa_config(web={"openapi": {"tag_prefix": "acme-"}}))
    assert operations(build_app(datum).openapi())["issueTimestamp"][2]["tags"] == ["acme-tsa"]


def test_the_timestamp_refusals_document_cache_control_no_store(doc: dict[str, Any]) -> None:
    responses = operations(doc)["issueTimestamp"][2]["responses"]
    for status in ("400", "401", "403", "413", "415", "429", "503"):
        assert "Cache-Control" in responses[status]["headers"], status


# -- the PDF routes: what only they document ---------------------------------------------------------------------------
@pytest.fixture(scope="module")
def pdf_doc() -> dict[str, Any]:
    return pdf_document(pdf_fakes.config(web={"openapi": {"group_documents": True}}))


def test_the_document_holds_exactly_the_five_pdf_routes(pdf_doc: dict[str, Any]) -> None:
    found = {op: (method, path) for op, (method, path, _) in operations(pdf_doc).items()}
    expected = {op: (endpoint(op)["method"], full_path(endpoint(op))) for op in PDF_OPERATIONS}
    assert found == expected


def test_pdf_verify_and_the_certificate_document_no_403_because_they_are_public(pdf_doc: dict[str, Any]) -> None:
    for operation_id in ("verifyPdf", "serverCertificate"):
        assert "403" not in operations(pdf_doc)[operation_id][2]["responses"], operation_id
    for operation_id in PRINTING:
        assert "403" in operations(pdf_doc)[operation_id][2]["responses"], operation_id


# -- the named allowance -----------------------------------------------------------------------------------------------
def test_pdf_the_three_extra_headers_are_documented_on_the_200_of_the_printing_routes_and_nowhere_else(
    pdf_doc: dict[str, Any],
) -> None:
    for operation_id in PDF_OPERATIONS:
        responses = operations(pdf_doc)[operation_id][2]["responses"]
        catalog_headers = {name for item in endpoint(operation_id)["statuses"] for name in item["headers"]}
        for status, response in responses.items():
            documented = set(response.get("headers", {}))
            extra = documented - catalog_headers - {"Retry-After", "Cache-Control"}
            expected_status = status == "200" and operation_id in PRINTING
            assert extra == (HEADER_ALLOWANCE if expected_status else set()), (operation_id, status, extra)


def test_pdf_the_printing_routes_500_names_signature_and_every_other_routes_500_names_internal_only(
    doc: dict[str, Any],
) -> None:
    """A seal not made is the 500 `signature` on the three printing routes; the catalog's 500 lists `internal`."""
    assert set(PRINTING) <= set(operations(doc))
    for operation_id, (_method, _path, operation) in operations(doc).items():
        description = operation["responses"]["500"]["description"]
        assert "internal" in description, operation_id
        assert ("signature" in description) == (operation_id in PRINTING), operation_id


def test_pdf_the_allowance_headers_are_strings_and_say_they_are_percent_encoded(pdf_doc: dict[str, Any]) -> None:
    headers = operations(pdf_doc)["renderPdf"][2]["responses"]["200"]["headers"]
    for name in HEADER_ALLOWANCE:
        assert headers[name]["schema"]["type"] == "string"
        assert "percent" in headers[name]["description"].lower()
    assert headers["X-Page-Count"]["schema"]["type"] == "integer"


def test_pdf_the_catalog_lists_only_the_page_count_header_so_the_allowance_is_the_whole_gap() -> None:
    names = {
        name
        for item in catalog()["endpoints"]
        if item["capability"] == "pdf"
        for status in item["statuses"]
        for name in status["headers"]
    }
    assert names == {"X-Page-Count", "Retry-After"}


def test_pdf_retry_after_is_an_integer_with_a_minimum_of_zero_on_every_429_and_503(pdf_doc: dict[str, Any]) -> None:
    for operation_id in ("renderPdf", "verifyPdf"):
        for status in ("429", "503"):
            header = operations(pdf_doc)[operation_id][2]["responses"][status]["headers"]["Retry-After"]
            assert header["schema"]["type"] == "integer"
            assert header["schema"]["minimum"] == 0


# -- bodies and media types --------------------------------------------------------------------------------------------
@pytest.mark.parametrize("operation_id", PRINTING)
def test_pdf_each_printing_route_documents_a_json_request_body_with_the_document_and_an_optional_layout_id(
    pdf_doc: dict[str, Any], operation_id: str
) -> None:
    body = operations(pdf_doc)[operation_id][2]["requestBody"]
    assert body["required"] is True
    assert list(body["content"]) == ["application/json"]
    schema = json.dumps(body["content"]["application/json"]["schema"])
    assert "document" in schema
    assert "layoutId" in schema


@pytest.mark.parametrize("operation_id", PRINTING)
def test_each_printing_route_answers_a_binary_pdf(pdf_doc: dict[str, Any], operation_id: str) -> None:
    ok = operations(pdf_doc)[operation_id][2]["responses"]["200"]["content"]
    assert list(ok) == [pdf_fakes.PDF_MEDIA]
    assert ok[pdf_fakes.PDF_MEDIA]["schema"] == {"type": "string", "format": "binary"}


def test_verify_takes_a_raw_pdf_body_and_never_a_json_one(pdf_doc: dict[str, Any]) -> None:
    body = operations(pdf_doc)["verifyPdf"][2]["requestBody"]
    assert body["required"] is True
    assert list(body["content"]) == [pdf_fakes.PDF_MEDIA]
    assert body["content"][pdf_fakes.PDF_MEDIA]["schema"] == {"type": "string", "format": "binary"}


def test_pdf_verify_answers_the_report_schema_of_the_catalog(pdf_doc: dict[str, Any]) -> None:
    ok = operations(pdf_doc)["verifyPdf"][2]["responses"]["200"]["content"]
    assert list(ok) == ["application/json"]
    assert ok["application/json"]["schema"]["$ref"].endswith("/PdfVerifyReport")
    schemas = pdf_doc["components"]["schemas"]
    wanted = {item["name"]: item for item in catalog()["schemas"] if item["name"].startswith("Pdf")}
    assert set(wanted) == {"PdfTrustPolicySummary", "PdfSignatureVerdict", "PdfVerifyReport"}
    for name, spec in wanted.items():
        assert name in schemas, name
        assert set(schemas[name]["required"]) == set(spec["required"]), name
        assert {prop["name"] for prop in spec["properties"]} <= set(schemas[name]["properties"]), name


def test_pdf_the_certificate_route_answers_pem_text_and_takes_no_body(pdf_doc: dict[str, Any]) -> None:
    operation = operations(pdf_doc)["serverCertificate"][2]
    assert "requestBody" not in operation
    assert PEM_MEDIA_TYPE in operation["responses"]["200"]["content"]
    assert "application/json" not in operation["responses"]["200"]["content"]
    assert "application/json" in operation["responses"]["404"]["content"]


@pytest.mark.parametrize("operation_id", ["renderPdf", "fillPdf", "signPdf", "verifyPdf"])
def test_pdf_each_body_route_documents_the_defaults_for_a_body_and_for_a_post(
    pdf_doc: dict[str, Any], operation_id: str
) -> None:
    responses = operations(pdf_doc)[operation_id][2]["responses"]
    assert {"400", "413", "415", "422", "429", "500", "503"} <= set(responses)


def test_pdf_the_fill_route_alone_documents_layout_not_template(pdf_doc: dict[str, Any]) -> None:
    assert "layout.notTemplate" in operations(pdf_doc)["fillPdf"][2]["responses"]["400"]["description"]
    for operation_id in ("renderPdf", "signPdf"):
        assert "layout.notTemplate" not in operations(pdf_doc)[operation_id][2]["responses"]["400"]["description"]


# -- modes and groups --------------------------------------------------------------------------------------------------
def test_pdf_the_error_responses_use_the_errors_body_in_the_default_mode_and_problem_details_in_the_problem_mode(
    pdf_doc: dict[str, Any],
) -> None:
    reply = operations(pdf_doc)["verifyPdf"][2]["responses"]["400"]["content"]
    assert list(reply) == ["application/json"]
    assert reply["application/json"]["schema"]["$ref"].endswith("/ErrorsBody")
    problem = operations(pdf_document(pdf_fakes.config(web={"api": {"problem_details": True}})))["verifyPdf"][2][
        "responses"
    ]["400"]["content"]
    assert list(problem) == ["application/problem+json"]


def test_pdf_the_400_rows_name_the_catalogs_codes_and_verifys_named_admission_allowance_only(
    pdf_doc: dict[str, Any],
) -> None:
    for operation_id in ("renderPdf", "fillPdf", "signPdf", "verifyPdf"):
        description = operations(pdf_doc)[operation_id][2]["responses"]["400"]["description"]
        named = {word.strip(" ,.") for word in description.partition("(")[2].rstrip(").").split(",")}
        listed = next(item for item in endpoint(operation_id)["statuses"] if item["status"] == 400)["codes"]
        assert named == set(listed) | ADMISSION_ALLOWANCE.get(operation_id, set()), operation_id
    assert "bad_request" in operations(pdf_doc)["verifyPdf"][2]["responses"]["400"]["description"]


def test_pdf_the_verify_report_trust_policy_is_a_member_that_is_never_null(pdf_doc: dict[str, Any]) -> None:
    """The catalog marks `trustPolicy` non-nullable (and optional): the schema says a policy or nothing, not null."""
    member = pdf_doc["components"]["schemas"]["PdfVerifyReport"]["properties"]["trustPolicy"]
    assert "anyOf" not in member
    assert member["$ref"].endswith("/PdfTrustPolicySummary")
    assert "trustPolicy" not in pdf_doc["components"]["schemas"]["PdfVerifyReport"]["required"]


def test_the_pdf_group_document_holds_only_the_five_pdf_routes() -> None:
    datum, _ = pdf_fakes.make_datum(pdf_fakes.config(web={"openapi": {"group_documents": True}}))
    with TestClient(pdf_fakes.build_app(datum)) as running:
        reply = running.get("/api/openapi/pdf.json")
    assert reply.status_code == 200
    assert set(reply.json()["paths"]) == {full_path(endpoint(op)) for op in PDF_OPERATIONS}


def test_without_group_documents_no_pdf_group_document_route_exists() -> None:
    """Walk the factory's own router: the application's route table holds an included router with no path."""
    on, _ = pdf_fakes.make_datum(pdf_fakes.config(web={"openapi": {"group_documents": True}}))
    twin = {getattr(route, "path", "") for route in routers.pdf(on, dependencies=[]).routes}
    assert any(path.endswith("/openapi/pdf.json") for path in twin), "the positive twin: the walk can find it"
    datum, _ = pdf_fakes.make_datum()
    paths = {getattr(route, "path", "") for route in routers.pdf(datum, dependencies=[]).routes}
    assert paths
    assert not any(path.endswith("pdf.json") for path in paths)


def test_pdf_the_openapi_switch_off_hides_the_routes_from_the_document_but_keeps_them_working() -> None:
    datum, _ = pdf_fakes.make_datum(pdf_fakes.config(web={"openapi": {"enabled": False}}))
    app = pdf_fakes.build_app(datum)
    assert app.openapi()["paths"] == {}
    with TestClient(app) as running:
        assert running.get("/api/server/certificate").status_code in {200, 404}


def test_the_tag_prefix_setting_renames_the_pdf_tag() -> None:
    assert operations(pdf_document(pdf_fakes.config(web={"openapi": {"tag_prefix": "acme-"}})))["renderPdf"][2][
        "tags"
    ] == ["acme-pdf"]
