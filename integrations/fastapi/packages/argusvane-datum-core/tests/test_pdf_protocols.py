"""The PDF protocols module and the kernel protocol: records, guards, and that nothing third-party is imported."""

import ast
import dataclasses
import inspect
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import get_args, get_type_hints

import pytest

from datum_core.hooks import HookFindings
from datum_core.pdf import protocols
from datum_core.pdf.protocols import (
    PDF_TRUST_WORDS,
    PdfOperation,
    PdfRequestDraft,
    PdfResultCandidate,
    PdfSigner,
    PdfTrustVerdict,
    PdfTrustWord,
    PdfValidationTime,
    PdfValueVerdict,
    RevocationChecker,
    RevocationStatus,
)
from datum_sandbox.protocol import _pdf
from datum_sandbox.protocol._pdf import (
    PdfCapabilities,
    PdfCompleted,
    PdfKernel,
    PdfProduced,
    PdfSignatureAlgorithm,
    PdfSigned,
    PdfSigningHandoff,
    PdfVerified,
)

NOW = datetime(2026, 10, 20, 12, 0, tzinfo=UTC)
PROTOCOLS_FILE = Path(protocols.__file__ or "")
KERNEL_FILE = Path(_pdf.__file__ or "")
SECRET = b"%PDF-1.7 secret bytes"


def draft() -> PdfRequestDraft:
    return PdfRequestDraft("render", "form", None, None, {"documentId": "d"}, {}, {})


def candidate() -> PdfResultCandidate:
    return PdfResultCandidate("fill", "form", "layout", None, SECRET, 2)


