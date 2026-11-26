"""`datum.W011`, `datum.W012` and `datum.I002` for the PDF seal's timestamp sources.

A seal asks a timestamp (`datum.pdf.seal.timestamp`, true by default) from, in order, the application's `Timestamper`,
the client of `datum.pdf.signing.tsa.url`, the in-process authority (`datum.tsa.enabled`). With none of the three the
seals carry the `sealing.timestamp` warning, and the start says so once: `datum.W011` (WARNING). Beside an application
`Timestamper`, a set `datum.pdf.signing.tsa.policy` is unused (`datum.W012`, WARNING) and an unused URL or credential is
`datum.I002` (INFO). The ids are stable, silenceable (INFO and WARNING) and documented; nothing is checked while the
seal or the PDF capability is off.
"""

import logging
from pathlib import Path
from typing import Any

import pytest
from pdf_support import IdentitySigner, RecordingTimestamper, pdf_signing, plain_pdf_datum
from tsa_support import POLICY

from datum_core.checks import CHECK_LEVELS, I002, W011, W012, W013
from datum_core.loggers import CHECKS
from datum_core.pdf import TestSealSigner
from datum_core.testing.tsa_pki import TsaPki, build_document_pki
from datum_sandbox.checks import CheckLevel

SEAL_ON = {"pdf": {"seal": {"enabled": True, "timestamp": True}}}
TSA_ON = {
    "enabled": True,
    "access": "open",
    "policy": POLICY,
    "allow_memory_stores": True,
    "signer": {"self_signed": True},
}


def merged(base: dict[str, Any], **more: Any) -> dict[str, Any]:
    out = {name: dict(value) if isinstance(value, dict) else value for name, value in base.items()}
    for name, value in more.items():
        if name in out and isinstance(out[name], dict) and isinstance(value, dict):
            out[name] = {**out[name], **value}
        else:
            out[name] = value
    return out


def started_ids(
    config: dict[str, Any], caplog: pytest.LogCaptureFixture, *, keyed: bool = True, **seams: Any
) -> list[logging.LogRecord]:
    """Start with a server key present (W011 is gated on one) unless `keyed` is false."""
    if keyed and "pdf_signer" not in seams:
        seams["pdf_signer"] = IdentitySigner(build_document_pki().signer)
    datum = plain_pdf_datum(config, **seams)
    with caplog.at_level(logging.INFO, logger=CHECKS):
        datum.start()
    try:
        return [
            r
            for r in caplog.records
            if getattr(r, "datum_check_id", None) in {W011, W012, I002} and r.msg != "HINT: %s"
        ]
    finally:
        datum.stop()


def ids_of(records: list[logging.LogRecord]) -> list[str]:
    return [str(getattr(r, "datum_check_id", None)) for r in records]


def test_the_ids_are_stable_words_with_their_levels() -> None:
    assert (W011, W012, W013, I002) == ("datum.W011", "datum.W012", "datum.W013", "datum.I002")
    assert CHECK_LEVELS[W013] is CheckLevel.WARNING
    assert CHECK_LEVELS[W011] is CheckLevel.WARNING
    assert CHECK_LEVELS[W012] is CheckLevel.WARNING
    assert CHECK_LEVELS[I002] is CheckLevel.INFO


def test_the_authority_beside_set_tsa_settings_raises_no_notice(caplog: pytest.LogCaptureFixture) -> None:
    config = merged(
        {**SEAL_ON, "tsa": TSA_ON}, pdf={"signing": {"tsa": {"policy": POLICY, "bearer_token": "token-ZZ"}}}
    )
    config["pdf"]["seal"] = SEAL_ON["pdf"]["seal"]
    assert started_ids(config, caplog) == []


@pytest.mark.parametrize("tsa", [None, {"policy": POLICY}])
def test_the_sign_route_with_the_seal_off_is_checked_like_a_seal(
    tsa: dict[str, Any] | None, caplog: pytest.LogCaptureFixture, tsa_pki: TsaPki
) -> None:
    config: dict[str, Any] = {"pdf": {"seal": {"enabled": False}}, "web": {"api": {"endpoints": {"sign": True}}}}
    seams: dict[str, Any] = {}
    if tsa is not None:
        config["pdf"]["signing"] = {"tsa": tsa}
        seams["timestamper"] = RecordingTimestamper(tsa_pki.rsa)
    expected = [W011] if tsa is None else [W012]
    assert ids_of(started_ids(config, caplog, **seams)) == expected


def test_the_sign_route_with_the_seal_off_and_no_server_key_raises_no_w011(caplog: pytest.LogCaptureFixture) -> None:
    """The test seal is never timestamped, so with no key there is nothing to warn about (the check is gated on a
    key)."""
    config: dict[str, Any] = {"pdf": {"seal": {"enabled": False}}, "web": {"api": {"endpoints": {"sign": True}}}}
    assert started_ids(config, caplog, keyed=False) == []


