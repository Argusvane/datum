"""The order is contract: one test per step of a builder save, and the cost of a refusal.

    404 > 413 > 409 > 400 > 422 shape > 422 id > 400 changes > 422 numbers > customizers > kernel > validators > store

Every step is placed by the steps around it (a request that fails at two steps answers the earlier one) and by the
trail of the seams it did or did not reach: a refusal before the kernel costs no kernel run, and a refusal anywhere
stores nothing, records no snapshot and publishes no event.
"""

from typing import Any

import pytest
from builder_support import (
    FORM,
    Rig,
    content_of,
    customizer,
    definition,
    finding,
    started_builder,
    validator,
    verdict,
)

from datum_core.builder import (
    CatalogSaved,
    Declined,
    Exists,
    LocaleChanges,
    Malformed,
    NotFound,
    Outdated,
    Refused,
    Saved,
    TooLarge,
    Unavailable,
)
from datum_core.hooks import HookFindings, HookProblem
from datum_core.stores import catalog_etag
from datum_sandbox.json import json_size
from datum_sandbox.protocol import ProgramUnavailableError

STALE = "0" * 64
LONE = "bad \ud800 surrogate"


def codes(outcome: object) -> list[str]:
    assert isinstance(outcome, Refused)
    return [error.code for error in outcome.errors]


def touched_nothing(rig: Rig, *, version: str = "1") -> None:
    """The refusal stored nothing: the repository holds the old version and no snapshot or event was made."""
    assert rig.stored().definition["version"] == version
    assert "repository.replace" not in rig.trail
    assert "repository.create" not in rig.trail
    assert "snapshots.record" not in rig.trail
    assert not any(step.startswith("event:") for step in rig.trail)
    assert rig.events == []


# -- one test per step -------------------------------------------------------------------------------------------------
def test_step_1_a_form_nobody_has_is_not_found_whatever_else_is_wrong_with_the_request() -> None:
    with started_builder({"builder": {"max_definition_size": "1KiB"}}) as rig:
        too_big = definition("nope", label="x" * 5000)
        assert rig.service.save("nope", too_big, expected_sha256=STALE, principal=None) == NotFound("nope")
        assert rig.service.save("not a key!", definition(), expected_sha256=None, principal=None) == NotFound(
            "not a key!"
        )
        assert rig.service.save("a" * 129, definition(), expected_sha256=None, principal=None) == NotFound("a" * 129)
    assert rig.trail == []


def test_step_2_a_definition_over_the_cap_is_too_large_before_the_hash_is_compared() -> None:
    with started_builder({"builder": {"max_definition_size": "1KiB"}}) as rig:
        outcome = rig.save(definition(label="x" * 5000), expected=STALE)
    assert outcome == TooLarge(1024)
    assert rig.trail == []


def test_step_2_the_cap_is_measured_on_the_tree_as_compact_json_and_a_definition_at_the_cap_passes() -> None:
    cap = 1024
    value = definition(label="")
    value["root"]["children"]["content"][0]["configuration"]["label"] = "x" * (cap - json_size(value))
    assert json_size(value) == cap
    with started_builder({"builder": {"max_definition_size": "1KiB"}}) as rig:
        assert isinstance(rig.save(value), Saved)
        value["root"]["children"]["content"][0]["configuration"]["label"] += "x"
        assert rig.save(value) == TooLarge(cap)


def test_step_3_a_stale_hash_is_outdated_before_the_value_is_read_as_json() -> None:
    with started_builder() as rig:
        outcome = rig.save(definition(label=LONE), expected=STALE)
    assert isinstance(outcome, Outdated)
    assert rig.trail == []


def test_step_3_an_absent_expected_hash_saves_as_sent() -> None:
    with started_builder() as rig:
        outcome = rig.save(definition(version="2"), expected=None)
        assert isinstance(outcome, Saved)
        assert rig.stored().definition["version"] == "2"


