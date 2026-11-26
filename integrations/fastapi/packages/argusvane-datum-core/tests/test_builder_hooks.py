"""The builder's hooks: `builder_save_customizers` before the kernel, `builder_save_validators`
after it.

Order; the refusal kinds and what `Declined` carries; a raise reaching the caller as raised with nothing stored; a
changed `id` failing the save; what a customizer leaves held to the same rules again; what a validator is told. The
hooks are the application's: the service passes it the principal and decides nothing by it.
"""

import copy
from typing import Any, cast

import pytest
from builder_support import (
    FORM,
    MARKER,
    PRINCIPAL,
    content_of,
    customizer,
    definition,
    finding,
    plain_builder_datum,
    started_builder,
    validator,
    verdict,
    with_awaiter,
)

from datum_core.builder import (
    BuilderSaveCandidate,
    BuilderSaveDraft,
    CatalogSaved,
    Declined,
    Malformed,
    Refused,
    Saved,
    TooLarge,
)
from datum_core.canonical import canonical_digest
from datum_core.forms import CustomizerIdentityError
from datum_core.hooks import HookFindings, HookProblem, HookRefusedError, HookRefusedKind
from datum_core.stores import catalog_etag
from datum_sandbox.checks import DatumConfigurationError
from datum_sandbox.protocol import DatumError


def untouched(rig: Any, *, version: str = "1") -> None:
    assert rig.stored().definition["version"] == version
    assert "repository.replace" not in rig.trail
    assert "snapshots.record" not in rig.trail
    assert rig.events == []


# -- order -------------------------------------------------------------------------------------------------------------
def test_customizers_run_in_list_order_and_each_sees_what_the_one_before_left() -> None:
    trail: list[str] = []
    seen: list[str | None] = []

    def first(draft: BuilderSaveDraft) -> None:
        draft.definition["title"] = "first"

    def second(draft: BuilderSaveDraft) -> None:
        seen.append(draft.definition.get("title"))
        draft.definition["title"] = "second"

    hooks = [customizer("a", trail, change=first), customizer("b", trail, change=second)]
    with started_builder(trail=trail, builder_save_customizers=hooks) as rig:
        outcome = rig.save(definition(version="2"))
        assert isinstance(outcome, Saved)
        assert trail.index("customizer:a") < trail.index("customizer:b")
        assert seen == ["first"]
        assert rig.stored().definition["title"] == "second"


def test_validators_run_in_list_order_and_all_of_them_run_when_none_refuses() -> None:
    trail: list[str] = []
    hooks = [validator("a", trail), validator("b", trail), validator("c", trail)]
    with started_builder(trail=trail, builder_save_validators=hooks) as rig:
        assert isinstance(rig.save(definition(version="2")), Saved)
        order = [s for s in trail if s.startswith("validator:")]
    assert order == ["validator:a", "validator:b", "validator:c"]


def test_the_first_customizer_that_refuses_stops_the_rest_and_the_save() -> None:
    trail: list[str] = []
    refusal = HookRefusedError.forbidden("save.notYours", "Not yours.")
    hooks = [customizer("a", trail), customizer("b", trail, refuse=refusal), customizer("c", trail)]
    with started_builder(trail=trail, builder_save_customizers=hooks) as rig:
        outcome = rig.save(definition(version="2"))
        assert isinstance(outcome, Declined)
        assert "customizer:c" not in trail
        assert "sandbox.check" not in trail
        untouched(rig)


def test_a_validator_that_refuses_stops_the_validators_after_it_but_not_the_ones_before() -> None:
    trail: list[str] = []
    refusal = HookRefusedError.conflict("save.locked", "Locked by another author.")
    hooks = [validator("a", trail), validator("b", trail, refuse=refusal), validator("c", trail)]
    with started_builder(trail=trail, builder_save_validators=hooks) as rig:
        outcome = rig.save(definition(version="2"))
        assert isinstance(outcome, Declined)
        assert [s for s in trail if s.startswith("validator:")] == ["validator:a", "validator:b"]
        untouched(rig)


def test_the_same_hooks_run_for_a_create_with_creating_true() -> None:
    trail: list[str] = []
    drafts: list[BuilderSaveDraft] = []
    candidates: list[BuilderSaveCandidate] = []
    hooks: dict[str, Any] = {
        "builder_save_customizers": [customizer("a", trail, seen=drafts)],
        "builder_save_validators": [validator("a", trail, seen=candidates)],
    }
    with started_builder(trail=trail, **hooks) as rig:
        assert isinstance(rig.create(definition("fresh")), Saved)
        assert isinstance(rig.save(definition(version="2")), Saved)
    assert [(d.key, d.creating) for d in drafts] == [("fresh", True), (FORM, False)]
    assert [(c.key, c.creating) for c in candidates] == [("fresh", True), (FORM, False)]