# -- W011 --------------------------------------------------------------------------------------------------------------
def test_a_seal_that_asks_a_timestamp_with_no_source_warns_once_naming_the_three_sources(
    caplog: pytest.LogCaptureFixture,
) -> None:
    records = started_ids(SEAL_ON, caplog)
    assert ids_of(records) == [W011]
    (record,) = records
    assert record.levelno == logging.WARNING
    text = record.getMessage() + " " + "\n".join(r.getMessage() for r in caplog.records if r.msg == "HINT: %s")
    assert "sealing.timestamp" in text
    assert "seal timestamps asked, a server key present, and no timestamp source" in text
    assert record.getMessage() == (
        "(datum.W011) seal timestamps asked, a server key present, and no timestamp source: sealed PDFs carry the"
        " sealing.timestamp warning and no token"
    )
    assert "a signing key is configured" not in text
    assert "timestamper" in text
    assert "datum.pdf.signing.tsa.url" in text
    assert "datum.tsa.enabled" in text


def test_a_seal_with_no_server_key_gives_w013_alone_and_no_w011(caplog: pytest.LogCaptureFixture) -> None:
    assert started_ids(SEAL_ON, caplog, keyed=False) == []
    assert len([r for r in caplog.records if getattr(r, "datum_check_id", None) == W013 and r.msg != "HINT: %s"]) == 1


def test_the_default_seal_asks_a_timestamp_so_enabling_it_alone_warns(caplog: pytest.LogCaptureFixture) -> None:
    assert ids_of(started_ids({"pdf": {"seal": {"enabled": True}}}, caplog)) == [W011]


@pytest.mark.parametrize(
    "config",
    [
        {"pdf": {"seal": {"enabled": False, "timestamp": True}}},  # no seal
        {"pdf": {"seal": {"enabled": True, "timestamp": False}}},  # no timestamp asked
        {"pdf": {"enabled": False, "seal": {"enabled": True}}},  # no PDF capability
        {},
    ],
)
def test_nothing_is_checked_when_the_seal_the_timestamp_or_the_capability_is_off(
    config: dict[str, Any], caplog: pytest.LogCaptureFixture
) -> None:
    assert started_ids(config, caplog) == []


def test_an_application_timestamper_is_a_source(tsa_pki: TsaPki, caplog: pytest.LogCaptureFixture) -> None:
    assert started_ids(SEAL_ON, caplog, timestamper=RecordingTimestamper(tsa_pki.rsa)) == []


def test_a_timestamp_authority_url_is_a_source(caplog: pytest.LogCaptureFixture) -> None:
    config = merged(SEAL_ON, pdf={"signing": {"tsa": {"url": "https://tsa.example.invalid/ts"}}})
    config["pdf"]["seal"] = SEAL_ON["pdf"]["seal"]
    assert started_ids(config, caplog) == []


def test_the_in_process_authority_is_a_source_and_never_counted_as_the_applications(
    caplog: pytest.LogCaptureFixture,
) -> None:
    config = {**SEAL_ON, "tsa": TSA_ON}
    assert started_ids(config, caplog) == [], "no W011 and no unused-setting notice either"


def test_a_disabled_in_process_authority_is_no_source(caplog: pytest.LogCaptureFixture) -> None:
    config = {**SEAL_ON, "tsa": {**TSA_ON, "enabled": False}}
    assert ids_of(started_ids(config, caplog)) == [W011]


def test_w011_can_be_silenced_by_id(caplog: pytest.LogCaptureFixture) -> None:
    assert started_ids({**SEAL_ON, "silenced_checks": [W011]}, caplog) == []


# -- W012 and I002 -----------------------------------------------------------------------------------------------------
def test_a_set_policy_beside_the_applications_timestamper_is_unused_and_warns(
    tsa_pki: TsaPki, caplog: pytest.LogCaptureFixture
) -> None:
    config = merged(SEAL_ON, pdf={"signing": {"tsa": {"policy": POLICY}}})
    config["pdf"]["seal"] = SEAL_ON["pdf"]["seal"]
    records = started_ids(config, caplog, timestamper=RecordingTimestamper(tsa_pki.rsa))
    assert ids_of(records) == [W012]
    assert "datum.pdf.signing.tsa.policy" in records[0].getMessage()