def test_step_4_a_value_that_is_not_strict_json_is_malformed_before_its_shape_is_judged() -> None:
    with started_builder() as rig:
        outcomes = [
            rig.save(definition("other", label=LONE)),  # a lone surrogate AND an id that is not the form's
            rig.save({"id": FORM, "root": {"id": "form", "type": "form", 1: "an integer key"}}),
            rig.save({"id": FORM, "version": "1", "root": {"id": "form", "type": "form"}, "key\ud800": 1}),
        ]
    assert all(isinstance(outcome, Malformed) for outcome in outcomes)
    assert rig.trail == []


def test_step_5_a_definition_with_no_root_is_refused_by_its_shape_before_the_id_is_compared() -> None:
    with started_builder() as rig:
        broken = definition("other")
        del broken["root"]
        outcome = rig.save(broken)
    assert "definition.root.missing" in codes(outcome)
    assert "definition.id.mismatch" not in codes(outcome)
    assert rig.trail == []


@pytest.mark.parametrize(
    ("mutate", "code"),
    [
        (lambda d: d.update(root={"id": "form", "type": "section"}), "definition.root.type"),
        (lambda d: content_of(d).append({"type": "text", "configuration": {}}), "component.id.invalid"),
        (lambda d: content_of(d).append({"id": "x", "configuration": {}}), "component.type.invalid"),
        (lambda d: d.update(version="v" * 65), "definition.version.tooLong"),
    ],
    ids=["root type", "component without id", "component without type", "version too long"],
)
def test_step_5_the_hosts_own_reading_of_the_shape_refuses_what_the_kernel_would_never_see(
    mutate: Any, code: str
) -> None:
    with started_builder() as rig:
        value = definition()
        mutate(value)
        outcome = rig.save(value)
    assert code in codes(outcome)
    assert rig.trail == []


def test_step_5_a_value_that_is_not_an_object_is_refused_by_its_shape() -> None:
    with started_builder() as rig:
        values: list[object] = [[], "text", 3, 1.5, False]
        outcomes = [rig.save(item) for item in values]
    assert all(isinstance(outcome, Refused) and outcome.code == "definition.refused" for outcome in outcomes)
    assert rig.trail == []


def test_step_5_a_tree_nested_past_the_raw_depth_is_refused_definition_too_deep_without_recursion() -> None:
    with started_builder() as rig:
        value = definition()
        leaf: dict[str, Any] = {}
        value["configuration"] = leaf
        for _ in range(300):
            deeper: dict[str, Any] = {}
            leaf["n"] = deeper
            leaf = deeper
        outcome = rig.save(value)
    assert isinstance(outcome, Refused)
    assert "definition.tooDeep" in codes(outcome)
    assert rig.trail == []


def test_step_5_components_nested_past_the_component_depth_are_refused_definition_too_deep() -> None:
    with started_builder() as rig:
        value = definition()
        node: dict[str, Any] = {"id": "leaf", "type": "text", "configuration": {}}
        for level in range(33):
            node = {"id": f"c{level}", "type": "group", "children": {"content": [node]}}
        content_of(value).append(node)
        outcome = rig.save(value)
    assert "definition.tooDeep" in codes(outcome)
    assert rig.trail == []


def test_step_5_more_components_than_the_floor_allows_is_refused_without_the_kernel() -> None:
    with started_builder({"builder": {"max_definition_size": "64MiB"}}) as rig:
        value = definition()
        content_of(value).extend({"id": f"c{n}", "type": "text", "configuration": {}} for n in range(10_001))
        outcome = rig.save(value)
    assert "definition.tooManyComponents" in codes(outcome)
    assert rig.trail == []


def test_step_5_more_options_than_the_floor_allows_is_refused_without_the_kernel() -> None:
    with started_builder() as rig:
        value = definition()
        options = [{"value": str(n), "label": str(n)} for n in range(2001)]
        content_of(value).append({"id": "pick", "type": "select", "configuration": {"options": options}})
        outcome = rig.save(value)
    assert "option.tooMany" in codes(outcome)
    assert rig.trail == []


