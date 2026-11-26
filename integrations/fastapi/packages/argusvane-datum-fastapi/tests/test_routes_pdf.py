"""`routers.pdf`: `renderPdf`, `fillPdf`, `signPdf`, `verifyPdf` and `serverCertificate`.

The factory is `@privileged` (`dependencies` is a required keyword; `[]` is the explicit opt-out) and applies the
application's dependencies to render, fill and sign ONLY: verify and the server's certificate stay public (the catalog
lists no 403 on them). The started guard runs after the application's dependencies on the three guarded routes and first
on the two public ones. Each route exists only with its own switch (`datum.web.api.endpoints.{pdf, fill, sign, verify,
certificate}`) and `datum.pdf.enabled`. The routes hold no status or wire-code literal, no JSON call and no PDF logic:
the mapping is `datum_core.http.pdf`'s and `DatumRoute`'s, and the admission order is 415 > the address limit
(429, test_routes_address_limit.py) > 413 > 400 > the per-form throttle (429) > 503 with the body counted chunk by
chunk. These tests run on the floor
(fastapi 0.133.0) and the latest leg alike.
"""

import ast
import base64
import inspect
import json
import logging
import urllib.parse
from collections.abc import Iterator
from pathlib import Path
from typing import Any, cast

import pytest
from asgi_driver import body_of, call, status_of
from datum_fakes import dep_a, dep_b, refusing
from fastapi import Depends, HTTPException
from fastapi.routing import APIRoute
from fastapi.testclient import TestClient
from pdf_fakes import (
    PDF_MEDIA,
    Parts,
    Signer,
    build_app,
    config,
    envelope,
    fake_pdf,
    generated_layout,
    make_datum,
    operations_of,
    pdf_definition,
    required_missing,
    template_layout,
)
from trace_log import TRACE

from datum_core.aio import AsyncPdfService
from datum_core.hooks import HookFindings, HookProblem, HookRefusedError
from datum_core.loggers import CHECKS
from datum_core.testing.tsa_pki import DocumentPki, TsaIdentity, build_document_pki, make_leaf
from datum_core.throttle import Allow
from datum_core.throttle import Deny as Denied
from datum_fastapi import DatumRoute, routers
from datum_fastapi.body import bounded_body
from datum_sandbox.checks import DatumConfigurationError
from datum_sandbox.protocol import DefinitionTooDeepError, SandboxError, SandboxFailure
from datum_sandbox.wasi import EngineBusyError, EngineStrayBoundError, RunEnd

OPERATIONS = {"renderPdf", "fillPdf", "signPdf", "verifyPdf", "serverCertificate"}
GUARDED = ("renderPdf", "fillPdf", "signPdf")
PEM_BEGIN = b"-----BEGIN CERTIFICATE-----"

pytestmark = pytest.mark.anyio


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


@pytest.fixture(scope="module")
def pki() -> DocumentPki:
    return build_document_pki()


def serving(
    pki: DocumentPki, *, dependencies: tuple[Any, ...] = (), signed: bool = True, **more: Any
) -> Iterator[tuple[TestClient, Parts]]:
    parts = Parts(signer=Signer(pki.signer) if signed else None)
    datum, _ = make_datum(parts=parts, **more)
    with TestClient(build_app(datum, dependencies=dependencies)) as client:
        yield client, parts


@pytest.fixture
def served(pki: DocumentPki) -> Iterator[tuple[TestClient, Parts]]:
    yield from serving(pki)


def render(client: TestClient, body: Any = None, **headers: str) -> Any:
    sent = {"Content-Type": "application/json", **headers}
    return client.post("/api/pdf", content=json.dumps({"document": envelope()} if body is None else body), headers=sent)


class RecordingDeny:
    """A throttle double that denies and records the kinds it was asked about."""

    def __init__(self) -> None:
        self.kinds: list[str] = []

    def check(self, key: Any) -> Any:
        self.kinds.append(key.kind.value)
        return Denied(retry_after=11)

    def record(self, key: Any) -> None:
        return None


# -- the route table ---------------------------------------------------------------------------------------------------
def test_the_router_holds_the_five_catalog_operations_at_the_default_prefix(pki: DocumentPki) -> None:
    datum, _ = make_datum()
    router = routers.pdf(datum, dependencies=[])
    found = {op: (sorted(route.methods or ()), route.path) for op, route in operations_of(router).items() if route.path}
    assert found == {
        "renderPdf": (["POST"], "/api/pdf"),
        "fillPdf": (["POST"], "/api/pdf/fill"),
        "signPdf": (["POST"], "/api/pdf/sign"),
        "verifyPdf": (["POST"], "/api/pdf/verify"),
        "serverCertificate": (["GET"], "/api/server/certificate"),
    }


def test_the_prefix_moves_all_five_routes() -> None:
    datum, _ = make_datum()
    paths = {r.path for r in routers.pdf(datum, prefix="/v2", dependencies=[]).routes if isinstance(r, APIRoute)}
    assert paths == {"/v2/pdf", "/v2/pdf/fill", "/v2/pdf/sign", "/v2/pdf/verify", "/v2/server/certificate"}


def test_the_routes_use_datums_route_class_and_the_catalog_tag() -> None:
    datum, _ = make_datum()
    routes = [r for r in routers.pdf(datum, dependencies=[]).routes if isinstance(r, APIRoute)]
    assert {r.operation_id for r in routes} == OPERATIONS
    assert all(isinstance(route, DatumRoute) for route in routes)
    assert all(route.tags == ["datum-pdf"] for route in routes)


def test_the_factory_is_privileged_so_dependencies_is_a_required_keyword() -> None:
    parameter = inspect.signature(routers.pdf).parameters["dependencies"]
    assert parameter.kind is inspect.Parameter.KEYWORD_ONLY
    assert parameter.default is inspect.Parameter.empty
    datum, _ = make_datum()
    with pytest.raises(TypeError, match="dependencies"):
        cast("Any", routers.pdf)(datum)
    assert "pdf" in routers.__all__


