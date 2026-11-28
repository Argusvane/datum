"""`Datum` and the PDF capability.

The keywords are `pdf_request_customizers`, `pdf_result_validators`, `pdf_middleware`, `pdf_signer`,
`timestamper` and `pdf_trust_policy` (no `pdf_verifier`, no `pdf_runtime`, no `pdf_fonts`, no `trust_policy`), and a
typo is a `TypeError`. `Datum.pdf_service` is built while `datum.pdf.enabled` (and is `None` while off): the key read
ONCE at start from `datum.pdf.signing` unless a `pdf_signer` replaces it, the anchors from `trust_anchors` (an
unreadable file stops the start naming the setting), the default trust policy `PdfTrustPolicy.standard` with the
server's own certificate as the site's, the timestamper (the application's, else the client of `signing.tsa.url`, else
the in-process authority, which is a `Timestamper` too and never counted as the application's) and the PDF ABI proof
beside the sandbox's: a program that fails it stops the start with the rebuild hint, or with
`datum.runtime.fail_fast=false` leaves the start standing with `pdfUnavailable` on the runtime's health and PDFs
answering 503. Health `pdf` never fails `readyz`; `info()` says `capabilities.timestamp`. After `stop()` the scoped
dispatcher is closed and no key is used.
"""

import base64
import hashlib
import json
import subprocess
import sys
import textwrap
from pathlib import Path
from typing import Any, cast

import pytest
from pdf_support import (
    AuthorityTransport,
    RecordingTimestamper,
    ScriptedPdfRuntime,
    accepted_submission,
    b64,
    common_name,
    pdf_signing,
    pem_signing,
    plain_pdf_datum,
    signature_request,
    started_pdf,
)
from submissions_support import bus, envelope, journey_check
from tsa_support import POLICY

from datum_core.events import PdfRenderedEvent, PdfVerifiedEvent, SandboxRunInterruptedEvent, TimestampIssuedEvent
from datum_core.pdf import PdfService, PdfTrustPolicy
from datum_core.pdf.outcomes import Printed, Verified
from datum_core.submissions import FormRef, TooLarge, Unavailable
from datum_core.testing.tsa_pki import DocumentPki, TsaPki, build_document_pki
from datum_sandbox.checks import DatumConfigurationError
from datum_sandbox.protocol import ProgramUnavailableError, Smoke
from datum_sandbox.wasi import RunEnd

SEAL = {"enabled": True, "timestamp": False, "posted_answers": True}


@pytest.fixture(scope="module")
def pki() -> DocumentPki:
    return build_document_pki()


# -- the keywords ------------------------------------------------------------------------------------------------------
def test_every_pdf_keyword_is_accepted_and_kept_in_order() -> None:
    def a(_draft: Any) -> None:
        return None

    def b(_draft: Any) -> None:
        return None

    datum = plain_pdf_datum(
        pdf_request_customizers=[a, b],
        pdf_result_validators=[b, a],
        pdf_middleware=[lambda kernel: kernel],
        pdf_trust_policy=PdfTrustPolicy(anchors=()),
    )
    assert datum.pdf_request_customizers == (a, b)
    assert datum.pdf_result_validators == (b, a)
    assert len(datum.pdf_middleware) == 1


@pytest.mark.parametrize(
    "keyword",
    [
        "pdf_verifier",
        "pdf_runtime",
        "pdf_fonts",
        "trust_policy",
        "pdf_trust",
        "pdf_customizers",
        "pdf_validators",
        "pdf_signers",
    ],
)
def test_the_names_that_do_not_exist_and_typos_are_type_errors(keyword: str) -> None:
    with pytest.raises(TypeError, match=keyword):
        plain_pdf_datum(**{keyword: None})


def test_the_service_is_built_while_the_capability_is_on_and_absent_while_it_is_off() -> None:
    with started_pdf() as rig:
        assert isinstance(rig.datum.pdf_service, PdfService)
    with started_pdf({"pdf": {"enabled": False}}) as rig:
        assert rig.datum.pdf_service is None


