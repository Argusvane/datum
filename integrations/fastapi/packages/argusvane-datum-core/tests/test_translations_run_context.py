"""The definition's translation map rides in a validation run's context and in a PDF job.

The kernel reads the run context, never the definition, so `sandbox_run` copies `definition.translations` into the
context when the stored definition has one, and `PdfService` sends it as `formTranslations`. The last test (marker
`runtime`) drives the real sandbox: a French `patternMessage` answers a `fr-CA` run. (The submission service
never relays the kernel's words, so that test reads the sandbox's own verdict.)
"""

from collections.abc import Iterator
from typing import TYPE_CHECKING, Any

import pytest
from pdf_support import ScriptedPdfRuntime, pdf_definition, started_pdf
from submissions_support import Repository, bus, definition, envelope, journey_check, started

from datum_core import Datum, DatumConfig
from datum_core.stores.memory import MemoryTranslationCatalogStore
from datum_core.submissions import FormRef, Unavailable

if TYPE_CHECKING:
    from datum_sandbox.json import JsonValue

FR_CA = {
    "fr-CA": {
        "components": {
            "name": {"patternMessage": {"text": "Entrez des lettres seulement.", "source": "h"}},
        }
    }
}


def with_map(form: dict[str, Any]) -> dict[str, Any]:
    return {**form, "translations": FR_CA}


def test_a_validation_run_carries_the_definitions_map_in_its_context() -> None:
    trail: list[str] = []
    with started(form_repository=Repository(trail, with_map(definition()))) as rig:
        rig.submit(envelope(), bus())
        (context, _rules, _real) = rig.sandbox.validations[-1]
    assert context["translations"] == FR_CA


def test_a_validation_run_of_a_definition_without_a_map_carries_no_key() -> None:
    trail: list[str] = []
    with started(form_repository=Repository(trail, definition())) as rig:
        rig.submit(envelope(), bus())
        (context, _rules, _real) = rig.sandbox.validations[-1]
    assert "translations" not in context


HOST_CATALOG = {"fr-CA": {"components": {"code": {"patternMessage": "C"}}}}


def test_a_validation_run_carries_the_stored_host_catalog_beside_the_map() -> None:
    """The kernel reads the host catalog before the map under one tag."""
    store = MemoryTranslationCatalogStore(10)
    store.put("contact", HOST_CATALOG)
    trail: list[str] = []
    with started(form_repository=Repository(trail, with_map(definition())), translation_store=store) as rig:
        rig.submit(envelope(), bus())
        (context, _rules, _real) = rig.sandbox.validations[-1]
    assert context["catalog"] == HOST_CATALOG
    assert context["translations"] == FR_CA


def test_a_validation_run_with_an_empty_or_no_host_catalog_carries_no_catalog_key() -> None:
    trail: list[str] = []
    with started(form_repository=Repository(trail, definition())) as rig:
        rig.submit(envelope(), bus())
        (context, _rules, _real) = rig.sandbox.validations[-1]
    assert "catalog" not in context
    store = MemoryTranslationCatalogStore(10)
    store.put("contact", {})
    with started(form_repository=Repository(trail, definition()), translation_store=store) as rig:
        rig.submit(envelope(), bus())
        (context, _rules, _real) = rig.sandbox.validations[-1]
    assert "catalog" not in context


class RaisingStore:
    health_name = "stores.translations"

    def read(self, key: str) -> None:
        raise RuntimeError("the catalog store is down")


def test_a_store_that_raises_is_the_typed_unavailable_outcome_on_submit_and_validate() -> None:
    trail: list[str] = []
    with started(form_repository=Repository(trail, definition()), translation_store=RaisingStore()) as rig:
        submitted = rig.submit(envelope(), bus())
        validated = rig.service.validate(FormRef.from_document(), journey_check(envelope()), bus())
        assert rig.sandbox.validations == []
    for outcome in (submitted, validated):
        assert isinstance(outcome, Unavailable)
        assert outcome.code == "server.unavailable"


def test_a_pdf_job_carries_the_definitions_map_as_form_translations() -> None:
    with started_pdf(form=with_map(pdf_definition())) as rig:
        rig.render()
        runtime: ScriptedPdfRuntime = rig.runtime
        (request,) = runtime.requests("document")
    assert request["formTranslations"] == FR_CA
    assert "translations" not in request  # no host catalog is stored for this form