@pytest.mark.parametrize(
    ("switch", "operation"),
    [
        ("pdf", "renderPdf"),
        ("fill", "fillPdf"),
        ("sign", "signPdf"),
        ("verify", "verifyPdf"),
        ("certificate", "serverCertificate"),
    ],
)
def test_each_route_exists_only_with_its_own_switch(switch: str, operation: str) -> None:
    datum, _ = make_datum(config(endpoints={switch: True}))
    found = {r.operation_id for r in routers.pdf(datum, dependencies=[]).routes if isinstance(r, APIRoute)}
    assert found == {operation}


def test_a_router_with_every_switch_off_adds_no_route_and_names_the_switches_in_a_w001(
    caplog: pytest.LogCaptureFixture,
) -> None:
    datum, _ = make_datum(config(endpoints={}))
    assert [r for r in routers.pdf(datum, dependencies=[]).routes if isinstance(r, APIRoute)] == []
    with caplog.at_level(logging.WARNING, logger=CHECKS), TestClient(build_app(datum)):
        pass
    notices = [r.getMessage() for r in caplog.records if getattr(r, "datum_check_id", None) == "datum.W001"]
    assert any("pdf" in text for text in notices)
    text = " ".join(r.getMessage() for r in caplog.records)
    assert "datum.web.api.endpoints.pdf" in text
    assert "datum.web.api.endpoints.verify" in text


def test_the_capability_off_or_datum_off_adds_no_route() -> None:
    for cfg in (config(pdf={"enabled": False}), config(enabled=False)):
        datum, _ = make_datum(cfg)
        assert [r for r in routers.pdf(datum, dependencies=[]).routes if isinstance(r, APIRoute)] == []


def test_with_the_switches_off_the_routes_answer_the_applications_404(pki: DocumentPki) -> None:
    datum, _ = make_datum(config(endpoints={}))
    with TestClient(build_app(datum)) as client:
        assert client.post("/api/pdf", content=b"{}", headers={"Content-Type": "application/json"}).status_code == 404
        assert client.get("/api/server/certificate").status_code == 404


# -- privilege ---------------------------------------------------------------------------------------------------------
def test_the_applications_dependencies_run_on_render_fill_and_sign_and_not_on_verify_or_the_certificate(
    pki: DocumentPki,
) -> None:
    form = pdf_definition(template_layout("t1"))
    for client, _parts in serving(pki, dependencies=(Depends(dep_a),), form=form):
        TRACE.clear()
        render(client)
        client.post("/api/pdf/fill", json={"document": envelope(), "layoutId": "t1"})
        client.post("/api/pdf/sign", json={"document": envelope()})
        assert TRACE == ["a", "a", "a"]
        TRACE.clear()
        client.post("/api/pdf/verify", content=fake_pdf(), headers={"Content-Type": PDF_MEDIA})
        client.get("/api/server/certificate")
        assert TRACE == []


def test_a_dependency_that_refuses_reaches_the_wire_untouched_and_no_program_is_run_for_the_guarded_routes(
    pki: DocumentPki,
) -> None:
    for client, parts in serving(pki, dependencies=(Depends(refusing(401, "auth")),)):
        for path, body in (
            ("/api/pdf", {"document": envelope()}),
            ("/api/pdf/fill", {"document": envelope(), "layoutId": "t"}),
            ("/api/pdf/sign", {"document": envelope()}),
        ):
            reply = client.post(path, json=body)
            assert reply.status_code == 401, path
        assert parts.program.ops() == []
        assert parts.sandbox.validations == 0
        assert parts.kinds() == []
        assert (
            client.post("/api/pdf/verify", content=fake_pdf(), headers={"Content-Type": PDF_MEDIA}).status_code == 200
        )
        assert client.get("/api/server/certificate").status_code == 200


def test_the_applications_dependency_runs_before_the_started_guard_on_the_guarded_routes_only() -> None:
    """Read on the factory's router: from FastAPI 0.14x `app.routes` holds an included router, not its routes.

    The PDF router carries no router-level dependency (each route holds its own list), so a route's `dependencies` on
    the router is the whole chain it runs, on every FastAPI leg.
    """
    datum, _ = make_datum()
    router = routers.pdf(datum, dependencies=[Depends(dep_a), Depends(dep_b)])
    assert router.dependencies == []
    guards = (datum.started_guard, datum.started_guard.entered)
    seen = 0
    for route in router.routes:
        if not isinstance(route, APIRoute):
            continue
        seen += 1
        chain = [item.dependency for item in route.dependencies]
        if route.operation_id in GUARDED:
            assert chain.index(dep_a) < chain.index(dep_b) < len(chain) - 1, route.operation_id
            assert chain[-1] in guards, route.operation_id
            assert sum(item in guards for item in chain) == 1, route.operation_id
        else:
            assert dep_a not in chain, route.operation_id
            assert dep_b not in chain, route.operation_id
            assert chain[0] in guards, "a public route's guard comes first"
    assert seen == 5


def test_before_the_lifespan_the_guarded_routes_answer_the_dependencys_401_first_and_the_public_ones_the_guards_503(
    pki: DocumentPki,
) -> None:
    datum, parts = make_datum()
    running = TestClient(
        build_app(datum, dependencies=(Depends(refusing(401, "auth")),))
    )  # no `with`: the lifespan never ran
    assert running.post("/api/pdf", json={"document": envelope()}).status_code == 401
    verify = running.post("/api/pdf/verify", content=fake_pdf(), headers={"Content-Type": PDF_MEDIA})
    assert verify.status_code == 503
    assert verify.json()["errors"][0]["code"] == "server.unavailable"
    assert "retry-after" not in verify.headers
    assert running.get("/api/server/certificate").status_code == 503
    assert parts.program.ops() == []


def test_with_a_permissive_dependency_a_started_guard_503_still_follows_before_the_lifespan() -> None:
    datum, _ = make_datum()
    running = TestClient(build_app(datum))
    reply = running.post("/api/pdf", json={"document": envelope()})
    assert reply.status_code == 503
    assert reply.json()["errors"][0]["code"] == "server.unavailable"