def test_a_disabled_capability_reads_no_key_no_anchor_and_asks_the_program_nothing() -> None:
    config = {"pdf": {"enabled": False, "signing": {"pkcs12_file": "/no/such.p12", "trust_anchors": ["/no/such.pem"]}}}
    with started_pdf(config) as rig:
        assert rig.runtime.ops() == []
        assert "pdf" not in rig.datum.health().components


def test_the_master_switch_off_adds_no_pdf_service_either() -> None:
    with started_pdf({"enabled": False}) as rig:
        assert rig.datum.pdf_service is None


# -- the key, read once at start ---------------------------------------------------------------------------------------
@pytest.mark.parametrize("kind", ["pkcs12", "pem"])
def test_the_key_the_settings_name_is_read_at_start_and_seals_with_its_certificate(
    tmp_path: Path, pki: DocumentPki, kind: str
) -> None:
    signing = pdf_signing(tmp_path, pki.signer) if kind == "pkcs12" else pem_signing(tmp_path, pki.signer)
    with started_pdf({"pdf": {"seal": SEAL, "signing": signing.model_dump(mode="python")}}) as rig:
        for path in tmp_path.iterdir():
            path.unlink()  # read once: the files are not needed again
        out = rig.render_submission()
        assert isinstance(out, Printed)
        assert signature_request(rig)["certificates"][0] == b64(pki.signer.leaf_der)


def test_a_key_that_cannot_be_read_stops_the_start_naming_the_setting_and_leaves_nothing_started(
    tmp_path: Path, pki: DocumentPki
) -> None:
    signing = pdf_signing(tmp_path, pki.signer)
    wrong = {**signing.model_dump(mode="python"), "pkcs12_password": "not-the-password"}
    datum = plain_pdf_datum({"pdf": {"seal": SEAL, "signing": wrong}})
    with pytest.raises(DatumConfigurationError) as raised:
        datum.start()
    assert "datum.pdf.signing" in str(raised.value)
    assert "not-the-password" not in str(raised.value)
    assert not datum.started


def test_a_signer_the_application_gives_replaces_the_files_which_are_then_not_read(pki: DocumentPki) -> None:
    config = {"pdf": {"seal": SEAL, "signing": {"pkcs12_file": "/no/such.p12", "pkcs12_password": "x"}}}
    with started_pdf(config, signer=pki.signer) as rig:
        assert isinstance(rig.render_submission(), Printed)
        assert rig.signer is not None
        assert len(rig.signer.signs) == 1


def test_the_servers_chain_is_pem_with_the_leaf_first_and_none_without_a_key(pki: DocumentPki) -> None:
    with started_pdf(signer=pki.signer) as rig:
        pem = rig.service.certificate_chain()
    assert isinstance(pem, str)
    assert pem.count("-----BEGIN CERTIFICATE-----") == 2
    from cryptography import x509  # noqa: PLC0415 - tests only

    assert x509.load_pem_x509_certificates(pem.encode()) == [pki.signer.leaf, pki.signer.root]
    with started_pdf({"pdf": {"seal": {"enabled": False}}}) as rig:
        assert rig.service.certificate_chain() is None


def test_an_unreadable_anchor_or_retired_certificate_stops_the_start_naming_the_setting() -> None:
    for setting in ("trust_anchors", "retired_certificates"):
        datum = plain_pdf_datum({"pdf": {"signing": {setting: ["/no/such/file.pem"]}}})
        with pytest.raises(DatumConfigurationError) as raised:
            datum.start()
        assert f"datum.pdf.signing.{setting}" in str(raised.value)
        assert not datum.started


# -- the trust policy --------------------------------------------------------------------------------------------------
def test_the_default_policy_reads_the_anchors_and_takes_the_servers_certificate_as_the_sites(
    tmp_path: Path, pki: DocumentPki
) -> None:
    from pdf_support import anchors_file, signature_report, verify_reply  # noqa: PLC0415 - rows that verify

    anchors = anchors_file(tmp_path, pki.signer.root_der)
    with started_pdf({"pdf": {"signing": {"trust_anchors": [anchors]}}}, signer=pki.email) as rig:
        rig.runtime.on(
            "verify",
            lambda _r: verify_reply(signature_report(pki.email), signature_report(pki.signer, field_name="S2")),
        )
        outcome = rig.verify(b"%PDF-1.7\n")
    assert isinstance(outcome, Verified)
    assert [v.trust for v in outcome.report.signatures] == ["site", "trusted"]