# -- the refusal kinds -------------------------------------------------------------------------------------------------
@pytest.mark.parametrize(
    "kind", [HookRefusedKind.FORBIDDEN, HookRefusedKind.CONFLICT, HookRefusedKind.INVALID], ids=lambda k: k.value
)
def test_a_customizers_refusal_is_declined_with_its_kind_and_problems_as_it_made_them(kind: HookRefusedKind) -> None:
    problems = (HookProblem("title", "title.reserved", "Reserved."), HookProblem(None, "save.other", "Other."))
    refusal = HookRefusedError(kind, problems)
    with started_builder(builder_save_customizers=[customizer("a", [], refuse=refusal)]) as rig:
        outcome = rig.save(definition(version="2"))
    assert isinstance(outcome, Declined)
    assert outcome.refusal is refusal
    assert (outcome.refusal.kind, outcome.refusal.problems) == (kind, problems)


@pytest.mark.parametrize(
    "kind", [HookRefusedKind.FORBIDDEN, HookRefusedKind.CONFLICT, HookRefusedKind.INVALID], ids=lambda k: k.value
)
def test_a_validators_refusal_is_declined_with_its_kind_too(kind: HookRefusedKind) -> None:
    refusal = HookRefusedError(kind, (HookProblem(None, "save.refused", "No."),))
    with started_builder(builder_save_validators=[validator("a", [], refuse=refusal)]) as rig:
        outcome = rig.save(definition(version="2"))
    assert isinstance(outcome, Declined)
    assert outcome.refusal is refusal


def test_the_errors_of_every_validator_come_back_as_one_invalid_refusal_in_order() -> None:
    first = HookFindings(errors=(HookProblem("a", "a.bad", "A."), HookProblem("b", "b.bad", "B.")))
    second = HookFindings(errors=(HookProblem("c", "c.bad", "C."),), warnings=(HookProblem(None, "w", "Warn."),))
    hooks = [validator("one", [], findings=first), validator("two", [], findings=second)]
    with started_builder(builder_save_validators=hooks) as rig:
        outcome = rig.save(definition(version="2"))
        untouched(rig)
    assert isinstance(outcome, Declined)
    assert outcome.refusal.kind is HookRefusedKind.INVALID
    assert [(p.field, p.code) for p in outcome.refusal.problems] == [("a", "a.bad"), ("b", "b.bad"), ("c", "c.bad")]


def test_a_validator_that_answers_nothing_lets_the_save_go_on() -> None:
    with started_builder(builder_save_validators=[validator("a", [], findings=None)]) as rig:
        assert isinstance(rig.save(definition(version="2")), Saved)


def test_validator_warnings_ride_in_the_saved_warnings_by_their_message_else_their_code() -> None:
    findings = HookFindings(
        warnings=(HookProblem("t", "title.short", "The title is short."), HookProblem(None, "x.y", ""))
    )
    with started_builder(builder_save_validators=[validator("a", [], findings=findings)]) as rig:
        outcome = rig.save(definition(version="2"))
    assert isinstance(outcome, Saved)
    assert "The title is short." in outcome.warnings
    assert "x.y" in outcome.warnings
    assert all(isinstance(item, str) for item in outcome.warnings)


# -- a raise reaches the caller as raised ------------------------------------------------------------------------------
@pytest.mark.parametrize("where", ["customizer", "validator"])
def test_a_hook_that_raises_reaches_the_caller_as_raised_and_nothing_is_stored(where: str) -> None:
    boom = RuntimeError("the hook failed")
    hooks: dict[str, Any] = {}
    if where == "customizer":
        hooks["builder_save_customizers"] = [customizer("a", [], fail=boom)]
    else:
        hooks["builder_save_validators"] = [validator("a", [], fail=boom)]
    with started_builder(**hooks) as rig:
        with pytest.raises(RuntimeError) as raised:
            rig.save(definition(version="2"))
        assert raised.value is boom
        untouched(rig)


