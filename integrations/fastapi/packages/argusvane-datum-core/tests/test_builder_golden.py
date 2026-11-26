"""The builder against the real engine (marker `runtime`): the kit's BLD vectors through `BuilderService`.

The public row is the last test.
row.

The kernel's `check` is the judge: the fixture form is accepted unchanged; a risky pattern is refused with the kernel's
code and its `where` (BLD-03); a duplicate id is refused (BLD-03); an unknown component type is a warning, not a
refusal; a definition nested too deep is refused before any guest runs; and the author's copy of a form with a
server-secret rule keeps it while the public copy the real kernel makes does not.
"""

import copy
from collections.abc import Iterator
from typing import Any

import pytest

from datum_core import Datum, DatumConfig
from datum_core.builder import Refused, Saved
from datum_core.forms import Served
from datum_core.stores.memory import MemoryFormDefinitionRepository
from datum_sandbox.testing.fixtures import endpoint_form

pytestmark = pytest.mark.runtime

FORM_ID = "datum-security-suite"
RISKY = 'matches(name, "(a|a?)+")'


def content(definition: dict[str, Any]) -> list[dict[str, Any]]:
    found = definition["root"]["children"]["content"]
    assert isinstance(found, list)
    return found


@pytest.fixture
def real_datum(request: pytest.FixtureRequest) -> Iterator[Datum]:
    if hasattr(request.config, "workerinput"):
        pytest.skip("tests marked runtime never run under xdist: run them in one process")
    form = endpoint_form()
    datum = Datum(
        config=DatumConfig.model_validate({"builder": {"enabled": True}, "runtime": {"warm_up_runs": 1}}),
        form_repository=MemoryFormDefinitionRepository(seed=[form]),
    )
    datum.start()
    try:
        yield datum
    finally:
        datum.stop()


def current(datum: Datum) -> str:
    served = datum.definition_service.read(FORM_ID, public=False)
    assert isinstance(served, Served)
    return served.etag.strip('"')


def test_the_kits_form_is_accepted_unchanged_by_the_real_kernel(real_datum: Datum) -> None:
    form = endpoint_form()
    outcome = real_datum.builder_service.save(FORM_ID, form, expected_sha256=current(real_datum), principal=None)
    assert isinstance(outcome, Saved), outcome
    assert outcome.created is False


def test_a_new_version_is_saved_and_its_hash_is_the_next_author_copys_etag(real_datum: Datum) -> None:
    form = endpoint_form()
    form["version"] = "tck-2"
    outcome = real_datum.builder_service.save(FORM_ID, form, expected_sha256=current(real_datum), principal=None)
    assert isinstance(outcome, Saved), outcome
    assert outcome.version == "tck-2"
    assert current(real_datum) == outcome.sha256


def test_a_risky_pattern_is_refused_with_the_kernels_code_and_where_and_nothing_is_stored(real_datum: Datum) -> None:
    before = current(real_datum)
    form = endpoint_form()
    content(form).append(
        {
            "id": "tckfx",
            "type": "text",
            "configuration": {},
            "rules": {"visibleWhen": {"run": "both", "formula": RISKY}},
        }
    )
    outcome = real_datum.builder_service.save(FORM_ID, form, expected_sha256=before, principal=None)
    assert isinstance(outcome, Refused), outcome
    assert outcome.code == "definition.refused"
    assert outcome.errors[0].code == "pattern.risky"
    assert outcome.errors[0].field == "rules:tckfx:visibleWhen"
    assert current(real_datum) == before


def test_two_components_with_one_id_are_refused_component_id_duplicate(real_datum: Datum) -> None:
    before = current(real_datum)
    form = endpoint_form()
    content(form).extend({"id": "tckdup", "type": "text", "configuration": {}} for _ in range(2))
    outcome = real_datum.builder_service.save(FORM_ID, form, expected_sha256=before, principal=None)
    assert isinstance(outcome, Refused), outcome
    assert "component.id.duplicate" in [error.code for error in outcome.errors]
    assert current(real_datum) == before


def test_an_unknown_component_type_is_a_warning_the_real_kernel_reports_not_a_refusal(real_datum: Datum) -> None:
    form = endpoint_form()
    content(form).append({"id": "mystery", "type": "no-such-type", "configuration": {}})
    outcome = real_datum.builder_service.save(FORM_ID, form, expected_sha256=current(real_datum), principal=None)
    assert isinstance(outcome, Saved), outcome
    assert "component.type.unknown" in [warning.code for warning in outcome.kernel_warnings]


def test_a_definition_nested_past_the_component_depth_is_refused_too_deep_before_any_guest_runs(
    real_datum: Datum,
) -> None:
    form = endpoint_form()
    node: dict[str, Any] = {"id": "leaf", "type": "text", "configuration": {}}
    for level in range(40):
        node = {"id": f"c{level}", "type": "group", "children": {"content": [node]}}
    content(form).append(node)
    outcome = real_datum.builder_service.save(FORM_ID, form, expected_sha256=current(real_datum), principal=None)
    assert isinstance(outcome, Refused), outcome
    assert "definition.tooDeep" in [error.code for error in outcome.errors] or outcome.code == "definition.tooDeep"


def test_a_create_of_the_fixtures_id_is_exists_with_the_current_hash(real_datum: Datum) -> None:
    outcome = real_datum.builder_service.create(endpoint_form(), principal=None)
    assert type(outcome).__name__ == "Exists"
    assert getattr(outcome, "current_sha256") == current(real_datum)  # noqa: B009


def test_the_author_copy_keeps_a_server_secret_rule_and_the_real_kernels_public_copy_does_not(
    real_datum: Datum,
) -> None:
    form = copy.deepcopy(endpoint_form())
    content(form).append(
        {
            "id": "hidden",
            "type": "text",
            "configuration": {},
            "rules": {"requiredWhen": {"run": "server-secret", "formula": 'name = "ZZSECRETZZ"'}},
        }
    )
    outcome = real_datum.builder_service.save(FORM_ID, form, expected_sha256=current(real_datum), principal=None)
    assert isinstance(outcome, Saved), outcome
    author = real_datum.definition_service.read(FORM_ID, public=False)
    public = real_datum.definition_service.read(FORM_ID)
    assert isinstance(author, Served)
    assert isinstance(public, Served)
    assert b"ZZSECRETZZ" in author.body
    assert b"ZZSECRETZZ" not in public.body
    assert author.etag == '"' + outcome.sha256 + '"'