def test_a_policy_the_application_gives_is_used_as_given(pki: DocumentPki) -> None:
    from pdf_support import signature_report, verify_reply  # noqa: PLC0415 - rows that verify

    given = PdfTrustPolicy(anchors=(), site_certificates=())
    with started_pdf(signer=pki.signer, pdf_trust_policy=given) as rig:
        rig.runtime.on("verify", lambda _r: verify_reply(signature_report(pki.signer)))
        outcome = rig.verify(b"%PDF-1.7\n")
    assert outcome.report.signatures[0].trust == "unknown", "the server's own certificate is the policy's to name now"


# -- the timestamper ---------------------------------------------------------------------------------------------------
def timestamp_word(config: dict[str, Any], **seams: Any) -> Any:
    with started_pdf(config, **seams) as rig:
        return cast("dict[str, Any]", rig.datum.info()["capabilities"])


def test_info_names_the_timestamp_source_in_the_four_words(tsa_pki: TsaPki, pki: DocumentPki) -> None:
    seal = {"pdf": {"seal": {"enabled": True, "timestamp": True}}}
    url = {"pdf": {"seal": seal["pdf"]["seal"], "signing": {"tsa": {"url": "https://tsa.example.invalid/ts"}}}}
    site = {
        **seal,
        "tsa": {
            "enabled": True,
            "access": "open",
            "policy": POLICY,
            "allow_memory_stores": True,
            "signer": {"self_signed": True},
        },
    }
    custom = RecordingTimestamper(tsa_pki.rsa)
    assert timestamp_word(seal, signer=pki.signer)["timestamp"] == "none"
    assert timestamp_word(seal, signer=pki.signer, timestamper=custom)["timestamp"] == "custom"
    assert (
        timestamp_word(url, signer=pki.signer, tsa_transport=AuthorityTransport(tsa_pki.rsa))["timestamp"] == "server"
    )
    assert timestamp_word(site, signer=pki.signer)["timestamp"] == "site"


def test_the_application_s_timestamper_outranks_the_url_and_the_url_outranks_the_in_process_authority(
    tsa_pki: TsaPki, pki: DocumentPki
) -> None:
    transport = AuthorityTransport(tsa_pki.rsa)
    config = {
        "pdf": {
            "seal": {"enabled": True, "timestamp": True},
            "signing": {"tsa": {"url": "https://tsa.example.invalid/ts"}},
        },
        "tsa": {
            "enabled": True,
            "access": "open",
            "policy": POLICY,
            "allow_memory_stores": True,
            "signer": {"self_signed": True},
        },
    }
    custom = RecordingTimestamper(tsa_pki.rsa)
    with started_pdf(config, signer=pki.signer, timestamper=custom, tsa_transport=transport) as rig:
        out = rig.render_submission()
        assert isinstance(out, Printed)
        assert out.timestamped is True
        assert len(custom.requests) == 1
        assert transport.calls == []
        assert not [e for e in rig.events if isinstance(e, TimestampIssuedEvent)]
    with started_pdf(config, signer=pki.signer, tsa_transport=transport) as rig:
        out = rig.render_submission()
        assert isinstance(out, Printed)
        assert out.timestamped is True
        assert len(transport.calls) == 1
        assert not [e for e in rig.events if isinstance(e, TimestampIssuedEvent)], (
            "the in-process authority was not asked"
        )


def test_the_url_client_posts_to_the_url_with_a_sha256_query_and_the_token_reaches_complete(
    tsa_pki: TsaPki, pki: DocumentPki
) -> None:
    transport = AuthorityTransport(tsa_pki.rsa)
    config = {
        "pdf": {
            "seal": {"enabled": True, "timestamp": True},
            "signing": {"tsa": {"url": "https://tsa.example.invalid/ts", "policy": POLICY, "timeout": 3}},
        },
    }
    with started_pdf(config, signer=pki.signer, tsa_transport=transport) as rig:
        rig.render_submission()
        (request,) = rig.runtime.requests("complete")
    ((url, headers, body),) = transport.calls
    assert url == "https://tsa.example.invalid/ts"
    assert headers["content-type"] == "application/timestamp-query"
    value = base64.b64decode(request["signing"]["value"])
    assert hashlib.sha256(value).digest() in body
    assert request["signing"]["timestamp"]["token"]


