"""The `datum.pdf.*` settings, the PDF budgets and the floors of the extras.

Most rows read what already exists (the model, the generated schema, the extras) and hold the defaults
the PDF code is written against so a change cannot slide by.
`seal.*` presets what the service signs; `signing.*` names the key and the anchors; `signing.tsa.*` the timestamp
client. Every enum word is refused wherever it is built; a `signing.tsa.policy` that is no OID stops the start; the
passwords are secrets in every dump. The floors: `pdf` needs `cryptography>=45,<51`
(`PolicyBuilder.extension_policies`), `revocation` needs `pyhanko-certvalidator>=0.33,<0.34` with no unbounded range,
and pyHanko is in the dev group as the independent validator.
"""

import json
import re
import tomllib
from datetime import timedelta
from pathlib import Path
from typing import Any

import pytest
from pydantic import ValidationError
from tsa_support import KEY_PASSWORD, P12_PASSWORD, leaks

from datum_core import DatumConfig
from datum_core.config.models import Certify, Pdf, PdfFonts, Runtime, Seal, Signing, TsaClientOptions
from datum_sandbox.checks import DatumConfigurationError
from datum_sandbox.protocol import ProgramLimits

CORE = Path(__file__).resolve().parents[1]
ROOT = CORE.parents[1]
BEARER = "bearer-ZZ-token-ZZ"


def load_toml(path: Path) -> dict[str, Any]:
    return tomllib.loads(path.read_text(encoding="utf-8"))


# -- the defaults ------------------------------------------------------------------------------------------------------
def test_the_pdf_section_defaults_are_the_documented_ones() -> None:
    pdf = Pdf()
    assert pdf.enabled is True
    assert pdf.fonts is PdfFonts.DEFAULT
    assert pdf.seal.enabled is False
    assert pdf.seal.layouts == ()
    assert pdf.seal.certify is Certify.NO_CHANGES
    assert pdf.seal.timestamp is True
    assert (pdf.seal.reason, pdf.seal.location, pdf.seal.visible) == (None, None, None)
    assert pdf.seal.posted_answers is False
    assert pdf.signing.retired_certificates == ()
    assert pdf.signing.trust_anchors == ()
    assert pdf.signing.tsa.url is None
    assert pdf.signing.tsa.policy is None
    assert pdf.signing.tsa.timeout == timedelta(seconds=10)


def test_the_run_budgets_of_the_pdf_pool_and_the_verify_cap_are_the_documented_ones() -> None:
    runtime = Runtime()
    assert runtime.pdf.time_limit == timedelta(seconds=60)
    assert int(runtime.pdf.memory) == 256 * 1024 * 1024
    assert runtime.pdf.concurrency == 0
    assert runtime.pdf.wait == timedelta(seconds=2)
    assert int(runtime.verify_max_bytes) == 20 * 1024 * 1024  # the Spring host's default
    budget = ProgramLimits().pdf_budget()
    assert budget.wall_seconds == 60
    assert budget.memory_bytes == 256 * 1024 * 1024
    assert budget.wait == 2


@pytest.mark.parametrize("size", ["1MiB", "20MiB", "100MiB"])
def test_a_verify_cap_from_1_to_100_mib_is_taken(size: str) -> None:
    assert int(Runtime.model_validate({"verify_max_bytes": size}).verify_max_bytes) >= 1024 * 1024


@pytest.mark.parametrize("size", [0, -1, "0B"])
def test_a_verify_cap_below_one_byte_is_refused(size: object) -> None:
    with pytest.raises(ValidationError, match="verify_max_bytes"):
        Runtime.model_validate({"verify_max_bytes": size})


def test_the_pdf_pool_time_limit_is_held_to_its_bounds_by_the_limits_record() -> None:
    with pytest.raises(ValueError, match="pdf_time_limit"):
        ProgramLimits(pdf_time_limit=301)
    assert ProgramLimits(pdf_time_limit=300).pdf_budget().wall_seconds == 300


# -- the words ---------------------------------------------------------------------------------------------------------
@pytest.mark.parametrize("fonts", ["default", "standard", "all"])
def test_the_three_font_sets_are_taken(fonts: str) -> None:
    assert Pdf.model_validate({"fonts": fonts}).fonts.value == fonts


@pytest.mark.parametrize("certify", ["noChanges", "formFill", "annotate", "none"])
def test_the_certification_words_are_taken(certify: str) -> None:
    assert Seal.model_validate({"certify": certify}).certify.value == certify


@pytest.mark.parametrize(
    ("word", "expected"),
    [
        ("formFilling", "formFill"), ("FORM-FILL", "formFill"), ("form_filling", "formFill"), ("2", "formFill"),
        ("annotations", "annotate"), ("Annotate", "annotate"), ("3", "annotate"),
        ("false", "none"), ("approval", "none"), ("0", "none"), ("nochanges", "noChanges"), (" 1 ", "noChanges"),
    ],
)  # fmt: skip
def test_the_certification_spellings_the_spring_host_reads_are_read_here(word: str, expected: str) -> None:
    assert Seal.model_validate({"certify": word}).certify.value == expected