# -- the answers -------------------------------------------------------------------------------------------------------
def test_posted_answers_print_as_a_pdf_sealed_with_the_test_seal(served: tuple[TestClient, Parts]) -> None:
    client, parts = served
    reply = render(client)
    assert reply.status_code == 200
    assert reply.headers["content-type"].partition(";")[0] == PDF_MEDIA
    assert reply.content.startswith(b"%PDF-")
    assert int(reply.headers["x-page-count"]) >= 1
    assert "Datum test seal" in urllib.parse.unquote(reply.headers["x-signed-by"])
    assert reply.headers["x-signature-field"].strip() != ""
    assert parts.signer is not None
    assert parts.signer.signs == 0, "posted answers are not sealed with the servers key"
    assert parts.kinds() == ["PdfRenderedEvent"]


def test_a_posted_pdf_names_the_pdf_theme_of_the_forms_binding_and_the_program_is_sent_its_theme(
    pki: DocumentPki, tmp_path: Path
) -> None:
    theme = {"id": "ledger", "version": "1.0.0", "target": "pdf"}
    (tmp_path / "ledger.json").write_text(json.dumps(theme), encoding="utf-8")
    bindings = {
        "routes": {"contact": "ledger-binding"},
        "catalog": {"ledger-binding": {"label": "Ledger", "pdf_theme": "ledger"}},
        "pdf_themes": {"ledger": str(tmp_path / "ledger.json")},
    }
    for routed, want in ((True, "ledger"), (False, "datum-pdf")):
        sections = dict(bindings) if routed else {**bindings, "routes": {}}
        datum, parts = make_datum(config(bindings=sections), parts=Parts(signer=Signer(pki.signer)))
        with TestClient(build_app(datum)) as client:
            reply = render(client)
        assert reply.status_code == 200
        assert reply.headers["x-datum-pdf-theme"] == want
        sent = parts.program.requests("document")[0]
        assert sent.get("theme") == (theme if routed else None)


def test_the_explicit_sign_route_seals_with_the_servers_key_and_names_the_signer(
    served: tuple[TestClient, Parts], pki: DocumentPki
) -> None:
    client, parts = served
    reply = client.post("/api/pdf/sign", json={"document": envelope()})
    assert reply.status_code == 200
    assert reply.headers["x-signed-by"].strip() != ""
    assert "Datum%20test%20seal" not in reply.headers["x-signed-by"]
    assert parts.signer is not None
    assert parts.signer.signs == 1


def test_a_signing_handoff_not_over_the_prepared_file_is_500_signature_and_the_key_signs_nothing(
    served: tuple[TestClient, Parts], caplog: pytest.LogCaptureFixture
) -> None:
    client, parts = served

    def elsewhere(op: str) -> Any:
        def answer(request: dict[str, Any]) -> dict[str, Any]:
            given = parts.program._default(op, request)
            if "signing" in given:
                given["signing"]["digest"] = base64.b64encode(b"\x00" * 32).decode("ascii")
            return given

        return answer

    for op in ("document", "sign"):  # wherever the route's program prepares the signature
        parts.program.answers[op] = elsewhere(op)
    with caplog.at_level(logging.ERROR):
        reply = client.post("/api/pdf/sign", json={"document": envelope()})
    assert (reply.status_code, [item["code"] for item in reply.json()["errors"]]) == (500, ["signature"])
    assert "message" not in reply.json()["errors"][0]
    assert "prepared" not in reply.text
    assert parts.signer is not None
    assert parts.signer.signs == 0
    assert parts.program.requests("complete") == []
    assert any("handoff" in record.getMessage() for record in caplog.records)


def test_the_certificate_route_answers_the_chain_in_pem_leaf_first(
    served: tuple[TestClient, Parts], pki: DocumentPki
) -> None:
    client, _ = served
    reply = client.get("/api/server/certificate")
    assert reply.status_code == 200
    assert reply.content.startswith(PEM_BEGIN)
    blocks = reply.text.count("-----BEGIN CERTIFICATE-----")
    assert blocks == 2
    assert base64.b64encode(pki.signer.leaf_der).decode() in reply.text.replace("\n", "")


def test_without_a_key_the_certificate_is_404_certificate_not_found_and_the_other_routes_work(pki: DocumentPki) -> None:
    for client, _parts in serving(pki, signed=False, cfg=config(pdf={"seal": {"enabled": False}})):
        reply = client.get("/api/server/certificate")
        assert reply.status_code == 404
        assert reply.json()["errors"][0]["code"] == "certificate.notFound"
        assert render(client).status_code == 200


def test_a_fill_of_an_inline_template_is_filled_and_a_generated_layout_is_not_a_template(pki: DocumentPki) -> None:
    form = pdf_definition(template_layout("t1"), generated_layout("g1"))
    for client, _parts in serving(pki, form=form):
        ok = client.post("/api/pdf/fill", json={"document": envelope(), "layoutId": "t1"})
        assert ok.status_code == 200
        assert ok.headers["x-datum-layout"] == "t1"
        bad = client.post("/api/pdf/fill", json={"document": envelope(), "layoutId": "g1"})
        assert (bad.status_code, bad.json()["errors"][0]["code"]) == (400, "layout.notTemplate")


def test_an_unknown_layout_is_404_layout_not_found_on_every_guarded_route(served: tuple[TestClient, Parts]) -> None:
    client, parts = served
    for path in ("/api/pdf", "/api/pdf/fill", "/api/pdf/sign"):
        reply = client.post(path, json={"document": envelope(), "layoutId": "datum-tck-no-such-layout"})
        assert (reply.status_code, reply.json()["errors"][0]["code"]) == (404, "layout.notFound"), path
    assert "document" not in parts.program.ops()


def test_a_form_the_server_does_not_have_is_404_form_not_found(served: tuple[TestClient, Parts]) -> None:
    client, _ = served
    reply = render(client, {"document": envelope(form="nope")})
    assert (reply.status_code, reply.json()["errors"][0]["code"]) == (404, "form.notFound")