def test_the_in_process_authority_issues_the_seal_token_with_channel_seal_and_publishes_its_own_event(
    pki: DocumentPki,
) -> None:
    config = {
        "pdf": {"seal": {"enabled": True, "timestamp": True}},
        "tsa": {
            "enabled": True,
            "access": "open",
            "policy": POLICY,
            "allow_memory_stores": True,
            "signer": {"self_signed": True},
        },
    }
    with started_pdf(config, signer=pki.signer) as rig:
        out = rig.render_submission()
        assert isinstance(out, Printed)
        assert out.timestamped is True
        issued = [e for e in rig.events if isinstance(e, TimestampIssuedEvent)]
        assert len(issued) == 1
        assert issued[0].client is None
        assert [
            type(e).__name__ for e in rig.events if type(e).__name__ in {"PdfRenderedEvent", "TimestampIssuedEvent"}
        ] == [
            "TimestampIssuedEvent",
            "PdfRenderedEvent",
        ]


# -- the PDF ABI proof -------------------------------------------------------------------------------------------------
def test_a_program_that_fails_the_gate_stops_the_start_with_the_rebuild_hint() -> None:
    trail: list[str] = []
    datum = plain_pdf_datum(runtime=ScriptedPdfRuntime(trail, abi="0.17.0"))
    with pytest.raises(ProgramUnavailableError) as raised:
        datum.start()
    assert "0.17.0" in str(raised.value)
    assert "Rebuild the program assets" in str(raised.value)
    assert not datum.started


def test_with_fail_fast_off_the_start_stands_pdfs_are_unavailable_and_the_rest_works() -> None:
    config = {"runtime": {"fail_fast": False}, "pdf": {"seal": {"enabled": False}}}
    with started_pdf(config, abi="0.17.0") as rig:
        health = rig.datum.health()
        assert health.is_ready, "the sandbox is fine: readyz is unaffected"
        runtime = health.components["runtime"]
        assert runtime.status == "up"
        assert "0.17.0" in str(runtime.details["pdfUnavailable"])
        assert health.components["pdf"].status == "down"
        outcome = rig.render()
        assert type(outcome).__name__ == "Unavailable"
        assert rig.runtime.requests("document") == []
        assert (
            type(
                rig.datum.submission_service.validate(FormRef.from_document(), journey_check(envelope()), bus())
            ).__name__
            == "Checked"
        )


def test_the_proof_asks_capabilities_once_at_start_and_the_program_is_not_asked_again_per_request() -> None:
    with started_pdf() as rig:
        rig.render()
        rig.render()
    assert "capabilities" not in rig.runtime.ops()


def test_a_runtime_without_the_pdf_program_reads_as_pdf_unavailable_on_the_runtime_health() -> None:
    from submissions_support import StubRuntime  # noqa: PLC0415 - a runtime that cannot run PDFs

    datum = plain_pdf_datum({"runtime": {"fail_fast": False}}, runtime=StubRuntime())
    datum.start()
    try:
        assert "pdfUnavailable" in datum.health().components["runtime"].details
        service = datum.pdf_service
        assert service is not None
        assert type(service.render(FormRef.from_document(), envelope(), bus())).__name__ == "Unavailable"
    finally:
        datum.stop()


def test_a_recheck_proves_the_pdf_program_again_and_brings_pdfs_back() -> None:
    config = {"runtime": {"fail_fast": False}, "pdf": {"seal": {"enabled": False}}}
    with started_pdf(config, abi="0.17.0") as rig:
        assert type(rig.render()).__name__ == "Unavailable"
        rig.runtime.abi = "1.0.0"  # the program was rebuilt
        health = rig.datum.recheck()
        assert health.components["pdf"].status == "up"
        assert "pdfUnavailable" not in health.components["runtime"].details
        assert isinstance(rig.render(), Printed)