def test_the_program_words_of_the_certification_kinds() -> None:
    assert [c.program_word for c in Certify] == ["noChanges", "formFilling", "annotations", False]


@pytest.mark.parametrize(
    ("field", "word"),
    [("fonts", "everything"), ("fonts", ""), ("seal", {"certify": "nothing"}), ("seal", {"certify": "4"})],
)
def test_an_enum_word_outside_its_set_is_a_validation_error(field: str, word: Any) -> None:
    with pytest.raises(ValidationError):
        Pdf.model_validate({field: word})


@pytest.mark.parametrize("policy", ["not-an-oid", "1.2.3.", "1..2", "1.2.3a", "3.1.2", "", "1.2.3 4"])
def test_a_tsa_policy_that_is_no_oid_is_a_validation_error(policy: str) -> None:
    with pytest.raises(ValidationError, match="policy"):
        TsaClientOptions.model_validate({"policy": policy})


def test_a_tsa_policy_that_is_an_oid_is_taken() -> None:
    assert str(TsaClientOptions.model_validate({"policy": "1.3.6.1.4.1.99999.1"}).policy) == "1.3.6.1.4.1.99999.1"


def test_the_signing_type_is_pkcs12_or_pem_and_nothing_else() -> None:
    assert Signing.model_validate({"type": "PEM"}).type.value == "PEM"
    with pytest.raises(ValidationError):
        Signing.model_validate({"type": "JKS"})


def test_the_application_built_models_refuse_the_same_words() -> None:
    with pytest.raises(ValidationError):
        DatumConfig.model_validate({"pdf": {"fonts": "everything"}})
    with pytest.raises(ValidationError):
        DatumConfig.model_validate({"pdf": {"seal": {"certify": "nothing"}}})


# -- secrets -----------------------------------------------------------------------------------------------------------
def test_the_passwords_and_credentials_are_secrets_in_every_dump() -> None:
    signing = Signing.model_validate(
        {
            "pkcs12_file": "/x.p12",
            "pkcs12_password": P12_PASSWORD,
            "tsa": {"url": "https://u:p@tsa.example.invalid/", "bearer_token": BEARER, "basic_password": "basic-ZZ-pw"},
        }
    )
    config = DatumConfig.model_validate({"pdf": {"signing": signing.model_dump(mode="python")}})
    texts = [
        repr(signing),
        str(signing),
        signing.model_dump_json(),
        json.dumps(config.model_dump(mode="json")),
        repr(config),
        config.model_dump_json(),
    ]
    for text in texts:
        assert not leaks(text, [P12_PASSWORD, BEARER, "basic-ZZ-pw", "u:p@"])


def test_a_pem_signings_key_password_is_a_secret_in_every_dump() -> None:
    signing = Signing.model_validate(
        {"type": "PEM", "key_file": "/k.pem", "cert_file": "/c.pem", "key_password": KEY_PASSWORD}
    )
    config = DatumConfig.model_validate({"pdf": {"signing": signing.model_dump(mode="python")}})
    texts = [
        repr(signing),
        str(signing),
        signing.model_dump_json(),
        json.dumps(signing.model_dump(mode="json")),
        json.dumps(config.model_dump(mode="json")),
        repr(config),
        str(config),
        config.model_dump_json(),
    ]
    for text in texts:
        assert not leaks(text, [KEY_PASSWORD])
    assert signing.key_password is not None
    assert signing.key_password.get_secret_value() == KEY_PASSWORD