def test_answers_the_server_refuses_are_not_printed_422_with_the_codes(served: tuple[TestClient, Parts]) -> None:
    client, parts = served
    parts.sandbox.verdict = required_missing()
    reply = render(client)
    assert reply.status_code == 422
    assert [item["code"] for item in reply.json()["errors"]] == ["required"]
    assert parts.program.ops() == []
    assert parts.kinds() == []


@pytest.mark.parametrize("path", ["/api/pdf", "/api/pdf/fill", "/api/pdf/sign"])
def test_a_valid_but_stale_version_is_422_form_outdated_and_never_a_pdf(pki: DocumentPki, path: str) -> None:
    """The pdf operations list no 409 and their 422 is open, so a stale version is 422."""
    for client, parts in serving(pki, form=pdf_definition(template_layout("t1"))):
        reply = client.post(path, json={"document": envelope(version="2"), "layoutId": "t1"})
        assert (reply.status_code, reply.json()["errors"][0]["code"]) == (422, "form.outdated")
        assert [item["code"] for item in reply.json()["errors"]] == ["form.outdated"]
        assert "etag" not in reply.headers
        assert parts.program.ops() == []
        assert parts.kinds() == []


# -- admission through the route ---------------------------------------------------------------------------------------
@pytest.mark.parametrize("path", ["/api/pdf", "/api/pdf/fill", "/api/pdf/sign"])
@pytest.mark.parametrize("media", ["text/plain", PDF_MEDIA])
def test_the_json_routes_refuse_a_non_json_type_with_415_and_run_nothing(
    served: tuple[TestClient, Parts], path: str, media: str
) -> None:
    client, parts = served
    reply = client.post(path, content=b"{}", headers={"Content-Type": media})
    assert reply.status_code == 415
    assert reply.json()["errors"][0]["code"] == "unsupported_media_type"
    assert parts.program.ops() == []
    assert parts.sandbox.validations == 0


def test_verify_takes_application_pdf_only_and_json_to_it_is_415(served: tuple[TestClient, Parts]) -> None:
    client, parts = served
    reply = client.post("/api/pdf/verify", content=b"{}", headers={"Content-Type": "application/json"})
    assert reply.status_code == 415
    assert parts.program.ops() == []


@pytest.mark.parametrize("path", ["/api/pdf", "/api/pdf/verify"])
async def test_the_media_type_is_415_before_a_malformed_content_length_is_400(path: str) -> None:
    datum, parts = make_datum()
    app = build_app(datum)
    async with datum:
        sent = await call(
            app,
            path=path,
            headers={"content-type": "text/plain", "content-length": "-1"},
            events=[{"type": "http.request", "body": b"{}", "more_body": False}],
        )
    assert status_of(sent) == 415
    assert parts.program.ops() == []


def test_bytes_that_are_not_a_pdf_are_400_pdf_not_a_pdf(served: tuple[TestClient, Parts]) -> None:
    client, parts = served
    reply = client.post("/api/pdf/verify", content=b"hello", headers={"Content-Type": PDF_MEDIA})
    assert (reply.status_code, reply.json()["errors"][0]["code"]) == (400, "pdf.notAPdf")
    assert parts.program.ops() == []


def test_a_file_the_program_cannot_read_is_400_pdf_unreadable(served: tuple[TestClient, Parts]) -> None:
    client, parts = served
    parts.program.answers["verify"] = lambda _r: {
        "ok": False,
        "error": {"code": "internal", "message": "Error: Failed to parse PDF document"},
    }
    reply = client.post("/api/pdf/verify", content=fake_pdf(), headers={"Content-Type": PDF_MEDIA})
    assert (reply.status_code, reply.json()["errors"][0]["code"]) == (400, "pdf.unreadable")
    assert "Failed to parse" not in reply.text, "the program's words stay in the log"


def test_a_good_pdf_is_a_verify_report_with_the_catalogs_members(served: tuple[TestClient, Parts]) -> None:
    client, _ = served
    reply = client.post("/api/pdf/verify", content=fake_pdf() + b"x" * 30, headers={"Content-Type": PDF_MEDIA})
    assert reply.status_code == 200
    document = reply.json()
    assert {"sha256", "bytes", "signatures"} <= set(document)
    assert document["signatures"] == []
    assert document["bytes"] == len(fake_pdf()) + 30


def test_the_json_body_cap_is_413_before_the_dry_run_and_before_the_throttle(pki: DocumentPki) -> None:
    throttle = RecordingDeny()
    for client, parts in serving(pki, cfg=config(web={"api": {"max_body_size": "1KiB"}}), throttle=throttle):
        big = {"document": envelope(name="x" * 5000)}
        reply = render(client, big)
        assert (reply.status_code, reply.json()["errors"][0]["code"]) == (413, "bad_document")
        assert parts.sandbox.validations == 0
        assert parts.program.ops() == []
    assert throttle.kinds == []


def test_a_chunked_json_body_is_counted_too(pki: DocumentPki) -> None:
    def chunks() -> Iterator[bytes]:
        yield b'{"document": "'
        for _ in range(200):
            yield b"x" * 100
        yield b'"}'

    for client, parts in serving(pki, cfg=config(web={"api": {"max_body_size": "1KiB"}})):
        reply = client.post("/api/pdf", content=chunks(), headers={"Content-Type": "application/json"})
        assert reply.status_code == 413
        assert parts.program.ops() == []


def test_a_verify_file_one_byte_over_the_cap_is_413_before_the_program_even_chunked(pki: DocumentPki) -> None:
    def chunks() -> Iterator[bytes]:
        yield b"%PDF-"
        for _ in range(1024):
            yield b"y" * 1024
        yield b"z"

    for client, parts in serving(pki, cfg=config(runtime={"verify_max_bytes": "1MiB"})):
        reply = client.post("/api/pdf/verify", content=chunks(), headers={"Content-Type": PDF_MEDIA})
        assert (reply.status_code, reply.json()["errors"][0]["code"]) == (413, "bad_document")
        assert parts.program.requests("verify") == []
        exact = b"%PDF-" + b"y" * (1024 * 1024 - 5)
        assert client.post("/api/pdf/verify", content=exact, headers={"Content-Type": PDF_MEDIA}).status_code == 200