def test_a_hooks_own_datum_error_reaches_the_caller_with_its_code() -> None:
    class BusyError(DatumError):
        code = "server.busy"
        status = 503

    error = BusyError("hook busy")
    with started_builder(builder_save_validators=[validator("a", [], fail=error)]) as rig:
        with pytest.raises(BusyError) as raised:
            rig.save(definition(version="2"))
        assert raised.value is error
        untouched(rig)


@pytest.mark.parametrize("error", [AssertionError("an assert"), RecursionError("deep")], ids=["assert", "recursion"])
def test_an_assertion_or_a_recursion_error_in_a_hook_is_a_raise_not_a_refusal(error: Exception) -> None:
    with started_builder(builder_save_customizers=[customizer("a", [], fail=error)]) as rig:
        with pytest.raises(type(error)):
            rig.save(definition(version="2"))
        untouched(rig)


# -- the id is the form's key ------------------------------------------------------------------------------------------
@pytest.mark.parametrize("how", ["change", "delete", "retype"])
def test_a_customizer_that_changes_the_id_fails_the_save_and_nothing_is_stored(how: str) -> None:
    def tamper(draft: BuilderSaveDraft) -> None:
        if how == "change":
            draft.definition["id"] = "other"
        elif how == "delete":
            del draft.definition["id"]
        else:
            draft.definition["id"] = 7

    with started_builder(builder_save_customizers=[customizer("a", [], change=tamper)]) as rig:
        with pytest.raises(CustomizerIdentityError):
            rig.save(definition(version="2"))
        assert rig.sandbox.checks == []
        untouched(rig)
        assert rig.repository.inner.current("other") is None


@pytest.mark.parametrize("how", ["change", "delete", "retype"])
def test_a_customizer_that_changes_the_version_fails_the_save_and_nothing_is_stored(how: str) -> None:
    def tamper(draft: BuilderSaveDraft) -> None:
        if how == "change":
            draft.definition["version"] = "99"
        elif how == "delete":
            del draft.definition["version"]
        else:
            draft.definition["version"] = 1

    with started_builder(builder_save_customizers=[customizer("a", [], change=tamper)]) as rig:
        with pytest.raises(CustomizerIdentityError):
            rig.save(definition(version="2"))
        assert rig.sandbox.checks == []
        untouched(rig)


def test_a_customizer_that_changes_the_id_stops_the_save_even_when_a_later_one_restores_it() -> None:
    trail: list[str] = []

    def spoil(draft: BuilderSaveDraft) -> None:
        draft.definition["id"] = "other"

    def restore(draft: BuilderSaveDraft) -> None:
        draft.definition["id"] = FORM

    hooks = [customizer("a", trail, change=spoil), customizer("b", trail, change=restore)]
    with started_builder(builder_save_customizers=hooks) as rig:
        with pytest.raises(CustomizerIdentityError):
            rig.save(definition(version="2"))
        assert "customizer:b" not in trail
        untouched(rig)


def test_a_customizer_that_changes_the_id_of_a_create_fails_it_the_same_way() -> None:
    def tamper(draft: BuilderSaveDraft) -> None:
        draft.definition["id"] = "someone-elses"

    with started_builder(builder_save_customizers=[customizer("a", [], change=tamper)]) as rig:
        with pytest.raises(CustomizerIdentityError):
            rig.create(definition("fresh"))
        assert rig.repository.inner.current("fresh") is None
        assert rig.repository.inner.current("someone-elses") is None


# -- what the customizers left is held to the same rules ---------------------------------------------------------------
def _nan(draft: BuilderSaveDraft) -> None:
    draft.definition["configuration"] = {"n": float("nan")}


def _big(draft: BuilderSaveDraft) -> None:
    draft.definition["notes"] = "x" * 5000


def _lone(draft: BuilderSaveDraft) -> None:
    draft.definition["notes"] = "\ud800"


def _no_root(draft: BuilderSaveDraft) -> None:
    del draft.definition["root"]


@pytest.mark.parametrize(
    ("change", "check"),
    [
        (_nan, lambda o: isinstance(o, Refused) and [e.code for e in o.errors] == ["definition.number.nonFinite"]),
        (_big, lambda o: o == TooLarge(1024)),
        (_lone, lambda o: isinstance(o, Malformed)),
        (_no_root, lambda o: isinstance(o, Refused) and "definition.root.missing" in [e.code for e in o.errors]),
    ],
    ids=["non-finite number", "over the cap", "lone surrogate", "no root"],
)
def test_what_a_customizer_leaves_is_refused_by_the_same_rules_and_stores_nothing(change: Any, check: Any) -> None:
    trail: list[str] = []
    config = {"builder": {"max_definition_size": "1KiB"}}
    with started_builder(config, trail=trail, builder_save_customizers=[customizer("a", trail, change=change)]) as rig:
        outcome = rig.save(definition(version="2"))
        assert check(outcome), outcome
        assert "sandbox.check" not in trail
        untouched(rig)