def imported_roots(path: Path) -> set[str]:
    roots: set[str] = set()
    for node in ast.walk(ast.parse(path.read_text())):
        if isinstance(node, ast.Import):
            roots.update(a.name.split(".")[0] for a in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
            roots.add(node.module.split(".")[0])
    return roots


# -- nothing third-party -------------------------------------------------------------------------------------------


def test_the_protocol_modules_import_only_the_standard_library_and_datum() -> None:
    for path in (PROTOCOLS_FILE, KERNEL_FILE):
        roots = imported_roots(path)
        assert roots <= {*sys.stdlib_module_names, "datum_core", "datum_sandbox"}, (
            path.name,
            roots - sys.stdlib_module_names,
        )


def test_the_protocol_modules_import_no_capability_submodule() -> None:
    for path in (PROTOCOLS_FILE, KERNEL_FILE):
        for node in ast.walk(ast.parse(path.read_text())):
            if isinstance(node, ast.ImportFrom) and node.module:
                assert not node.module.startswith(("datum_core.timestamp", "datum_core.http", "datum_core.aio")), (
                    node.module
                )
                assert not node.module.startswith("datum_core.pdf.") or node.module == "datum_core.pdf.protocols"


# -- the signer and the checker leak nothing ----------------------------------------------------------------------


def test_the_signer_protocol_has_exactly_the_three_members() -> None:
    members = {n for n, _ in inspect.getmembers(PdfSigner) if not n.startswith("_")}
    assert members == {"algorithm", "certificates", "sign"}
    sign = inspect.signature(PdfSigner.sign)
    assert list(sign.parameters) == ["self", "to_be_signed"]
    assert sign.return_annotation is bytes


def test_the_checker_protocol_has_exactly_one_member() -> None:
    members = {n for n, _ in inspect.getmembers(RevocationChecker) if not n.startswith("_")}
    assert members == {"status"}
    assert list(inspect.signature(RevocationChecker.status).parameters) == ["self", "chain", "moment", "crls", "ocsps"]


def test_the_kernel_protocol_names_the_eight_members_and_no_timestamp_request() -> None:
    members = {n for n, _ in inspect.getmembers(PdfKernel) if not n.startswith("_")}
    assert members == {"program", "capabilities", "document", "fill", "sign", "complete", "verify", "inspect"}
    for name in ("document", "fill", "sign", "complete", "verify", "inspect"):
        assert list(inspect.signature(getattr(PdfKernel, name)).parameters) == ["self", "request"]
    assert list(inspect.signature(PdfKernel.capabilities).parameters) == ["self"]


def test_no_record_has_a_field_that_could_hold_a_key_or_a_password() -> None:
    for record in (
        PdfRequestDraft,
        PdfResultCandidate,
        PdfTrustVerdict,
        PdfCapabilities,
        PdfProduced,
        PdfSigned,
        PdfCompleted,
        PdfVerified,
        PdfSigningHandoff,
    ):
        for f in dataclasses.fields(record):
            assert (
                not any(word in f.name for word in ("key", "password", "secret", "passphrase")) or f.name == "form_key"
            ), (
                record.__name__,
                f.name,
            )


# -- the records ----------------------------------------------------------------------------------------------------


def test_the_records_are_frozen_and_slotted() -> None:
    records: list[object] = [
        draft(),
        candidate(),
        PdfTrustVerdict("site"),
        PdfCapabilities("1.0.0", "0.1.0"),
        PdfProduced(SECRET, 1),
        PdfCompleted(SECRET, "Sig1", b"cms", True),
    ]
    for record in records:
        with pytest.raises(dataclasses.FrozenInstanceError):
            setattr(record, "unknown", 1)  # noqa: B010
        assert not hasattr(record, "__dict__")


def test_the_draft_pieces_change_in_place_and_are_not_shared_between_drafts() -> None:
    first, second = draft(), draft()
    first.options["compact"] = True
    first.attachments.append({"name": "a"})
    first.fonts.append({"family": "f"})
    assert second.options == {}
    assert second.attachments == []
    assert second.fonts == []
    with pytest.raises(dataclasses.FrozenInstanceError):
        first.env = {}  # type: ignore[misc]


def test_the_draft_carries_neither_the_abi_nor_the_kernel_operation_nor_the_program() -> None:
    names = {f.name for f in dataclasses.fields(PdfRequestDraft)}
    assert names == {
        "op",
        "form_key",
        "layout_id",
        "principal",
        "env",
        "options",
        "host_context",
        "attachments",
        "fonts",
    }
    assert set(get_args(PdfOperation.__value__)) == {"render", "fill", "sign", "render_submission"}


HANDOFF = PdfSigningHandoff(
    "Sig1", (0, 1, 2, 3), b"d", b"tbs", b"tbsd", "RSASSA-PKCS1-v1_5-SHA256", "ETSI.CAdES.detached"
)


@pytest.mark.parametrize(
    "record",
    [candidate(), PdfProduced(SECRET, 1), PdfSigned(SECRET, HANDOFF), PdfCompleted(SECRET, "Sig1", b"cms-bytes", True)],
)
def test_the_pdf_bytes_never_reach_a_repr_or_a_str(record: object) -> None:
    for text in (repr(record), str(record)):
        assert "secret bytes" not in text
        assert "%PDF" not in text
        assert "cms-bytes" not in text


def test_every_bytes_field_but_the_handoff_digests_is_hidden_from_repr() -> None:
    open_fields = {"digest", "to_be_signed", "to_be_signed_digest"}
    for module in (protocols, _pdf):
        for _, cls in inspect.getmembers(module, inspect.isclass):
            if not dataclasses.is_dataclass(cls) or cls.__module__ != module.__name__:
                continue
            hints = get_type_hints(cls)
            for f in dataclasses.fields(cls):
                if hints[f.name] is bytes and f.name not in open_fields:
                    assert f.repr is False, (cls.__name__, f.name)


def test_the_contract_words_are_the_catalogs() -> None:
    assert set(get_args(RevocationStatus.__value__)) == {"good", "revoked", "unknown"}
    assert set(get_args(PdfValueVerdict.__value__)) == {"valid", "invalid", "unchecked"}
    assert set(get_args(PdfSignatureAlgorithm.__value__)) == {
        "RSASSA-PKCS1-v1_5-SHA256",
        "ECDSA-P256-SHA256",
        "ECDSA-P384-SHA256",
    }
    assert get_type_hints(RevocationChecker.status)["return"] is RevocationStatus
    assert get_type_hints(PdfSigner.certificates)["return"] == tuple[bytes, ...]
    assert isinstance(PdfSigner.__dict__["algorithm"], property)


def test_the_draft_hides_attachment_and_font_bytes_from_repr() -> None:
    d = draft()
    d.attachments.append({"data": "QVRUQUNI"})
    d.fonts.append({"data": "Rk9OVA"})
    assert "QVRUQUNI" not in repr(d)
    assert "Rk9OVA" not in repr(d)


def test_the_candidate_reports_its_size() -> None:
    assert candidate().size == len(SECRET)
    assert candidate().page_count == 2
    assert candidate().warnings == ()


def test_the_validation_time_words_are_the_wire_words() -> None:
    assert [m.value for m in PdfValidationTime] == ["now", "signing-time"]
    assert PdfValidationTime("signing-time") is PdfValidationTime.SIGNING_TIME


def test_the_trust_words_are_the_catalogs_five_in_order() -> None:
    assert PDF_TRUST_WORDS == ("site", "site_retired", "trusted", "self_signed", "unknown")
    assert set(get_args(PdfTrustWord.__value__)) == set(PDF_TRUST_WORDS)


@pytest.mark.parametrize("word", [w for w in PDF_TRUST_WORDS if w != "trusted"])
def test_every_trust_word_but_trusted_builds_a_bare_verdict(word: str) -> None:
    assert PdfTrustVerdict(word).trusted_at is None  # type: ignore[arg-type]


def test_a_trusted_verdict_needs_its_instant() -> None:
    with pytest.raises(ValueError, match="carries the instant"):
        PdfTrustVerdict("trusted")


def test_a_verdict_refuses_a_word_outside_the_list() -> None:
    with pytest.raises(ValueError, match="trust word"):
        PdfTrustVerdict("trusted-ish")  # type: ignore[arg-type]


def test_only_a_trusted_verdict_carries_the_instant_and_it_is_aware() -> None:
    assert PdfTrustVerdict("trusted", NOW).trusted_at == NOW
    for word in ("site", "site_retired", "self_signed", "unknown"):
        with pytest.raises(ValueError, match="only a trusted signer"):
            PdfTrustVerdict(word, NOW)
    with pytest.raises(ValueError, match="timezone-aware"):
        PdfTrustVerdict("trusted", datetime(2026, 10, 20, 12, 0))


def test_the_handoff_and_answers_are_plain_values() -> None:
    handoff = PdfSigningHandoff(
        "Sig1", (0, 1, 2, 3), b"d", b"tbs", b"tbsd", "RSASSA-PKCS1-v1_5-SHA256", "ETSI.CAdES.detached"
    )
    produced = PdfProduced(SECRET, 1, signing=handoff)
    assert produced.signing is handoff
    assert produced.layout_id is None
    assert produced.warnings == ()
    assert produced.attachments == ()
    assert PdfSigned(SECRET, handoff).warnings == ()
    assert PdfVerified(()).document_id is None


def test_a_result_findings_type_is_the_hooks_findings() -> None:
    assert HookFindings().ok


def test_the_checker_takes_the_archive_by_keyword_only_with_an_empty_default() -> None:
    parameters = inspect.signature(RevocationChecker.status).parameters
    for name in ("crls", "ocsps"):
        assert parameters[name].kind is inspect.Parameter.KEYWORD_ONLY
        assert parameters[name].default == ()
    assert [p.kind for p in list(parameters.values())[1:3]] == [inspect.Parameter.POSITIONAL_OR_KEYWORD] * 2


def test_the_trust_verdict_has_exactly_the_word_the_instant_and_an_optional_reason() -> None:
    fields = dataclasses.fields(PdfTrustVerdict)
    assert [(field.name, field.default) for field in fields] == [
        ("word", dataclasses.MISSING),
        ("trusted_at", None),
        ("reason", None),
    ]
    assert PdfTrustVerdict("unknown").reason is None
    assert PdfTrustVerdict("trusted", NOW, "a note").reason == "a note"