def test_step_6_an_id_that_is_not_the_forms_is_refused_definition_id_mismatch() -> None:
    with started_builder() as rig:
        other = rig.save(definition("other"))
        missing = definition()
        del missing["id"]
        absent = rig.save(missing)
    assert "definition.id.mismatch" in codes(other)
    assert "definition.id.mismatch" in codes(absent)
    assert rig.trail == []


@pytest.mark.parametrize("bad", ["not a key", "", "a" * 129, "with/slash", "with@at", 7, None])
def test_step_6_a_create_whose_id_is_no_form_key_is_refused_definition_id_invalid(bad: object) -> None:
    with started_builder() as rig:
        value = definition()
        value["id"] = bad
        outcome = rig.create(value)
    assert "definition.id.invalid" in codes(outcome)
    assert rig.trail == []


def test_step_6_the_id_is_judged_before_the_language_changes_and_the_numbers() -> None:
    with started_builder() as rig:
        value = definition("other")
        value["configuration"] = {"n": float("nan")}
        outcome = rig.save(value, changes=Malformed("bad header"))
    assert "definition.id.mismatch" in codes(outcome)
    assert "definition.number.nonFinite" not in codes(outcome)


def test_step_7_language_changes_that_are_not_valid_are_malformed_after_the_shape_and_before_the_numbers() -> None:
    with started_builder() as rig:
        value = definition()
        value["configuration"] = {"n": float("inf")}
        outcome = rig.save(value, changes=Malformed("The language changes are not valid."))
        assert outcome == Malformed("The language changes are not valid.")
        fine = rig.save(definition(version="2"), changes=LocaleChanges())
    assert isinstance(fine, Saved)


@pytest.mark.parametrize("number", [float("nan"), float("inf"), float("-inf")], ids=["nan", "inf", "-inf"])
def test_step_8_a_number_json_cannot_write_is_refused_definition_number_non_finite(number: float) -> None:
    with started_builder() as rig:
        value = definition()
        content_of(value)[0]["configuration"]["max"] = number
        outcome = rig.save(value)
    assert codes(outcome) == ["definition.number.nonFinite"]
    assert rig.trail == []


def test_step_8_a_finite_number_of_any_size_is_not_refused() -> None:
    with started_builder() as rig:
        value = definition()
        content_of(value)[0]["configuration"]["max"] = 1.7976931348623157e308
        assert isinstance(rig.save(value), Saved)


def test_step_9_customizers_run_after_every_check_above_and_before_the_kernel() -> None:
    trail: list[str] = []
    with started_builder(trail=trail, builder_save_customizers=[customizer("a", trail)]) as rig:
        value = definition()
        value["configuration"] = {"n": float("nan")}
        refused = rig.save(value)
        assert isinstance(refused, Refused)
        assert "customizer:a" not in trail
        trail.clear()
        assert isinstance(rig.save(definition(version="2")), Saved)
        assert trail.index("customizer:a") < trail.index("sandbox.check")


def test_step_10_the_kernel_runs_after_the_customizers_and_before_the_validators() -> None:
    trail: list[str] = []
    hooks: dict[str, Any] = {
        "builder_save_customizers": [customizer("a", trail)],
        "builder_save_validators": [validator("a", trail)],
    }
    with started_builder(trail=trail, **hooks) as rig:
        assert isinstance(rig.save(definition(version="2")), Saved)
        assert trail.index("customizer:a") < trail.index("sandbox.check") < trail.index("validator:a")


def test_step_10_the_kernel_is_asked_about_what_the_customizers_left_and_never_skipped() -> None:
    trail: list[str] = []

    def retitle(draft: Any) -> None:
        draft.definition["title"] = "customized"

    with started_builder(trail=trail, builder_save_customizers=[customizer("a", trail, change=retitle)]) as rig:
        assert isinstance(rig.save(definition(version="2")), Saved)
        asked = rig.sandbox.checks
    assert len(asked) == 1
    assert asked[0][0]["title"] == "customized"