# -- what a hook is told -----------------------------------------------------------------------------------------------
def test_a_customizer_changes_a_copy_and_the_callers_tree_is_never_touched() -> None:
    sent = definition(version="2")
    before = copy.deepcopy(sent)

    def change(draft: BuilderSaveDraft) -> None:
        draft.definition["title"] = "customized"
        draft.definition["root"]["children"]["content"].clear()

    with started_builder(builder_save_customizers=[customizer("a", [], change=change)]) as rig:
        outcome = rig.save(sent)
        assert isinstance(outcome, Saved)
    assert sent == before


def test_the_etag_of_a_customized_save_is_the_hash_of_what_was_stored_not_of_what_was_sent() -> None:
    def retitle(draft: BuilderSaveDraft) -> None:
        draft.definition["title"] = "customized"

    sent = definition(version="2")
    with started_builder(builder_save_customizers=[customizer("a", [], change=retitle)]) as rig:
        outcome = rig.save(sent)
        assert isinstance(outcome, Saved)
        stored = rig.stored()
    assert outcome.sha256 == stored.sha256 == canonical_digest(dict(stored.definition))
    assert outcome.sha256 != canonical_digest(sent)
    assert stored.definition["title"] == "customized"


def test_the_principal_reaches_both_hooks_untouched_and_decides_nothing() -> None:
    drafts: list[BuilderSaveDraft] = []
    candidates: list[BuilderSaveCandidate] = []
    hooks: dict[str, Any] = {
        "builder_save_customizers": [customizer("a", [], seen=drafts)],
        "builder_save_validators": [validator("a", [], seen=candidates)],
    }
    with started_builder(**hooks) as rig:
        for who in (PRINCIPAL, None, "anyone"):
            assert isinstance(rig.save(definition(version=str(len(drafts) + 2)), principal=who), Saved)
    assert [d.principal for d in drafts] == [PRINCIPAL, None, "anyone"]
    assert [c.principal for c in candidates] == [PRINCIPAL, None, "anyone"]


def test_a_candidate_carries_the_customized_definition_and_the_kernels_verdict_for_it() -> None:
    candidates: list[BuilderSaveCandidate] = []

    def retitle(draft: BuilderSaveDraft) -> None:
        draft.definition["title"] = "customized"

    hooks: dict[str, Any] = {
        "builder_save_customizers": [customizer("a", [], change=retitle)],
        "builder_save_validators": [validator("a", [], seen=candidates)],
    }
    with started_builder(**hooks) as rig:
        rig.sandbox.answer = verdict(
            warnings=[finding("formula.odd", "rules:name:visibleWhen", "Odd.")],
            structure_warnings=[finding("component.type.unknown", "root > content > name", "Unknown.")],
        )
        assert isinstance(rig.save(definition(version="2")), Saved)
    (candidate,) = candidates
    assert candidate.definition["title"] == "customized"
    assert candidate.problems == ()
    assert [(w.field, w.code) for w in candidate.warnings] == [("rules:name:visibleWhen", "formula.odd")]
    assert [(w.field, w.code) for w in candidate.structure_warnings] == [
        ("root > content > name", "component.type.unknown")
    ]


def test_a_validator_cannot_change_what_is_stored_by_changing_the_candidate() -> None:
    def vandal(candidate: BuilderSaveCandidate) -> HookFindings | None:
        cast("dict[str, Any]", candidate.definition)["root"]["children"]["content"].clear()
        return None

    sent = definition(version="2")
    before = copy.deepcopy(sent)
    with started_builder(builder_save_validators=[vandal]) as rig:
        outcome = rig.save(sent)
        assert isinstance(outcome, Saved)
        assert outcome.sha256 == canonical_digest(before)
        assert dict(rig.stored().definition) == before
        assert sent == before
        assert before["root"]["children"]["content"]