def test_an_unused_url_or_credentials_beside_the_applications_timestamper_are_info(
    tsa_pki: TsaPki, caplog: pytest.LogCaptureFixture
) -> None:
    for tsa in (
        {"url": "https://tsa.example.invalid/ts"},
        {"bearer_token": "token-ZZ"},
        {"basic_user": "u", "basic_password": "p-ZZ"},
    ):
        config = merged(SEAL_ON, pdf={"signing": {"tsa": tsa}})
        config["pdf"]["seal"] = SEAL_ON["pdf"]["seal"]
        caplog.clear()
        records = started_ids(config, caplog, timestamper=RecordingTimestamper(tsa_pki.rsa))
        assert ids_of(records) == [I002], tsa
        assert records[0].levelno == logging.INFO
        assert "token-ZZ" not in caplog.text, "a credential is never in a notice"
        assert "p-ZZ" not in caplog.text, "a credential is never in a notice"
        assert "tsa.example.invalid" not in caplog.text, "nor is the address"


def test_url_and_policy_together_give_both_notices_each_once(tsa_pki: TsaPki, caplog: pytest.LogCaptureFixture) -> None:
    config = merged(SEAL_ON, pdf={"signing": {"tsa": {"url": "https://tsa.example.invalid/ts", "policy": POLICY}}})
    config["pdf"]["seal"] = SEAL_ON["pdf"]["seal"]
    assert sorted(ids_of(started_ids(config, caplog, timestamper=RecordingTimestamper(tsa_pki.rsa)))) == sorted(
        [I002, W012]
    )


def test_the_settings_are_not_unused_without_an_application_timestamper(caplog: pytest.LogCaptureFixture) -> None:
    config = merged(SEAL_ON, pdf={"signing": {"tsa": {"url": "https://tsa.example.invalid/ts", "policy": POLICY}}})
    config["pdf"]["seal"] = SEAL_ON["pdf"]["seal"]
    assert started_ids(config, caplog) == []


def test_w012_and_i002_can_be_silenced(tsa_pki: TsaPki, caplog: pytest.LogCaptureFixture) -> None:
    config = merged(SEAL_ON, pdf={"signing": {"tsa": {"url": "https://tsa.example.invalid/ts", "policy": POLICY}}})
    config["pdf"]["seal"] = SEAL_ON["pdf"]["seal"]
    config["silenced_checks"] = [W012, I002]
    assert started_ids(config, caplog, timestamper=RecordingTimestamper(tsa_pki.rsa)) == []


def test_two_timestampers_cannot_be_given_so_there_is_no_check_for_it() -> None:
    with pytest.raises(TypeError):
        plain_pdf_datum(SEAL_ON, timestamper=object(), timestampers=[object()])


# -- W013 ------------------------------------------------------------------------------------------------------------
def w013_records(config: dict[str, Any], caplog: pytest.LogCaptureFixture, **seams: Any) -> list[logging.LogRecord]:
    datum = plain_pdf_datum(config, **seams)
    with caplog.at_level(logging.INFO, logger=CHECKS):
        datum.start()
    datum.stop()
    return [r for r in caplog.records if getattr(r, "datum_check_id", None) == W013 and r.msg != "HINT: %s"]


def test_a_seal_with_no_server_key_warns_once_that_posted_answers_carry_the_test_seal(
    caplog: pytest.LogCaptureFixture,
) -> None:
    (record,) = w013_records({"pdf": {"seal": {"enabled": True, "timestamp": False}}}, caplog)
    assert record.levelno == logging.WARNING
    assert "test seal" in record.getMessage()
    assert "render_submission answers 500" in record.getMessage()


def test_a_test_seal_given_as_the_signer_is_still_no_server_key(caplog: pytest.LogCaptureFixture) -> None:
    config = {"pdf": {"seal": {"enabled": True, "timestamp": False}}}
    assert len(w013_records(config, caplog, pdf_signer=TestSealSigner())) == 1


def test_a_server_key_from_the_application_or_the_settings_is_no_warning(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    pki = build_document_pki()
    config: dict[str, Any] = {"pdf": {"seal": {"enabled": True, "timestamp": False}}}
    assert w013_records(config, caplog, pdf_signer=IdentitySigner(pki.signer)) == []
    named = {"pdf": {**config["pdf"], "signing": pdf_signing(tmp_path, pki.signer).model_dump(mode="python")}}
    assert w013_records(named, caplog) == []


@pytest.mark.parametrize(
    "config",
    [
        {"pdf": {"seal": {"enabled": False}}},
        {"pdf": {"enabled": False, "seal": {"enabled": True}}},
        {"enabled": False},
    ],
)
def test_w013_is_silent_when_the_seal_or_the_capability_is_off(
    config: dict[str, Any], caplog: pytest.LogCaptureFixture
) -> None:
    assert w013_records(config, caplog) == []


def test_w013_can_be_silenced_by_id(caplog: pytest.LogCaptureFixture) -> None:
    config = {"pdf": {"seal": {"enabled": True, "timestamp": False}}, "silenced_checks": [W013]}
    assert w013_records(config, caplog) == []
