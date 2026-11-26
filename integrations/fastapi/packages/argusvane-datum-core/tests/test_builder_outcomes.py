"""The builder's twelve outcome variants: the records, and one test per variant that produces it.

The outcomes are frozen, slotted records with no header and no status; `datum_core.http.builder` maps each.
"""

import dataclasses
import typing
from datetime import datetime
from typing import Any

import pytest
from builder_support import (
    FIXED_NOW,
    FORM,
    MARKER,
    PRINCIPAL,
    CheckSandbox,
    definition,
    finding,
    started_builder,
    verdict,
)

from datum_core.builder import (
    BuilderOutcome,
    CatalogOutdated,
    CatalogSaved,
    Declined,
    Exists,
    Malformed,
    NotFound,
    Outdated,
    ReadOnly,
    Refused,
    Saved,
    TooLarge,
    Unavailable,
)
from datum_core.canonical import canonical_digest
from datum_core.forms import StoredDefinition
from datum_core.hooks import HookProblem, HookRefusedError, HookRefusedKind
from datum_core.stores import catalog_etag
from datum_sandbox.json import JsonValue
from datum_sandbox.protocol import (
    DefinitionTooCostlyError,
    DefinitionTooDeepError,
    ProgramUnavailableError,
    SandboxError,
)
from datum_sandbox.protocol._errors import SandboxFailure

VARIANTS = (
    Saved,
    CatalogSaved,
    Outdated,
    CatalogOutdated,
    Refused,
    ReadOnly,
    Exists,
    NotFound,
    Malformed,
    TooLarge,
    Unavailable,
    Declined,
)
FIELDS = {
    "Saved": (
        "key",
        "sha256",
        "version",
        "removed_locales",
        "catalog",
        "warnings",
        "kernel_warnings",
        "created",
        "saved_at",
    ),
    "CatalogSaved": ("key", "etag", "catalog", "saved_at"),
    "Outdated": ("current_sha256", "current_version"),
    "CatalogOutdated": ("current_etag",),
    "Refused": ("code", "errors", "cause"),
    "ReadOnly": ("cause",),
    "Exists": ("key", "current_sha256"),
    "NotFound": ("key",),
    "Malformed": ("reason",),
    "TooLarge": ("max_bytes",),
    "Unavailable": ("code", "reason", "cause"),
    "Declined": ("refusal",),
}


def name_of(outcome: BuilderOutcome) -> str:
    """Name the variant (the exhaustive `match` with `assert_never` is the typing case's)."""
    assert type(outcome) in VARIANTS
    return type(outcome).__name__


# -- the records -------------------------------------------------------------------------------------------------------
def test_the_union_is_exactly_the_twelve_variants() -> None:
    members = typing.get_args(BuilderOutcome.__value__)
    assert set(members) == set(VARIANTS)
    assert len(members) == 12


@pytest.mark.parametrize("variant", VARIANTS, ids=lambda v: v.__name__)
def test_each_variant_is_a_frozen_slotted_record_with_the_record_fields(variant: type) -> None:
    assert dataclasses.is_dataclass(variant)
    assert tuple(f.name for f in dataclasses.fields(variant)) == FIELDS[variant.__name__]
    assert "__slots__" in vars(variant)
    params = getattr(variant, "__dataclass_params__")  # noqa: B009 - the record's own flags
    assert params.frozen is True


@pytest.mark.parametrize("variant", VARIANTS, ids=lambda v: v.__name__)
def test_no_variant_carries_a_status_or_a_header(variant: type) -> None:
    names = {f.name.lower() for f in dataclasses.fields(variant)}
    assert not names & {"status", "headers", "header", "etag_header", "http_status", "response"}


def test_an_outcome_cannot_be_changed_after_it_was_made() -> None:
    outcome = NotFound("contact")
    with pytest.raises(dataclasses.FrozenInstanceError):
        setattr(outcome, "key", "other")  # noqa: B010 - the assignment is the point


# -- Saved -------------------------------------------------------------------------------------------------------------
def test_a_save_is_saved_with_the_hash_of_what_was_stored_and_the_clocks_second() -> None:
    sent = definition(version="2", label="Full name")
    with started_builder() as rig:
        outcome = rig.save(sent)
        assert isinstance(outcome, Saved)
        assert name_of(outcome) == "Saved"
        assert (outcome.key, outcome.version, outcome.created) == (FORM, "2", False)
        assert outcome.sha256 == canonical_digest(sent) == rig.current_hash()
        assert outcome.saved_at == FIXED_NOW
        assert isinstance(outcome.saved_at, datetime)
        assert outcome.removed_locales == ()
        assert outcome.catalog == {}
        assert outcome.warnings == ()
        assert outcome.kernel_warnings == ()