def test_a_hook_never_sees_another_forms_definition() -> None:
    other = definition("claims", "4", secret=True)
    drafts: list[BuilderSaveDraft] = []
    candidates: list[BuilderSaveCandidate] = []
    hooks: dict[str, Any] = {
        "builder_save_customizers": [customizer("a", [], seen=drafts)],
        "builder_save_validators": [validator("a", [], seen=candidates)],
    }
    with started_builder(seed=[definition(), other], **hooks) as rig:
        assert isinstance(rig.save(definition(version="2")), Saved)
    everything: list[BuilderSaveDraft | BuilderSaveCandidate] = [*drafts, *candidates]
    for seen in everything:
        assert seen.definition["id"] == FORM
        assert MARKER not in repr(seen.definition)


def test_no_hook_runs_for_a_catalog_write() -> None:
    trail: list[str] = []
    hooks: dict[str, Any] = {
        "builder_save_customizers": [customizer("a", trail)],
        "builder_save_validators": [validator("a", trail)],
    }
    with started_builder(trail=trail, **hooks) as rig:
        outcome = rig.service.save_translations(
            FORM, {"fr": {"form": {"title": "un"}}}, expected_etag=catalog_etag({}), principal=None
        )
        assert isinstance(outcome, CatalogSaved)
        assert [s for s in trail if s.startswith(("customizer", "validator"))] == []


# -- async hooks and typos ---------------------------------------------------------------------------------------------
def test_async_hooks_run_through_the_awaiter_the_start_was_given() -> None:
    awaiter = with_awaiter()
    trail: list[str] = []

    async def customize(draft: BuilderSaveDraft) -> None:
        trail.append("async customizer")
        draft.definition["title"] = "async"

    async def validate(candidate: BuilderSaveCandidate) -> HookFindings | None:
        trail.append("async validator")
        return None

    try:
        hooks: dict[str, Any] = {"builder_save_customizers": [customize], "builder_save_validators": [validate]}
        with started_builder(trail=trail, awaiter=awaiter, **hooks) as rig:
            assert isinstance(rig.save(definition(version="2")), Saved)
            assert rig.stored().definition["title"] == "async"
    finally:
        awaiter.close()
    assert [s for s in trail if s.startswith("async")] == ["async customizer", "async validator"]


def test_an_async_hook_with_no_awaiter_is_a_configuration_error_naming_the_missing_bridge() -> None:
    async def customize(draft: BuilderSaveDraft) -> None:
        draft.definition["title"] = "never"

    with (
        pytest.raises(DatumConfigurationError, match="awaiter"),
        started_builder(builder_save_customizers=[customize]) as rig,
    ):
        rig.save(definition(version="2"))


@pytest.mark.parametrize("keyword", ["builder_save_customizers", "builder_save_validators"])
@pytest.mark.parametrize(
    "typo", [42, "customizer", [None], [42]], ids=["number", "string", "list of None", "list of number"]
)
def test_a_hook_typo_is_a_type_error_when_the_datum_is_built(keyword: str, typo: object) -> None:
    with pytest.raises(TypeError):
        plain_builder_datum(**cast("dict[str, Any]", {keyword: typo}))


@pytest.mark.parametrize("keyword", ["builder_save_customizers", "builder_save_validators"])
def test_a_single_function_is_not_a_list_of_hooks(keyword: str) -> None:
    with pytest.raises(TypeError):
        plain_builder_datum(**cast("dict[str, Any]", {keyword: lambda value: None}))


def test_the_hooks_are_kept_in_list_order_on_the_datum() -> None:
    def a(draft: BuilderSaveDraft) -> None:
        return None

    def b(draft: BuilderSaveDraft) -> None:
        return None

    def v(candidate: BuilderSaveCandidate) -> HookFindings | None:
        return None

    datum = plain_builder_datum(builder_save_customizers=[a, b], builder_save_validators=(v,))
    assert datum.builder_save_customizers == (a, b)
    assert datum.builder_save_validators == (v,)
    assert plain_builder_datum().builder_save_customizers == ()
    assert plain_builder_datum().builder_save_validators == ()


def test_content_the_customizer_adds_is_checked_by_the_kernel_like_any_other() -> None:
    def add(draft: BuilderSaveDraft) -> None:
        content_of(draft.definition).append({"id": "added", "type": "text", "configuration": {}})

    with started_builder(builder_save_customizers=[customizer("a", [], change=add)]) as rig:
        assert isinstance(rig.save(definition(version="2")), Saved)
        (asked,) = rig.sandbox.checks
    assert [c["id"] for c in content_of(asked[0])] == ["name", "added"]