async def test_content_length_that_lies_in_either_direction_cannot_pass_the_cap(pki: DocumentPki) -> None:
    datum, parts = make_datum(config(runtime={"verify_max_bytes": "1MiB"}))
    app = build_app(datum)
    async with datum:
        big = b"%PDF-" + b"y" * (1024 * 1024 + 10)
        smaller = await call(
            app,
            path="/api/pdf/verify",
            headers={"content-type": PDF_MEDIA, "content-length": "20"},
            events=[
                {"type": "http.request", "body": big[:2048], "more_body": True},
                {"type": "http.request", "body": big[2048:], "more_body": False},
            ],
        )
        assert status_of(smaller) == 413, "a declared length smaller than the body: the count refuses"
        larger = await call(
            app,
            path="/api/pdf/verify",
            headers={"content-type": PDF_MEDIA, "content-length": str(1024 * 1024 + 1)},
            events=[{"type": "http.request", "body": b"%PDF-1.7", "more_body": False}],
        )
        assert status_of(larger) == 413, "a declared length over the cap: refused before the body is read"
        assert b"bad_document" in body_of(larger)
    assert parts.program.requests("verify") == []


async def test_the_verify_route_stops_at_the_first_over_cap_chunk_before_the_throttle() -> None:
    throttle = RecordingDeny()
    datum, parts = make_datum(config(runtime={"verify_max_bytes": "1MiB"}), throttle=throttle)
    app = build_app(datum)
    async with datum:
        sent = await call(
            app,
            path="/api/pdf/verify",
            headers={"content-type": PDF_MEDIA},
            events=[{"type": "http.request", "body": b"%PDF-" + b"y" * 1024 * 1024, "more_body": True}],
        )
    assert status_of(sent) == 413
    assert json.loads(body_of(sent))["errors"][0]["code"] == "bad_document"
    assert parts.program.requests("verify") == []
    assert throttle.kinds == []


async def test_the_render_route_stops_at_the_first_over_cap_chunk_before_the_throttle() -> None:
    throttle = RecordingDeny()
    datum, parts = make_datum(config(web={"api": {"max_body_size": "1KiB"}}), throttle=throttle)
    app = build_app(datum)
    async with datum:
        sent = await call(
            app,
            path="/api/pdf",
            headers={"content-type": "application/json"},
            events=[{"type": "http.request", "body": b"x" * 2048, "more_body": True}],
        )
    assert status_of(sent) == 413
    assert parts.program.ops() == []
    assert parts.sandbox.validations == 0
    assert throttle.kinds == []


def test_the_verify_cap_is_verify_max_bytes_and_the_json_cap_is_max_body_size(pki: DocumentPki) -> None:
    cfg = config(runtime={"verify_max_bytes": "2MiB"}, web={"api": {"max_body_size": "1KiB"}})
    whole = fake_pdf() + b"x" * (1024 * 1024 + 10)

    def chunks() -> Iterator[bytes]:
        yield whole[: 1024 * 1024]
        yield whole[1024 * 1024 :]

    over = b"%PDF-" + b"y" * (2 * 1024 * 1024 - 4)

    def over_chunks() -> Iterator[bytes]:
        yield over[: 1024 * 1024]
        yield over[1024 * 1024 :]

    for client, parts in serving(pki, cfg=cfg):
        sent = {"Content-Type": PDF_MEDIA}
        assert client.post("/api/pdf/verify", content=whole, headers=sent).status_code == 200
        assert client.post("/api/pdf/verify", content=chunks(), headers=sent).status_code == 200
        assert len(parts.program.requests("verify")) == 2
        refused = client.post("/api/pdf/verify", content=over_chunks(), headers=sent)
        assert (refused.status_code, refused.json()["errors"][0]["code"]) == (413, "bad_document")
        assert len(parts.program.requests("verify")) == 2
        big = render(client, {"document": envelope(name="x" * 5000)})
        assert big.status_code == 413


async def test_a_verify_cap_set_over_the_ceiling_is_clamped_to_100_mib_at_the_route() -> None:
    datum, parts = make_datum(config(runtime={"verify_max_bytes": "200MiB"}))
    app = build_app(datum)
    async with datum:
        sent = await call(
            app,
            path="/api/pdf/verify",
            headers={"content-type": PDF_MEDIA, "content-length": str(100 * 1024 * 1024 + 1)},
            events=[{"type": "http.request", "body": fake_pdf(), "more_body": False}],
        )
    assert status_of(sent) == 413
    assert parts.program.requests("verify") == []


@pytest.mark.parametrize(("path", "media"), [("/api/pdf", "application/json"), ("/api/pdf/verify", PDF_MEDIA)])
async def test_a_client_that_leaves_mid_upload_costs_no_run_no_event_and_no_answer(
    path: str, media: str, caplog: pytest.LogCaptureFixture
) -> None:
    datum, parts = make_datum()
    app = build_app(datum)
    async with datum:
        with caplog.at_level(logging.INFO):
            sent = await call(
                app,
                path=path,
                headers={"content-type": media},
                events=[{"type": "http.request", "body": b'{"document": ', "more_body": True}],
            )
        runner = datum.runner
        assert runner is not None
        assert (runner.slots_in_use, runner.in_flight) == (0, 0), "the read held no slot and started no call"
    assert status_of(sent) is None
    assert parts.program.ops() == []
    assert parts.kinds() == []
    assert parts.sandbox.validations == 0
    assert not [record for record in caplog.records if record.levelno >= logging.ERROR]


def test_a_fill_that_names_no_layout_is_400_bad_document_and_runs_nothing(served: tuple[TestClient, Parts]) -> None:
    client, parts = served
    reply = client.post("/api/pdf/fill", json={"document": envelope()})
    assert (reply.status_code, reply.json()["errors"][0]["code"]) == (400, "bad_document")
    assert parts.program.ops() == []
    assert parts.sandbox.validations == 0