def test_the_environment_names_every_pdf_setting_and_the_five_switches(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    from datum_fastapi import DatumSettings  # noqa: PLC0415 - the binding's env loader

    for name, value in {
        "DATUM_PDF__ENABLED": "true",
        "DATUM_PDF__FONTS": "standard",
        "DATUM_PDF__SEAL__ENABLED": "true",
        "DATUM_PDF__SEAL__TIMESTAMP": "false",
        "DATUM_PDF__SEAL__CERTIFY": "formFilling",
        "DATUM_PDF__SEAL__LAYOUTS": '["a","b"]',
        "DATUM_PDF__SEAL__POSTED_ANSWERS": "true",
        "DATUM_PDF__SIGNING__PKCS12_FILE": str(tmp_path / "seal.p12"),
        "DATUM_PDF__SIGNING__PKCS12_PASSWORD": P12_PASSWORD,
        "DATUM_PDF__SIGNING__TRUST_ANCHORS": '["anchors.pem"]',
        "DATUM_PDF__SIGNING__TSA__TIMEOUT": "4",
        "DATUM_WEB__API__ENDPOINTS__PDF": "true",
        "DATUM_WEB__API__ENDPOINTS__FILL": "true",
        "DATUM_WEB__API__ENDPOINTS__SIGN": "true",
        "DATUM_WEB__API__ENDPOINTS__VERIFY": "true",
        "DATUM_WEB__API__ENDPOINTS__CERTIFICATE": "true",
        "DATUM_RUNTIME__VERIFY_MAX_BYTES": "5MiB",
        "DATUM_RUNTIME__PDF__TIME_LIMIT": "60",
    }.items():
        monkeypatch.setenv(name, value)
    config = DatumSettings().to_config()
    assert config.pdf.fonts is PdfFonts.STANDARD
    assert (config.pdf.seal.enabled, config.pdf.seal.timestamp, config.pdf.seal.posted_answers) == (True, False, True)
    assert config.pdf.seal.certify is Certify.FORM_FILL
    assert config.pdf.seal.layouts == ("a", "b")
    assert config.pdf.signing.trust_anchors == ("anchors.pem",)
    assert config.pdf.signing.tsa.timeout == timedelta(seconds=4)
    endpoints = config.web.api.endpoints
    assert (endpoints.pdf, endpoints.fill, endpoints.sign, endpoints.verify, endpoints.certificate) == (True,) * 5
    assert int(config.runtime.verify_max_bytes) == 5 * 1024 * 1024
    assert config.runtime.pdf.time_limit == timedelta(seconds=60)
    assert not leaks(repr(config) + config.model_dump_json(), [P12_PASSWORD])


def test_the_generated_schema_names_the_pdf_settings() -> None:
    schema = json.loads((CORE / "src" / "datum_core" / "datum-settings.schema.json").read_text(encoding="utf-8"))
    text = json.dumps(schema)
    for name in (
        "posted_answers",
        "trust_anchors",
        "retired_certificates",
        "verify_max_bytes",
        "certify",
        "pkcs12_file",
    ):
        assert name in text


# -- the floors --------------------------------------------------------------------------------------------------------
def requirement(entries: list[str], name: str) -> str:
    (found,) = [item for item in entries if re.split(r"[<>=\[ ~!]", item, maxsplit=1)[0].lower() == name]
    return found


def test_the_pdf_extra_needs_the_cryptography_that_has_extension_policies_and_the_timestamp_extra() -> None:
    extras = load_toml(CORE / "pyproject.toml")["project"]["optional-dependencies"]
    assert requirement(extras["pdf"], "cryptography") == "cryptography>=45,<51"
    assert "argusvane-datum-core[timestamp]" in extras["pdf"]


def test_the_revocation_extra_pins_the_one_certvalidator_minor_verified_and_brings_the_pdf_extra() -> None:
    extras = load_toml(CORE / "pyproject.toml")["project"]["optional-dependencies"]
    assert requirement(extras["revocation"], "pyhanko-certvalidator") == "pyhanko-certvalidator>=0.33,<0.34"
    assert "argusvane-datum-core[pdf]" in extras["revocation"]


def test_pyhanko_is_in_the_dev_group_as_the_independent_validator() -> None:
    dev = load_toml(ROOT / "pyproject.toml")["dependency-groups"]["dev"]
    assert requirement(dev, "pyhanko").startswith("pyhanko>=")


def test_the_lock_holds_the_certvalidator_at_the_verified_minor() -> None:
    lock = load_toml(ROOT / "uv.lock")
    versions = {item["name"]: item["version"] for item in lock["package"]}
    assert versions["pyhanko-certvalidator"].startswith("0.33.")
    assert "pyhanko" in versions
    assert tuple(int(part) for part in versions["cryptography"].split(".")[:1]) >= (45,)


def test_the_core_distribution_depends_on_neither_library_without_its_extra() -> None:
    dependencies = load_toml(CORE / "pyproject.toml")["project"]["dependencies"]
    assert not [
        item
        for item in dependencies
        if item.split("[")[0].split(">")[0].split("<")[0].split("=")[0].strip().lower()
        in {"cryptography", "pyhanko-certvalidator", "asn1crypto"}
    ]


def test_a_missing_anchor_file_stops_the_start_naming_the_setting() -> None:
    from pdf_support import plain_pdf_datum  # noqa: PLC0415 - starts a Datum

    datum = plain_pdf_datum({"pdf": {"signing": {"trust_anchors": ["/no/such/anchors.pem"]}}})
    with pytest.raises(DatumConfigurationError) as raised:
        datum.start()
    assert "datum.pdf.signing.trust_anchors" in str(raised.value)
    assert not datum.started


def test_a_missing_retired_certificate_file_stops_the_start_naming_the_setting() -> None:
    from pdf_support import plain_pdf_datum  # noqa: PLC0415 - starts a Datum

    datum = plain_pdf_datum({"pdf": {"signing": {"retired_certificates": ["/no/such/retired.pem"]}}})
    with pytest.raises(DatumConfigurationError) as raised:
        datum.start()
    assert "datum.pdf.signing.retired_certificates" in str(raised.value)