def test_a_pdf_run_the_runtime_stopped_publishes_the_interrupted_event_naming_the_pdf_program() -> None:
    with started_pdf({"pdf": {"seal": {"enabled": False}}}) as rig:
        rig.runtime.end("document", RunEnd.BUDGET)
        outcome = rig.service.render(FormRef.from_document(), envelope(), bus())
        interrupted = [e for e in rig.events if isinstance(e, SandboxRunInterruptedEvent)]
    assert type(outcome).__name__ == "Unavailable"
    assert [(e.program, e.reason) for e in interrupted] == [("pdf", "budget")]
    assert not [e for e in rig.events if isinstance(e, PdfRenderedEvent)]


def test_an_engine_that_cannot_run_the_program_is_a_choice_not_a_failure_on_the_pdf_component() -> None:
    from submissions_support import StubRuntime  # noqa: PLC0415 - a runtime that cannot run PDFs

    datum = plain_pdf_datum({"runtime": {"fail_fast": False}}, runtime=StubRuntime())
    datum.start()
    try:
        report = datum.health()
        component = report.components["pdf"]
        assert component.status == "up"
        assert "cannot run the PDF program" in str(component.details["unavailable"])
        assert report.is_up
    finally:
        datum.stop()


# -- health and info ---------------------------------------------------------------------------------------------------
def test_health_names_the_engine_and_its_mode_and_never_a_path_a_key_or_a_certificate(
    tmp_path: Path, pki: DocumentPki
) -> None:
    signing = pdf_signing(tmp_path, pki.signer)
    with started_pdf({"pdf": {"seal": SEAL, "signing": signing.model_dump(mode="python")}}) as rig:
        component = rig.datum.health().components["pdf"]
    assert component.status == "up"
    assert set(component.details) == {"engine", "engineMode"}
    assert "seal.p12" not in json.dumps(dict(component.details))


def test_the_pdf_component_never_fails_readiness() -> None:
    with started_pdf(abi="1.0.0") as rig:
        report = rig.datum.health()
    assert report.is_ready
    assert "pdf" in report.components


def test_info_carries_the_timestamp_word_even_when_the_capability_is_off() -> None:
    with started_pdf({"pdf": {"enabled": False}}) as rig:
        assert rig.datum.info()["capabilities"]["timestamp"] == "none"  # type: ignore[index]


# -- the stop gate -----------------------------------------------------------------------------------------------------
def test_after_stop_no_key_is_used_nothing_is_published_and_the_program_is_not_asked(pki: DocumentPki) -> None:
    with started_pdf({"pdf": {"seal": {"enabled": True, "timestamp": False}}}, signer=pki.signer) as rig:
        service = rig.service
        rig.datum.stop()
        before = len(rig.runtime.calls)
        outcome = service.render_submission(accepted_submission())
        assert isinstance(outcome, Unavailable)  # the ruled answer, never a raise and never a print
        assert outcome.code == "server.unavailable"
        assert rig.signer is not None
        assert rig.signer.signs == []
        assert not [e for e in rig.events if isinstance(e, PdfRenderedEvent)]
        assert len(rig.runtime.calls) == before


def test_after_stop_every_operation_is_unavailable_and_verify_publishes_nothing(pki: DocumentPki) -> None:
    from pdf_support import fake_pdf  # noqa: PLC0415 - one use

    with started_pdf({"pdf": {"seal": {"enabled": True, "timestamp": False}}}, signer=pki.signer) as rig:
        service = rig.service
        rig.datum.stop()
        before = len(rig.runtime.calls)
        answers = [
            service.render(FormRef.from_document(), envelope(), bus()),
            service.sign(FormRef.from_document(), envelope(), bus()),
            service.verify(fake_pdf("late"), bus()),
        ]
        assert [type(a).__name__ for a in answers] == ["Unavailable"] * 3
        assert {a.code for a in answers} == {"server.unavailable"}
        assert not [e for e in rig.events if isinstance(e, PdfVerifiedEvent | PdfRenderedEvent)]
        assert len(rig.runtime.calls) == before