def test_a_create_is_saved_with_created_true_and_no_expected_hash() -> None:
    sent = definition("fresh", "1")
    with started_builder() as rig:
        outcome = rig.create(sent)
        assert isinstance(outcome, Saved)
        assert (outcome.key, outcome.created, outcome.version) == ("fresh", True, "1")
        assert outcome.sha256 == canonical_digest(sent) == rig.current_hash("fresh")


def test_the_version_is_empty_for_a_definition_that_has_none() -> None:
    sent = definition()
    del sent["version"]
    with started_builder() as rig:
        outcome = rig.save(sent)
        assert isinstance(outcome, Saved)
        assert outcome.version == ""


def test_the_kernels_structure_warnings_come_back_as_kernel_warnings_with_their_where() -> None:
    with started_builder() as rig:
        rig.sandbox.answer = verdict(
            structure_warnings=[finding("component.type.unknown", "root > content > name", "Unknown type.")],
            warnings=[finding("formula.suspicious", "rules:name:visibleWhen", "Looks odd.")],
        )
        outcome = rig.save()
        assert isinstance(outcome, Saved)
        codes = {warning.code: warning.field for warning in outcome.kernel_warnings}
        assert codes["component.type.unknown"] == "root > content > name"
        assert all(isinstance(warning, HookProblem) for warning in outcome.kernel_warnings)


def test_a_kernel_findings_where_is_cut_at_256_characters() -> None:
    with started_builder() as rig:
        rig.sandbox.answer = verdict(warnings=[finding("formula.suspicious", "rules:" + "x" * 400)])
        outcome = rig.save()
        assert isinstance(outcome, Saved)
        assert [
            len(warning.field or "") for warning in outcome.kernel_warnings if warning.code == "formula.suspicious"
        ] == [256]


def test_the_saved_record_holds_the_catalog_after_the_save() -> None:
    with started_builder() as rig:
        assert isinstance(
            rig.service.save_translations(
                FORM, {"fr": {"components": {"name": {"label": "Nom"}}}}, expected_etag=catalog_etag({}), principal=None
            ),
            CatalogSaved,
        )
        outcome = rig.save()
        assert isinstance(outcome, Saved)
        assert outcome.catalog == {"fr": {"components": {"name": {"label": "Nom"}}}}


# -- CatalogSaved ------------------------------------------------------------------------------------------------------
def test_a_catalog_write_is_catalog_saved_with_its_etag_normalised_text_and_the_clocks_second() -> None:
    with started_builder() as rig:
        outcome = rig.service.save_translations(
            FORM,
            {"fr": {"components": {"name": {"label": "Nom", "description": "   "}, "city": {"label": "Ville"}}}},
            expected_etag=catalog_etag({}),
            principal=None,
        )
        assert isinstance(outcome, CatalogSaved)
        assert name_of(outcome) == "CatalogSaved"
        assert outcome.key == FORM
        assert outcome.catalog == {"fr": {"components": {"city": {"label": "Ville"}, "name": {"label": "Nom"}}}}
        assert outcome.etag == catalog_etag(outcome.catalog)
        assert outcome.saved_at == FIXED_NOW
        stored = rig.translations.read(FORM)
        assert stored is not None
        assert stored.etag == outcome.etag


# -- Outdated and CatalogOutdated --------------------------------------------------------------------------------------
def test_a_stale_hash_is_outdated_naming_the_current_hash_and_version() -> None:
    with started_builder() as rig:
        outcome = rig.save(definition(version="9"), expected="0" * 64)
        assert isinstance(outcome, Outdated)
        assert name_of(outcome) == "Outdated"
        assert outcome.current_sha256 == rig.current_hash()
        assert outcome.current_version == "1"
        assert rig.stored().definition["version"] == "1"  # nothing was stored


def test_a_stale_catalog_etag_is_catalog_outdated_naming_the_current_etag() -> None:
    with started_builder() as rig:
        first = rig.service.save_translations(
            FORM, {"fr": {"form": {"title": "un"}}}, expected_etag=catalog_etag({}), principal=None
        )
        assert isinstance(first, CatalogSaved)
        outcome = rig.service.save_translations(
            FORM, {"fr": {"form": {"title": "deux"}}}, expected_etag=catalog_etag({}), principal=None
        )
        assert isinstance(outcome, CatalogOutdated)
        assert name_of(outcome) == "CatalogOutdated"
        assert outcome.current_etag == first.etag