def test_step_10_a_kernel_refusal_stops_the_validators_and_the_store() -> None:
    trail: list[str] = []
    with started_builder(trail=trail, builder_save_validators=[validator("a", trail)]) as rig:
        rig.sandbox.answer = verdict(problems=[finding("pattern.risky")])
        outcome = rig.save(definition(version="2"))
        assert codes(outcome) == ["pattern.risky"]
        assert "validator:a" not in trail
        touched_nothing(rig)


def test_step_10_a_kernel_that_could_not_answer_stops_the_validators_and_the_store() -> None:
    error = ProgramUnavailableError("down")
    trail: list[str] = []
    with started_builder(trail=trail, builder_save_validators=[validator("a", trail)]) as rig:
        rig.sandbox.error = error
        outcome = rig.save(definition(version="2"))
        assert isinstance(outcome, Unavailable)
        assert "validator:a" not in trail
        touched_nothing(rig)


def test_step_11_validators_run_after_the_kernel_and_before_the_store_and_all_of_them_run() -> None:
    trail: list[str] = []
    hooks: dict[str, Any] = {
        "builder_save_validators": [validator("a", trail), validator("b", trail), validator("c", trail)]
    }
    with started_builder(trail=trail, **hooks) as rig:
        assert isinstance(rig.save(definition(version="2")), Saved)
        order = [
            step for step in trail if step.startswith("validator:") or step in {"sandbox.check", "repository.replace"}
        ]
    assert order == ["sandbox.check", "validator:a", "validator:b", "validator:c", "repository.replace"]


def test_step_11_a_validators_error_stops_the_store_but_every_validator_still_runs() -> None:
    trail: list[str] = []
    error = HookFindings(errors=(HookProblem("title", "title.reserved", "Reserved."),))
    hooks: dict[str, Any] = {"builder_save_validators": [validator("a", trail, findings=error), validator("b", trail)]}
    with started_builder(trail=trail, **hooks) as rig:
        outcome = rig.save(definition(version="2"))
        assert isinstance(outcome, Declined)
        assert "validator:a" in trail
        assert "validator:b" in trail
        touched_nothing(rig)


def test_step_12_the_store_is_last_the_repository_then_the_snapshots_then_the_event() -> None:
    with started_builder() as rig:
        assert isinstance(rig.save(definition(version="2")), Saved)
        steps = [s for s in rig.trail if s != "snapshots.record"]
        assert steps == ["sandbox.check", "repository.replace", "event:FormDefinitionSavedEvent"]
        assert rig.trail.index("repository.replace") < rig.trail.index("snapshots.record")
        assert rig.trail.index("snapshots.record") < rig.trail.index("event:FormDefinitionSavedEvent")


def test_step_12_a_create_runs_the_same_steps_with_a_create_for_a_replace() -> None:
    with started_builder() as rig:
        assert isinstance(rig.create(definition("fresh")), Saved)
        steps = [s for s in rig.trail if s != "snapshots.record"]
        assert steps == ["sandbox.check", "repository.create", "event:FormDefinitionSavedEvent"]


def test_step_12_the_catalog_moves_with_the_save_after_the_definition_and_before_the_event() -> None:
    with started_builder() as rig:
        saved = rig.service.save_translations(
            FORM,
            {"fr": {"form": {"title": "un"}}, "de": {"form": {"title": "eins"}}},
            expected_etag=catalog_etag({}),
            principal=None,
        )
        assert isinstance(saved, CatalogSaved)
        rig.trail.clear()
        outcome = rig.save(definition(version="2"), changes=LocaleChanges(removed=("de",)))
        assert isinstance(outcome, Saved)
        assert outcome.removed_locales == ("de",)
        order = [
            s for s in rig.trail if s in {"repository.replace", "translations.write", "event:FormDefinitionSavedEvent"}
        ]
    assert order == ["repository.replace", "translations.write", "event:FormDefinitionSavedEvent"]