# -- 7P-core: the cap, the recheck and the words of info --------------------------------------------------------------
def test_the_service_reads_the_clamped_verify_cap_the_route_reads() -> None:
    """A cap below 1 MiB is clamped up to 1 MiB (datum.W008): the service must refuse and admit where the route does."""
    from pdf_support import fake_pdf  # noqa: PLC0415 - one use

    with started_pdf({"runtime": {"verify_max_bytes": "100KiB"}}) as rig:
        cap = rig.datum.limits.verify_max_bytes
        assert cap == 1024 * 1024
        middle = fake_pdf("big") + b"x" * (200 * 1024)  # over the asked 100 KiB, under the clamped 1 MiB
        assert not isinstance(rig.verify(middle), TooLarge)
        over = rig.verify(b"%PDF-" + b"x" * cap)
        assert isinstance(over, TooLarge)
        assert over.max_bytes == cap


def test_a_recheck_of_a_down_runtime_leaves_the_runtime_up_when_the_pdf_proof_fails_even_with_fail_fast() -> None:
    """`_retry` is a recheck as `_reprove` is: a failed PDF proof leaves PDFs 503 and the runtime up (fail_fast on)."""
    with started_pdf({"pdf": {"seal": {"enabled": False}}}) as rig:
        assert rig.datum.config.runtime.fail_fast is True
        rig.runtime.abi = "0.17.0"  # the program no longer passes its own proof (a refusal is never kept)
        assert rig.datum.recheck().components["pdf"].status == "down"
        rig.sandbox.smoke = lambda: Smoke(ok=False, elapsed=0.0, message="warm-up failed")  # type: ignore[method-assign]
        assert not rig.datum.recheck().is_ready  # the sandbox failed its smoke run: the runtime is down
        rig.sandbox.smoke = lambda: Smoke(ok=True, elapsed=0.0, message="")  # type: ignore[method-assign]
        health = rig.datum.recheck()  # the runtime is built again, and the PDF proof still fails
        assert health.is_ready, "the sandbox is back: only PDFs stay unavailable"
        assert "0.17.0" in str(health.components["runtime"].details["pdfUnavailable"])
        assert health.components["pdf"].status == "down"
        assert type(rig.render()).__name__ == "Unavailable"


def test_a_failed_recheck_of_the_sandbox_leaves_pdfs_answering_unavailable_with_no_program_run() -> None:
    """After a failed re-prove the old kernel is still held; `kernel()` must not hand it out while the PDF capability is
    down."""
    with started_pdf({"pdf": {"seal": {"enabled": False}}}) as rig:
        assert isinstance(rig.render(), Printed)
        rig.sandbox.smoke = lambda: Smoke(ok=False, elapsed=0.0, message="warm-up failed")  # type: ignore[method-assign]
        assert not rig.datum.recheck().is_ready
        rig.runtime.calls.clear()
        outcome = rig.render()
        assert isinstance(outcome, Unavailable)
        assert rig.runtime.requests("document") == []
        # verify needs no sandbox run, so only the kernel guard stands between it and the kernel still held
        from pdf_support import fake_pdf  # noqa: PLC0415 - one use

        read = rig.verify(fake_pdf("held"))
        assert isinstance(read, Unavailable)
        assert rig.runtime.requests("verify") == []


def test_a_recheck_keeps_the_running_kernel_serving_until_the_new_one_has_proved() -> None:
    """`_reprove` builds and proves the new kernel before the swap: a render during the proof is still printed."""
    with started_pdf({"pdf": {"seal": {"enabled": False}}}) as rig:
        during: list[object] = []
        asking = [False]

        def capabilities(_request: dict[str, Any]) -> dict[str, Any]:
            if not asking[0]:  # the running kernel proves itself again inside this render: answer that plainly
                asking[0] = True
                during.append(rig.render())
            return {"abi": rig.runtime.abi, "kernelVersion": "0.1.0"}

        rig.runtime.on("capabilities", capabilities)
        assert rig.datum.recheck().components["pdf"].status == "up"
        assert len(during) == 1
        assert isinstance(during[0], Printed)


def test_a_failed_pdf_recheck_swaps_the_old_kernel_out() -> None:
    """The swap is only for a kernel that proved: a failed proof leaves PDFs unavailable, the old kernel not served."""
    with started_pdf({"pdf": {"seal": {"enabled": False}}}) as rig:
        rig.runtime.abi = "0.17.0"
        health = rig.datum.recheck()
        assert health.components["pdf"].status == "down"
        assert isinstance(rig.render(), Unavailable)