# -- Refused -----------------------------------------------------------------------------------------------------------
def test_a_definition_the_kernel_refuses_is_refused_with_one_error_per_finding_in_the_kernels_order() -> None:
    with started_builder() as rig:
        rig.sandbox.answer = verdict(
            problems=[finding("pattern.risky", "rules:fx:visibleWhen", "A risky pattern.")],
            structure=[finding("component.id.duplicate", "root > content > dup", "Duplicate id.")],
        )
        outcome = rig.save()
        assert isinstance(outcome, Refused)
        assert name_of(outcome) == "Refused"
        assert outcome.code == "definition.refused"
        assert [(e.code, e.field) for e in outcome.errors] == [
            ("pattern.risky", "rules:fx:visibleWhen"),
            ("component.id.duplicate", "root > content > dup"),
        ]
        assert outcome.cause is None


def test_a_definition_too_deep_for_the_kernel_is_refused_definition_too_deep_with_its_cause() -> None:
    with started_builder() as rig:
        error = DefinitionTooDeepError(32, "too deep")
        rig.sandbox.error = error
        outcome = rig.save()
        assert isinstance(outcome, Refused)
        assert outcome.code == "definition.tooDeep"
        assert outcome.cause is error
        assert [e.code for e in outcome.errors] == ["definition.tooDeep"]


def test_a_definition_the_kernel_could_not_afford_is_refused_definition_too_costly_with_its_cause() -> None:
    with started_builder() as rig:
        stop = SandboxError(SandboxFailure.BUDGET, "budget", guest_stopped=True)
        error = DefinitionTooCostlyError(stop)
        rig.sandbox.error = error
        outcome = rig.save()
        assert isinstance(outcome, Refused)
        assert outcome.code == "definition.tooCostly"
        assert outcome.cause is error


def test_a_catalog_that_is_not_a_catalog_is_refused_catalog_invalid() -> None:
    with started_builder() as rig:
        outcome = rig.service.save_translations(
            FORM, {"k": "not a table of locales"}, expected_etag=catalog_etag({}), principal=None
        )
        assert isinstance(outcome, Refused)
        assert outcome.code == "catalog.invalid"
        assert outcome.errors
        assert {e.code for e in outcome.errors} == {"catalog.invalid"}


# -- ReadOnly ----------------------------------------------------------------------------------------------------------
class ReadOnlyRepository:
    """What a repository that cannot save looks like: it answers `current` and has no write."""

    def __init__(self, *forms: dict[str, Any]) -> None:
        self.forms = {form["id"]: form for form in forms}

    def current(self, key: str) -> StoredDefinition | None:
        form = self.forms.get(key)
        return None if form is None else StoredDefinition(key, form, canonical_digest(form))


def test_a_repository_that_cannot_save_answers_read_only_for_a_save_and_a_create() -> None:
    form = definition()
    repository = ReadOnlyRepository(form)
    with started_builder(form_repository=repository) as rig:
        saved = rig.service.save(FORM, definition(version="2"), expected_sha256=canonical_digest(form), principal=None)
        created = rig.service.create(definition("fresh"), principal=None)
        missing = rig.service.save("nope", definition("nope"), expected_sha256=None, principal=None)
        assert missing == NotFound("nope")
        assert rig.sandbox.checks == []
        assert rig.trail == []
    for outcome in (saved, created):
        assert isinstance(outcome, ReadOnly)
        assert name_of(outcome) == "ReadOnly"
    assert repository.forms[FORM] == definition()


# -- Exists, NotFound, Malformed, TooLarge -----------------------------------------------------------------------------
def test_creating_an_id_that_exists_answers_exists_with_the_current_hash() -> None:
    with started_builder() as rig:
        outcome = rig.create(definition(FORM, "7"))
        assert isinstance(outcome, Exists)
        assert name_of(outcome) == "Exists"
        assert (outcome.key, outcome.current_sha256) == (FORM, rig.current_hash())


def test_saving_a_form_nobody_created_answers_not_found_with_the_key_as_named() -> None:
    with started_builder() as rig:
        outcome = rig.service.save("nope", definition("nope"), expected_sha256=None, principal=None)
        assert outcome == NotFound("nope")
        assert name_of(outcome) == "NotFound"


def test_a_value_that_is_not_json_is_malformed_with_a_reason_that_quotes_no_text() -> None:
    with started_builder() as rig:
        outcome = rig.save(definition(label="bad \ud800 text " + MARKER))
        assert isinstance(outcome, Malformed)
        assert name_of(outcome) == "Malformed"
        assert outcome.reason
        assert MARKER not in outcome.reason


def test_a_definition_over_the_cap_is_too_large_with_the_cap_in_bytes() -> None:
    with started_builder({"builder": {"max_definition_size": "1KiB"}}) as rig:
        outcome = rig.save(definition(label="x" * 5000))
        assert outcome == TooLarge(1024)
        assert name_of(outcome) == "TooLarge"