# -- a create has its own place for "exists" ---------------------------------------------------------------------------
def test_create_has_no_not_found_and_measures_the_size_first() -> None:
    with started_builder({"builder": {"max_definition_size": "1KiB"}}) as rig:
        big = definition("fresh", label="x" * 5000)
        big["root"]["type"] = "panel"  # not a form root, so the shape would refuse it: the size is judged first
        assert rig.create(big) == TooLarge(1024)
    assert rig.trail == []


def test_create_exists_is_answered_after_the_shape_and_before_the_hooks_the_kernel_and_the_numbers() -> None:
    trail: list[str] = []
    with started_builder(trail=trail, builder_save_customizers=[customizer("a", trail)]) as rig:
        again = definition(FORM, "7")
        again["configuration"] = {"n": float("nan")}
        outcome = rig.create(again, changes=Malformed("bad"))
        assert isinstance(outcome, Exists)
        assert trail == []


def test_create_judges_the_shape_before_it_asks_whether_the_form_exists() -> None:
    with started_builder() as rig:
        broken = definition(FORM)
        del broken["root"]
        outcome = rig.create(broken)
    assert "definition.root.missing" in codes(outcome)


# -- the cost of a refusal ---------------------------------------------------------------------------------------------
def _stale(rig: Rig) -> Any:
    return rig.save(definition(version="2"), expected=STALE)


def _lone(rig: Rig) -> Any:
    return rig.save(definition(label=LONE))


def _mismatch(rig: Rig) -> Any:
    return rig.save(definition("other"))


def _changes(rig: Rig) -> Any:
    return rig.save(definition(version="2"), changes=Malformed("bad"))


def _nan(rig: Rig) -> Any:
    value = definition(version="2")
    value["configuration"] = {"n": float("nan")}
    return rig.save(value)


@pytest.mark.parametrize("refuse", [_stale, _lone, _mismatch, _changes, _nan], ids=lambda f: f.__name__.strip("_"))
def test_a_refusal_before_the_kernel_costs_no_kernel_run_stores_nothing_and_publishes_nothing(refuse: Any) -> None:
    with started_builder() as rig:
        outcome = refuse(rig)
        assert not isinstance(outcome, Saved)
        assert rig.sandbox.checks == []
        touched_nothing(rig)


@pytest.mark.parametrize(
    "answer",
    [
        verdict(problems=[finding("pattern.risky")]),
        verdict(structure=[finding("component.id.duplicate", "root > content > name")]),
    ],
    ids=["formula problem", "structure refusal"],
)
def test_a_kernel_refusal_stores_nothing_and_publishes_nothing(answer: dict[str, Any]) -> None:
    with started_builder() as rig:
        rig.sandbox.answer = answer
        outcome = rig.save(definition(version="2"))
        assert isinstance(outcome, Refused)
        assert len(rig.sandbox.checks) == 1
        touched_nothing(rig)


def test_kernel_warnings_do_not_refuse_and_ride_back() -> None:
    with started_builder() as rig:
        rig.sandbox.answer = verdict(
            warnings=[finding("formula.odd", "rules:name:visibleWhen")],
            structure_warnings=[finding("component.type.unknown", "root > content > name")],
        )
        outcome = rig.save(definition(version="2"))
    assert isinstance(outcome, Saved)
    assert {w.code for w in outcome.kernel_warnings} == {"formula.odd", "component.type.unknown"}


def test_the_kernel_is_asked_once_per_save_and_only_about_the_form_being_saved() -> None:
    with started_builder(seed=[definition(), definition("claims", "4")]) as rig:
        assert isinstance(rig.save(definition(version="2")), Saved)
    assert len(rig.sandbox.checks) == 1
    assert rig.sandbox.checks[0][0]["id"] == FORM


def test_an_unchanged_definition_is_saved_again_like_any_other_and_keeps_its_hash() -> None:
    with started_builder() as rig:
        before = rig.current_hash()
        outcome = rig.save(definition())
        assert isinstance(outcome, Saved)
        assert outcome.sha256 == before
        assert rig.current_hash() == before