def test_info_says_none_for_the_timestamp_when_no_service_was_built(monkeypatch: pytest.MonkeyPatch) -> None:
    """The extra absent and nothing asked of PDFs: no service, so no source, whatever `tsa.url` says."""
    from datum_core import Datum  # noqa: PLC0415 - one use

    config = {"pdf": {"seal": {"enabled": False}, "signing": {"tsa": {"url": "https://tsa.example.invalid/ts"}}}}
    monkeypatch.setattr(Datum, "_pdf_extra_installed", lambda _self: False)
    with started_pdf(config) as rig:
        assert rig.datum.pdf_service is None
        assert rig.datum.info()["capabilities"]["timestamp"] == "none"  # type: ignore[index]


# -- the extras --------------------------------------------------------------------------------------------------------
def test_a_datum_with_the_capability_on_and_no_cryptography_stops_the_start_naming_the_extra() -> None:
    code = textwrap.dedent(
        """
        import sys
        sys.modules["cryptography"] = None
        from datum_sandbox.checks import DatumConfigurationError
        from datum_core import Datum, DatumConfig
        datum = Datum(config=DatumConfig.model_validate({"pdf": {"enabled": True, "seal": {"enabled": True}}}))
        try:
            datum.start()
        except (DatumConfigurationError, ModuleNotFoundError) as error:
            print(str(error))
        else:
            print("started")
        """
    )
    done = subprocess.run([sys.executable, "-I", "-c", code], capture_output=True, text=True, check=False, timeout=180)  # noqa: S603
    assert done.returncode == 0, done.stderr
    assert "argusvane-datum-core[pdf]" in done.stdout


def test_a_given_signer_with_no_cryptography_still_names_the_extra() -> None:
    code = textwrap.dedent(
        """
        import sys
        sys.modules["cryptography"] = None
        from datum_sandbox.checks import DatumConfigurationError
        from datum_core import Datum, DatumConfig

        class Plain:
            algorithm = "rsa"
            def certificates(self):
                return (b"x",)
            def sign(self, data):
                return b"s"

        sealed = DatumConfig.model_validate({"pdf": {"enabled": True, "seal": {"enabled": True}}})
        datum = Datum(config=sealed, pdf_signer=Plain())
        try:
            datum.start()
        except DatumConfigurationError as error:
            print(str(error))
        else:
            print("started")
        """
    )
    done = subprocess.run([sys.executable, "-I", "-c", code], capture_output=True, text=True, check=False, timeout=180)  # noqa: S603
    assert done.returncode == 0, done.stderr
    assert "argusvane-datum-core[pdf]" in done.stdout


def test_the_default_policy_names_only_the_signers_leaf_as_the_sites(pki: DocumentPki) -> None:
    import datetime as dt  # noqa: PLC0415

    with started_pdf(signer=pki.signer) as rig:
        service = rig.datum.pdf_service
        assert service is not None
        policy = service.trust_policy
        assert tuple(policy.site_certificates) == (pki.signer.leaf_der,)
        verdict = policy.judge([pki.signer.root_der], now=dt.datetime.now(dt.UTC))
        assert verdict.word != "site"


def test_a_datum_with_the_capability_off_needs_no_cryptography() -> None:
    code = textwrap.dedent(
        """
        import sys
        sys.modules["cryptography"] = None
        from datum_core import Datum, DatumConfig
        datum = Datum(config=DatumConfig.model_validate({"pdf": {"enabled": False}}))
        print(datum.pdf_service)
        """
    )
    done = subprocess.run([sys.executable, "-I", "-c", code], capture_output=True, text=True, check=False, timeout=180)  # noqa: S603
    assert done.returncode == 0, done.stderr
    assert done.stdout.strip() == "None"


def test_the_test_seal_is_made_only_when_posted_answers_are_sealed_with_it() -> None:
    with started_pdf({"pdf": {"seal": {"enabled": True, "timestamp": False}}}) as rig:
        out = rig.render()
        assert isinstance(out, Printed)
        assert common_name(base64.b64decode(signature_request(rig)["certificates"][0])) == "Datum test seal"
    with started_pdf({"pdf": {"seal": {"enabled": False}}}) as rig:
        rig.render()
        assert all("signature" not in call.request for call in rig.runtime.calls)