# -- Unavailable and Declined ------------------------------------------------------------------------------------------
def test_a_kernel_that_cannot_answer_is_unavailable_and_nothing_is_stored() -> None:
    with started_builder() as rig:
        error = ProgramUnavailableError("the runtime is down")
        rig.sandbox.error = error
        before = rig.current_hash()
        outcome = rig.save(definition(version="5"))
        assert isinstance(outcome, Unavailable)
        assert name_of(outcome) == "Unavailable"
        assert (outcome.code, outcome.cause) == ("server.unavailable", error)
        assert outcome.reason
        assert rig.current_hash() == before


@pytest.mark.parametrize(
    "answer",
    [
        {"ok": True, "op": "check"},
        {"ok": True, "op": "check", "problems": [], "warnings": [], "structure": []},
        {"ok": True, "op": "check", "problems": "none", "warnings": [], "structure": [], "structureWarnings": []},
        {"ok": True, "op": "check", "problems": [], "warnings": [], "structure": [], "structureWarnings": None},
        {
            "ok": True,
            "op": "check",
            "problems": [],
            "warnings": [],
            "structure": [],
            "structureWarnings": [],
            "verdict": "fail",
        },
        {"ok": True, "op": "check", "problems": ["risky"], "warnings": [], "structure": [], "structureWarnings": []},
        {
            "ok": True,
            "op": "check",
            "problems": [{"code": "1 not a code"}],
            "warnings": [],
            "structure": [],
            "structureWarnings": [],
        },
        {
            "ok": True,
            "op": "check",
            "problems": [],
            "warnings": [{"where": "root"}],
            "structure": [],
            "structureWarnings": [],
        },
    ],
    ids=[
        "empty",
        "no structure warnings",
        "problems not a list",
        "structure warnings null",
        "a failing verdict naming no finding",
        "a finding that is not an object",
        "a finding whose code is outside the alphabet",
        "a warning with no code",
    ],
)
def test_an_answer_with_no_verdict_is_never_read_as_no_problems(answer: dict[str, JsonValue]) -> None:
    with started_builder() as rig:
        rig.sandbox.answer = answer
        before = rig.current_hash()
        outcome = rig.save(definition(version="5"))
        assert isinstance(outcome, Unavailable)
        assert rig.current_hash() == before


def test_a_hook_that_refuses_is_declined_with_its_refusal_as_it_made_it() -> None:
    refusal = HookRefusedError.forbidden("save.notYours", "Not yours to change.")
    with started_builder(builder_save_customizers=[_refusing(refusal)]) as rig:
        outcome = rig.save()
        assert isinstance(outcome, Declined)
        assert name_of(outcome) == "Declined"
        assert outcome.refusal is refusal
        assert outcome.refusal.kind is HookRefusedKind.FORBIDDEN


def _refusing(refusal: HookRefusedError) -> Any:
    def customize(draft: object) -> None:
        raise refusal

    return customize


# -- the union is closed -----------------------------------------------------------------------------------------------
def test_every_variant_is_made_by_the_service_and_none_other_comes_back() -> None:
    seen: set[str] = set()
    with started_builder() as rig:
        seen.add(name_of(rig.save()))
        seen.add(name_of(rig.save(expected="0" * 64)))
        seen.add(name_of(rig.service.save("nope", definition("nope"), expected_sha256=None, principal=None)))
        seen.add(name_of(rig.create(definition(FORM))))
        seen.add(name_of(rig.save(definition(FORM) | {"root": 1})))
        seen.add(name_of(rig.save(definition(label="\ud800"))))
        seen.add(name_of(rig.service.save_translations(FORM, {}, expected_etag=catalog_etag({}), principal=PRINCIPAL)))
        seen.add(
            name_of(rig.service.save_translations(FORM, {}, expected_etag='"' + "1" * 64 + '"', principal=PRINCIPAL))
        )
        seen.add(name_of(rig.service.save_translations(FORM, [], expected_etag=None, principal=PRINCIPAL)))
        seen.add(name_of(_unavailable(rig)))
    with started_builder({"builder": {"max_definition_size": "1KiB"}}) as rig:
        seen.add(name_of(rig.save(definition(label="x" * 5000))))
    assert {"Saved", "Outdated", "NotFound", "Exists", "Refused", "Malformed", "CatalogSaved"} <= seen
    assert {"CatalogOutdated", "Unavailable", "TooLarge"} <= seen


def _unavailable(rig: Any) -> BuilderOutcome:
    sandbox: CheckSandbox = rig.sandbox
    sandbox.error = ProgramUnavailableError("down")
    outcome: BuilderOutcome = rig.save(definition(version="3"))
    sandbox.error = None
    return outcome