def test_a_pdf_job_carries_the_stored_host_catalog_beside_the_form_map() -> None:
    catalog = {"fr-CA": {"form": {"title": "Titre"}}}
    store = MemoryTranslationCatalogStore(10)
    store.put("contact", catalog)
    with started_pdf(form=with_map(pdf_definition()), translation_store=store) as rig:
        rig.render()
        (request,) = rig.runtime.requests("document")
    assert request["formTranslations"] == FR_CA
    assert request["translations"] == catalog


def test_a_pdf_job_of_a_definition_without_a_map_carries_no_key() -> None:
    with started_pdf(form=pdf_definition()) as rig:
        rig.render()
        (request,) = rig.runtime.requests("document")
    assert "formTranslations" not in request


PATTERNED: dict[str, Any] = {
    "id": "patterned",
    "version": "1",
    "root": {
        "id": "root",
        "type": "form",
        "configuration": {},
        "children": {
            "content": [
                {
                    "id": "name",
                    "type": "text",
                    "configuration": {"label": "Name", "pattern": "^[A-Za-z]+$", "patternMessage": "Letters only."},
                }
            ]
        },
    },
    "translations": FR_CA,
}


@pytest.fixture
def real_datum(request: pytest.FixtureRequest) -> Iterator[Datum]:
    if hasattr(request.config, "workerinput"):
        pytest.skip("tests marked runtime never run under xdist: run them in one process")
    datum = Datum(config=DatumConfig.model_validate({"runtime": {"warm_up_runs": 1}}))
    datum.start()
    try:
        yield datum
    finally:
        datum.stop()


@pytest.mark.runtime
def test_the_real_sandbox_answers_the_french_pattern_message_for_a_fr_ca_run(real_datum: Datum) -> None:
    messages: dict[str, str] = {}
    for locale in ("en", "fr-CA"):
        context: dict[str, JsonValue] = {
            "formId": "patterned",
            "form": PATTERNED["root"],
            "values": {"name": "123"},
            "locale": locale,
            "translations": PATTERNED["translations"],
        }
        errors = real_datum.sandbox.validate(context, real=False).outcome["errors"]
        assert isinstance(errors, list)
        (error,) = errors
        assert isinstance(error, dict)
        parameters = error["parameters"]
        assert isinstance(parameters, dict)
        messages[locale] = str(parameters["message"])
    assert messages["en"] == "Letters only."
    assert messages["fr-CA"] == "Entrez des lettres seulement."


CODED: dict[str, Any] = {
    "id": "coded",
    "version": "1",
    "root": {
        "id": "root",
        "type": "form",
        "configuration": {},
        "children": {
            "content": [
                {
                    "id": "code",
                    "type": "text",
                    "configuration": {"label": "Code", "pattern": "^[A-Za-z]+$", "patternMessage": "Letters only."},
                }
            ]
        },
    },
    "translations": {"fr-CA": {"components": {"code": {"patternMessage": {"text": "F", "source": "h"}}}}},
}


@pytest.mark.runtime
@pytest.mark.parametrize(("catalog", "expected"), [(HOST_CATALOG, "C"), ({}, "F")])
def test_the_real_sandbox_words_the_message_from_the_store_catalog_before_the_map(
    real_datum: Datum, catalog: dict[str, Any], expected: str
) -> None:
    """The context the service builds (catalog from the memory store, map from the definition) reaches the kernel."""
    store = MemoryTranslationCatalogStore(10)
    store.put("contact", catalog)
    trail: list[str] = []
    with started(form_repository=Repository(trail, definition()), translation_store=store) as rig:
        rig.submit(envelope(), bus())
        (sent, _rules, _real) = rig.sandbox.validations[-1]
    context: dict[str, JsonValue] = {
        "formId": "coded",
        "form": CODED["root"],
        "values": {"code": "123"},
        "locale": "fr-CA",
        "translations": CODED["translations"],
    }
    if "catalog" in sent:
        context["catalog"] = sent["catalog"]
    errors = real_datum.sandbox.validate(context, real=False).outcome["errors"]
    assert isinstance(errors, list)
    (error,) = errors
    assert isinstance(error, dict)
    parameters = error["parameters"]
    assert isinstance(parameters, dict)
    assert parameters["message"] == expected