@pytest.mark.parametrize("body", [b"[]", b'{"layoutId": "t1"}', b'{"document": {}, "layoutId": 7}', b"not json"])
def test_a_body_that_is_not_a_document_and_a_layout_is_400_bad_document(
    served: tuple[TestClient, Parts], body: bytes
) -> None:
    client, parts = served
    reply = client.post("/api/pdf", content=body, headers={"Content-Type": "application/json"})
    assert (reply.status_code, reply.json()["errors"][0]["code"]) == (400, "bad_document")
    assert parts.sandbox.validations == 0


@pytest.mark.parametrize("path", ["/api/pdf", "/api/pdf/verify"])
async def test_a_content_length_that_is_not_a_whole_number_is_400_bad_request_before_a_byte_is_read(path: str) -> None:
    """`bad_request` is the malformed-framing answer on the pdf operations."""
    datum, parts = make_datum()
    app = build_app(datum)
    media = "application/json" if path == "/api/pdf" else PDF_MEDIA
    async with datum:
        sent = await call(
            app,
            path=path,
            headers={"content-type": media, "content-length": "-1"},
            events=[{"type": "http.request", "body": b"{}", "more_body": False}],
        )
    assert status_of(sent) == 400
    assert json.loads(body_of(sent))["errors"][0]["code"] == "bad_request"
    assert parts.program.ops() == []
    assert parts.sandbox.validations == 0


@pytest.mark.parametrize(
    ("word", "status", "code"),
    [("layout", 404, "layout.notFound"), ("render_limit", 422, "render_limit"), ("template", 422, "template")],
)
def test_the_programs_listed_words_answer_their_row_and_no_program_text(
    served: tuple[TestClient, Parts], word: str, status: int, code: str
) -> None:
    client, parts = served
    parts.program.answers["document"] = lambda _r: {"ok": False, "error": {"code": word, "message": "PROGRAM-TEXT"}}
    reply = render(client)
    assert (reply.status_code, reply.json()["errors"][0]["code"]) == (status, code)
    assert "PROGRAM-TEXT" not in reply.text
    assert parts.kinds() == []


def test_problem_details_mode_answers_a_print_refusal_as_problem_json(pki: DocumentPki) -> None:
    for client, _parts in serving(pki, cfg=config(web={"api": {"problem_details": True}})):
        reply = render(client, {"document": envelope(form="nope")})
        assert reply.status_code == 404
        assert reply.headers["content-type"].startswith("application/problem+json")
        assert (reply.json()["code"], reply.json()["status"]) == ("form.notFound", 404)


# -- throttle, busy, unavailable ---------------------------------------------------------------------------------------
def test_a_throttled_pdf_route_is_429_flood_with_retry_after_and_counts_the_pdf_kind(pki: DocumentPki) -> None:
    class Throttle:
        kinds: list[str] = []  # noqa: RUF012 - a recording double

        def check(self, key: Any) -> Any:
            self.kinds.append(key.kind.value)
            return Denied(retry_after=11)

        def record(self, key: Any) -> None:
            return None

    throttle = Throttle()
    for client, parts in serving(pki, throttle=throttle):
        reply = render(client)
        assert (reply.status_code, reply.json()["errors"][0]["code"]) == (429, "flood")
        assert reply.headers["retry-after"] == "11"
        verify = client.post("/api/pdf/verify", content=fake_pdf(), headers={"Content-Type": PDF_MEDIA})
        assert verify.status_code == 429
        assert verify.headers["retry-after"] == "11"
        assert parts.program.ops() == []
        assert parts.sandbox.validations == 0
    assert throttle.kinds == ["pdf", "pdf"]


@pytest.mark.parametrize(
    ("failure", "wire"),
    [
        pytest.param(SandboxError(SandboxFailure.THREW, "program threw"), "wasm.execution_error", id="execution"),
        pytest.param(SandboxError(SandboxFailure.OUTCOME_TOO_LARGE, "big"), "outcome_too_large", id="outcome"),
        pytest.param(DefinitionTooDeepError(32, "deep"), "definition.tooDeep", id="the registered form too deep"),
    ],
)
def test_a_run_that_gave_no_verdict_on_the_answers_is_503_with_the_runs_code_and_no_retry_after(
    served: tuple[TestClient, Parts], failure: Exception, wire: str
) -> None:
    client, parts = served
    parts.sandbox.error = failure
    reply = render(client)
    assert (reply.status_code, reply.json()["errors"][0]["code"]) == (503, wire)
    assert "retry-after" not in reply.headers
    assert "program threw" not in reply.text
    assert parts.program.ops() == []


def test_a_busy_engine_is_503_server_busy_with_retry_after(served: tuple[TestClient, Parts]) -> None:
    client, parts = served
    parts.program.raises["document"] = EngineBusyError("every slot is taken")
    reply = render(client)
    assert (reply.status_code, reply.json()["errors"][0]["code"]) == (503, "server.busy")
    assert "retry-after" in reply.headers
    assert parts.kinds() == []


def test_a_full_stray_bound_is_503_server_unavailable_with_no_retry_after(served: tuple[TestClient, Parts]) -> None:
    # The engine refuses a new run while runs that would not stop fill the stray bound: a runtime fault, not busy.
    client, parts = served
    parts.program.raises["document"] = EngineStrayBoundError(2, 2)
    reply = render(client)
    assert (reply.status_code, reply.json()["errors"][0]["code"]) == (503, "server.unavailable")
    assert "retry-after" not in reply.headers
    assert parts.kinds() == []


def test_a_program_that_runs_out_of_time_is_503_wasm_execution_error_never_the_programs_words(
    served: tuple[TestClient, Parts],
) -> None:
    client, parts = served
    parts.program.ends["document"] = RunEnd.BUDGET
    reply = render(client)
    assert (reply.status_code, reply.json()["errors"][0]["code"]) == (503, "wasm.execution_error")
    assert "retry-after" not in reply.headers  # the same run fails the same way
    # nothing printed is announced; the interrupted run is (the PDF run publishes it as the sandbox does)
    assert parts.kinds() == ["SandboxRunInterruptedEvent"]
    (interrupted,) = parts.events
    assert (getattr(interrupted, "program", None), getattr(interrupted, "reason", None)) == ("pdf", "budget")


def test_a_program_refusal_is_500_internal_with_no_program_text_and_the_cause_logged(
    served: tuple[TestClient, Parts], caplog: pytest.LogCaptureFixture
) -> None:
    client, parts = served
    parts.program.answers["document"] = lambda _r: {
        "ok": False,
        "error": {"code": "font", "message": "SECRET-FONT-PATH /opt/x"},
    }
    with caplog.at_level(logging.DEBUG):
        reply = render(client)
    assert (reply.status_code, reply.json()["errors"][0]["code"]) == (500, "internal")
    assert "SECRET-FONT-PATH" not in reply.text
    assert "font" not in reply.text.lower().replace("internal", "")
    assert parts.kinds() == []


def test_a_layout_that_requires_a_seal_the_server_cannot_make_is_500_signature_and_the_cause_stays_in_the_log(
    pki: DocumentPki, caplog: pytest.LogCaptureFixture
) -> None:
    """The program's `signature` refusal is the 500 `signature` the seal's own refusals answer, with no message."""
    required = template_layout("t1")
    required["signature"] = {"required": True}
    for client, parts in serving(
        pki, signed=False, cfg=config(pdf={"seal": {"enabled": False}}), form=pdf_definition(required)
    ):
        parts.program.answers["document"] = lambda _r: {
            "ok": False,
            "error": {"code": "signature", "message": "A signature is required and no certificate was given"},
        }
        with caplog.at_level(logging.DEBUG):
            reply = client.post("/api/pdf/fill", json={"document": envelope(), "layoutId": "t1"})
    assert (reply.status_code, reply.json()["errors"][0]["code"]) == (500, "signature")
    assert all("message" not in item for item in reply.json()["errors"])
    assert "certificate" not in reply.text
    assert any(
        record.name.startswith("datum") and "signature" in record.getMessage().lower() for record in caplog.records
    )
    assert parts.kinds() == []


def test_a_signer_that_raises_is_500_signature_with_no_message_and_nothing_published(
    pki: DocumentPki, caplog: pytest.LogCaptureFixture
) -> None:
    class Failing(Signer):
        def sign(self, to_be_signed: bytes) -> bytes:
            raise OSError("SECRET-KEY-HANDLE slot 9")

    parts = Parts(signer=Failing(pki.signer))
    datum, _ = make_datum(parts=parts)
    with TestClient(build_app(datum)) as client, caplog.at_level(logging.DEBUG):
        reply = client.post("/api/pdf/sign", json={"document": envelope()})
    assert (reply.status_code, reply.json()["errors"][0]["code"]) == (500, "signature")
    assert all("message" not in item for item in reply.json()["errors"])
    assert "SECRET" not in reply.text
    assert parts.program.requests("complete") == []
    assert parts.kinds() == []


def test_an_engine_that_cannot_run_the_pdf_program_is_503_server_unavailable_with_no_retry_after(
    pki: DocumentPki,
) -> None:
    from pdf_fakes import ScriptedProgram  # noqa: PLC0415 - one use

    parts = Parts(program=ScriptedProgram(abi="3.17.0"))
    datum, _ = make_datum(config(runtime={"fail_fast": False}, pdf={"seal": {"enabled": False}}), parts)
    with TestClient(build_app(datum)) as client:
        reply = render(client)
        verify = client.post("/api/pdf/verify", content=fake_pdf(), headers={"Content-Type": PDF_MEDIA})
    for answer in (reply, verify):
        assert (answer.status_code, answer.json()["errors"][0]["code"]) == (503, "server.unavailable")
        assert "retry-after" not in answer.headers
    assert parts.program.requests("document") == []
    assert parts.program.requests("verify") == []


# -- hooks through the routes ------------------------------------------------------------------------------------------
# A hook refusal answers by its kind (403, 409, 422). The catalog lists no 409 on renderPdf/fillPdf/signPdf and its
# 403 lists `access.denied` only, so the 409 (and the hook's own code on a 403) is a deviation from the catalog.
HOOK_KIND_DEVIATION = {409}


@pytest.mark.parametrize(("kind", "status"), [("forbidden", 403), ("conflict", 409), ("invalid", 422)])
def test_a_hook_refusal_reaches_the_wire_by_its_kind(pki: DocumentPki, kind: str, status: int) -> None:
    def refuse(draft: Any) -> None:
        raise getattr(HookRefusedError, kind)("pdf.hook", "words")

    for client, parts in serving(pki, pdf_request_customizers=[refuse]):
        reply = render(client)
        assert reply.status_code == status
        assert (status in HOOK_KIND_DEVIATION) or status in {403, 422}
        assert reply.json()["errors"][0]["code"] == "pdf.hook"
        assert parts.program.ops() == []


def test_validator_errors_are_422_with_every_error_in_order(pki: DocumentPki) -> None:
    def errors(candidate: Any) -> HookFindings:
        return HookFindings(errors=(HookProblem(None, "pdf.one", "one"), HookProblem(None, "pdf.two", "two")))

    for client, parts in serving(pki, pdf_result_validators=[errors]):
        reply = render(client)
        assert reply.status_code == 422
        assert [item["code"] for item in reply.json()["errors"]] == ["pdf.one", "pdf.two"]
        assert parts.signer is not None
        assert parts.signer.signs == 0
        assert parts.kinds() == []


def test_a_hook_that_raises_anything_else_is_500_internal(pki: DocumentPki) -> None:
    def broken(draft: Any) -> None:
        raise ZeroDivisionError

    for client, _parts in serving(pki, pdf_request_customizers=[broken]):
        reply = render(client)
        assert (reply.status_code, reply.json()["errors"][0]["code"]) == (500, "internal")


# -- the headers -------------------------------------------------------------------------------------------------------
def test_a_signer_with_non_ascii_in_its_name_is_percent_encoded_in_the_header(pki: DocumentPki) -> None:
    from cryptography.hazmat.primitives.asymmetric import rsa  # noqa: PLC0415 - one use

    key = rsa.generate_private_key(65537, 2048)
    leaf = make_leaf("Zoë O'Brien + Co", key, pki.signer.root, pki.signer.root_key, eku=(), eku_critical=False)
    identity = TsaIdentity("odd", pki.signer.root_key, pki.signer.root, key, leaf)
    parts = Parts(signer=Signer(identity))
    datum, _ = make_datum(parts=parts)
    with TestClient(build_app(datum)) as client:
        reply = client.post("/api/pdf/sign", json={"document": envelope()})
    sent = reply.headers["x-signed-by"]
    assert sent.isascii()
    assert "+" not in sent
    assert " " not in sent
    assert urllib.parse.unquote_plus(sent) == "Zoë O'Brien + Co" or "Zoë O'Brien + Co" in urllib.parse.unquote(sent)


def test_the_render_answer_carries_no_cookie_no_session_and_no_etag(served: tuple[TestClient, Parts]) -> None:
    client, _ = served
    reply = render(client)
    assert "set-cookie" not in reply.headers
    assert "etag" not in reply.headers


def test_binding_modules_hold_no_status_or_wire_code_literal() -> None:
    source = Path(inspect.getfile(routers.pdf)).read_text(encoding="utf-8")
    tree = ast.parse(source)
    strings = {node.value for node in ast.walk(tree) if isinstance(node, ast.Constant) and isinstance(node.value, str)}
    for literal in (
        "layout.notFound",
        "pdf.notAPdf",
        "bad_document",
        "flood",
        "internal",
        "application/pdf",
        "X-Signed-By",
        "X-Page-Count",
    ):
        assert literal not in strings, literal
    numbers = {
        node.value
        for node in ast.walk(tree)
        if isinstance(node, ast.Constant) and isinstance(node.value, int) and node.value >= 100
    }
    assert not numbers & {200, 400, 404, 413, 415, 422, 429, 500, 503}


async def test_the_bindings_async_face_wraps_the_core_service_inside_the_lifespan_and_is_refused_outside_it() -> None:
    datum, _ = make_datum()
    with pytest.raises(Exception):  # noqa: B017, PT011 - outside the lifespan there is no runner: an AnswerError
        _ = datum.async_pdf
    async with datum:
        face = datum.async_pdf
        assert isinstance(face, AsyncPdfService)
        assert face.service is datum.pdf_service


async def test_the_async_face_is_a_configuration_error_while_the_capability_is_off() -> None:
    datum, _ = make_datum(config(pdf={"enabled": False}))
    async with datum:
        with pytest.raises(DatumConfigurationError):
            _ = datum.async_pdf


# -- http details ------------------------------------------------------------------------------------------
MIB = 1024 * 1024


class AllowingKeys:
    """A throttle double that allows everything and keeps the keys it was asked about."""

    def __init__(self) -> None:
        self.keys: list[Any] = []

    def check(self, key: Any) -> Any:
        self.keys.append(key)
        return Allow()

    def record(self, key: Any) -> None:
        return None


def test_the_public_verify_route_never_runs_the_applications_principal_seam_and_counts_the_address(
    pki: DocumentPki,
) -> None:
    ran: list[str] = []

    async def seam() -> str:
        ran.append("principal")
        raise HTTPException(status_code=401)

    throttle = AllowingKeys()
    for client, _parts in serving(pki, principal=seam, throttle=throttle):
        reply = client.post("/api/pdf/verify", content=fake_pdf(), headers={"Content-Type": PDF_MEDIA})
        assert reply.status_code == 200, "a refusing seam would make the public route non-public"
    assert ran == []
    assert [(key.ip, key.principal, key.kind.value) for key in throttle.keys] == [("testclient", None, "pdf")]


def test_the_printing_routes_still_count_the_principal_the_seam_names(pki: DocumentPki) -> None:
    throttle = AllowingKeys()
    for client, _parts in serving(pki, principal=lambda: "alice", throttle=throttle):
        assert render(client).status_code == 200
    assert [key.principal for key in throttle.keys] == ["alice"]


def test_the_default_verify_cap_is_20_mib_on_the_wire(pki: DocumentPki) -> None:
    exact = b"%PDF-" + b"y" * (20 * MIB - 5)
    for client, parts in serving(pki):
        sent = {"Content-Type": PDF_MEDIA}
        assert client.post("/api/pdf/verify", content=exact, headers=sent).status_code == 200
        assert len(parts.program.requests("verify")) == 1
        refused = client.post("/api/pdf/verify", content=exact + b"z", headers=sent)
        assert (refused.status_code, refused.json()["errors"][0]["code"]) == (413, "bad_document")
        assert len(parts.program.requests("verify")) == 1


@pytest.mark.parametrize("path", ["/api/pdf", "/api/pdf/fill", "/api/pdf/sign"])
def test_application_pdf_to_a_printing_route_is_415_at_the_route_before_any_service(
    served: tuple[TestClient, Parts], path: str
) -> None:
    client, parts = served
    reply = client.post(path, content=fake_pdf(), headers={"Content-Type": PDF_MEDIA})
    assert (reply.status_code, reply.json()["errors"][0]["code"]) == (415, "unsupported_media_type")
    assert parts.program.ops() == []
    assert parts.sandbox.validations == 0


async def test_the_body_dependency_hands_the_one_cap_to_the_header_check() -> None:
    seen: list[int] = []

    def check(headers: Any, *, max_bytes: int) -> None:
        seen.append(max_bytes)

    class Asked:
        headers: dict[str, str] = {}  # noqa: RUF012 - a stand-in request

        async def stream(self) -> Any:
            yield b"abc"

    dependency = bounded_body(max_bytes=7, check=check)
    assert await dependency(cast("Any", Asked())) == b"abc"
    assert seen == [7], "the check reads the route's cap from the body dependency, not from a second copy"
