"""The receiver order, one test per step's place; every step is held by a refusal that stops the rest.

The trail lists, in call order, the seams a request reached. A step that moved (a throttle after the pre-check, a
pre-check after the definition, the idempotency lookup after the run) changes the trail of the refusal that
stops there, so each row below fails against an implementation that swaps two steps.
"""

import inspect
from collections.abc import Callable, Mapping
from typing import Any

import pytest
from submissions_support import (
    FULL_PATH,
    Rig,
    attr_of,
    bus,
    envelope,
    http_context,
    journey_check,
    refused_by_kernel,
    started,
    wrapped,
)

from datum_core import Datum
from datum_core.canonical import canonical_digest
from datum_core.hooks import HookFindings, HookProblem
from datum_core.submissions import (
    Accepted,
    FormRef,
    Malformed,
    NotFound,
    Outdated,
    Redelivered,
    Refused,
    Reject,
    Rejected,
    SubmissionService,
    Throttled,
    TooLarge,
    Unavailable,
)
from datum_sandbox.protocol import ProgramUnavailableError

PLAN_4_2 = (
    "document",
    "wrapper",
    "form_id",
    "form_key",
    "values",
    "journey_id",
    "locale",
    "throttle",
    "pre_check",
    "definition",
    "version",
    "idempotency",
    "journey",
    "sandbox_now",
    "contributors",
    "host_context",
    "customizers",
    "option_snapshot",
    "rules",
    "run",
    "digest",
    "verdict",
    "signature",
    "validators",
    "dry_run_report",
    "record_use",
    "handler",
    "remember",
    "stored",
    "event",
)


def test_the_stage_table_is_the_plan_4_2_chain_with_the_signature_slot_named() -> None:
    assert tuple(SubmissionService.STAGES) == PLAN_4_2
    assert PLAN_4_2.index("version") < PLAN_4_2.index("idempotency") < PLAN_4_2.index("journey")
    assert PLAN_4_2.index("idempotency") < PLAN_4_2.index("run") < PLAN_4_2.index("signature")
    assert PLAN_4_2.index("signature") < PLAN_4_2.index("validators") < PLAN_4_2.index("handler")


# Every PLAN_4_2 name and what holds its place: a STOPS row id, a FULL_PATH trail seam, a test in this module, or an
# exemption with its reason. A name left out of this table fails the test below.
type Holder = tuple[str, str]
HELD_BY: dict[str, Holder] = {
    "document": ("stop", "document rules"),
    "wrapper": (
        "exempt",
        "the signed wrapper is not built yet (the `signature` slot); the plain wrapper is the `document` row",
    ),
    "form_id": ("stop", "form key"),
    "form_key": ("stop", "form key"),
    "values": ("test", "test_the_steps_before_the_throttle_answer_in_the_plan_order"),
    "journey_id": ("test", "test_the_journey_step_comes_after_the_version_and_before_the_run"),
    "locale": ("test", "test_the_steps_before_the_throttle_answer_in_the_plan_order"),
    "throttle": ("stop", "throttle"),
    "pre_check": ("stop", "pre-check"),
    "definition": ("stop", "definition"),
    "version": ("stop", "version"),
    "journey": ("test", "test_the_journey_step_comes_after_the_version_and_before_the_run"),
    "sandbox_now": ("test", "test_the_sandbox_is_taken_after_the_definition_and_before_the_first_contributor"),
    "contributors": ("stop", "contributors"),
    "host_context": ("test", "test_the_host_context_is_asked_after_the_contributors_and_before_the_customizers"),
    "customizers": ("stop", "customizers"),
    "option_snapshot": ("trail", "option_snapshot"),
    "rules": ("stop", "rules"),
    "run": ("stop", "run"),
    "digest": ("test", "test_the_digest_is_taken_before_the_verdict_and_is_the_documents_canonical_digest"),
    "verdict": ("stop", "verdict"),
    "idempotency": ("trail", "idempotency.find"),
    "signature": ("exempt", "the signature check is not built yet; the slot is named and its keyword defaults to None"),
    "validators": ("stop", "validators"),
    "dry_run_report": (
        "test",
        "test_a_dry_run_runs_every_check_but_neither_the_idempotency_store_nor_the_handler_nor_an_event",
    ),
    "record_use": ("exempt", "the record_use slot is not built; a dry run and a real delivery have no seam for it yet"),
    "handler": ("trail", "handler"),
    "remember": ("trail", "idempotency.record"),
    "stored": ("exempt", "the stored slot is not built yet; the validated event is the last step today"),
    "event": ("trail", "event:SubmissionValidatedEvent"),
}


def test_every_name_of_the_plan_chain_is_held_by_a_row_a_seam_a_test_or_a_named_exemption() -> None:
    assert set(HELD_BY) == set(PLAN_4_2)
    stops = {row[0] for row in STOPS}
    for name, (kind, detail) in HELD_BY.items():
        match kind:
            case "stop":
                assert detail in stops, name
            case "trail":
                assert detail in FULL_PATH, name
            case "test":
                assert callable(globals().get(detail)), name
            case "exempt":
                assert detail, name
            case _:
                pytest.fail(f"{name}: unknown holder kind {kind}")
    assert FULL_PATH.index("option_snapshot") == FULL_PATH.index("customizer") + 1


def test_the_host_context_is_asked_after_the_contributors_and_before_the_customizers() -> None:
    trails: list[list[str]] = []  # the rig's trail, known once the rig has started

    def host_context(form_key: str, context: Any) -> Any:
        trails[0].append("host_context")
        return {"role": "admin"}

    with started(full=True, host_context=host_context) as rig:
        trails.append(rig.trail)
        outcome = rig.submit(envelope(), http_context())
    assert isinstance(outcome, Accepted)
    assert rig.trail.index("contributor") < rig.trail.index("host_context") < rig.trail.index("customizer")
    assert rig.trail.count("host_context") == 1


def test_the_signature_check_is_a_keyword_whose_default_is_none() -> None:
    parameter = inspect.signature(Datum).parameters["signature_check"]
    assert parameter.default is None
    assert parameter.kind is inspect.Parameter.KEYWORD_ONLY


def test_an_accepted_submission_reaches_every_seam_in_the_plan_order() -> None:
    with started(full=True) as rig:
        outcome = rig.submit(envelope(), http_context())
    assert isinstance(outcome, Accepted)
    assert rig.trail == FULL_PATH


def test_the_idempotency_store_is_asked_with_form_version_and_the_submission_key_and_keeps_the_digest() -> None:
    document = envelope()
    with started() as rig:
        rig.submit(document, bus(submission_key="attempt-1"))
    assert rig.idempotency.finds == [("contact", "1", "attempt-1")]
    assert [(form, version, key) for form, version, key, _ in rig.idempotency.records] == rig.idempotency.finds
    assert rig.idempotency.records[0][3].digest == canonical_digest(document)


def raise_unavailable(*args: Any) -> Any:
    raise ProgramUnavailableError("down")


def raise_runtime(*args: Any) -> Any:
    raise RuntimeError("the hook is broken")


def deny(rig: Rig) -> None:
    rig.throttle.deny = 3


def reject_pre_check(incoming: Any) -> Reject:
    return Reject("not.today", "No")


def sandbox_refuses(rig: Rig) -> None:
    rig.sandbox.verdict = refused_by_kernel()


def refusing_validator(candidate: Any, context: Any) -> HookFindings:
    return HookFindings(errors=(HookProblem(None, "validator.no", "No"),))


type Arrange = Callable[[Rig], None]


def noop(rig: Rig) -> None:
    return None


# (id, seams for Datum, config, document, arrange, expected trail, expected outcome type)
STOPS: list[tuple[str, dict[str, Any], dict[str, Any], Mapping[str, Any], Arrange, list[str], type]] = [
    ("document rules", {}, {}, {"not": "an envelope"}, noop, [], Malformed),
    ("form key", {}, {}, envelope(form="not a key"), noop, [], NotFound),
    ("cap", {}, {"web": {"api": {"max_body_size": "4KiB"}}}, envelope(values={"name": "x" * 5000}), noop, [], TooLarge),
    ("throttle", {}, {}, envelope(), deny, ["throttle", "event:SubmissionThrottledEvent"], Throttled),
    ("pre-check", {"pre_checks": [reject_pre_check]}, {}, envelope(), noop, ["throttle"], Refused),
    ("definition", {}, {}, envelope(form="missing"), noop, ["throttle", "definition"], NotFound),
    ("version", {}, {}, envelope(version="0"), noop, ["throttle", "definition"], Outdated),
    (
        "contributors",
        {"context_contributors": [raise_runtime]},
        {},
        envelope(),
        noop,
        ["throttle", "definition", "idempotency.find"],
        Unavailable,
    ),
    (
        "customizers",
        {"host_options_customizers": [raise_runtime]},
        {},
        envelope(),
        noop,
        ["throttle", "definition", "idempotency.find"],
        Unavailable,
    ),
    (
        "rules",
        {"rules_providers": [raise_runtime]},
        {},
        envelope(),
        noop,
        ["throttle", "definition", "idempotency.find"],
        Unavailable,
    ),
    (
        "run",
        {},
        {},
        envelope(),
        lambda rig: setattr(rig.sandbox, "error", ProgramUnavailableError("down")),
        ["throttle", "definition", "idempotency.find", "sandbox"],
        Unavailable,
    ),
    (
        "verdict",
        {},
        {},
        envelope(),
        sandbox_refuses,
        ["throttle", "definition", "idempotency.find", "sandbox", "event:SubmissionRejectedEvent"],
        Rejected,
    ),
    (
        "validators",
        {"validators": [refusing_validator]},
        {},
        envelope(),
        noop,
        ["throttle", "definition", "idempotency.find", "sandbox", "event:SubmissionRejectedEvent"],
        Rejected,
    ),
]


@pytest.mark.parametrize(
    ("seams", "config", "document", "arrange", "trail", "outcome_type"),
    [row[1:] for row in STOPS],
    ids=[row[0] for row in STOPS],
)
def test_each_refusal_stops_the_chain_at_its_place(
    *,
    seams: dict[str, Any],
    config: dict[str, Any],
    document: Mapping[str, Any],
    arrange: Arrange,
    trail: list[str],
    outcome_type: type,
) -> None:
    with started(config, **seams) as rig:
        arrange(rig)
        outcome = rig.submit(document, http_context())
    assert isinstance(outcome, outcome_type)
    assert rig.trail == trail
    assert rig.handler.calls == []
    assert rig.idempotency.records == []


def test_a_pre_check_runs_after_the_throttle_and_before_the_definition_is_read() -> None:
    with started(full=True) as rig:
        rig.submit(envelope(), http_context())
    assert rig.trail.index("throttle") < rig.trail.index("pre_check") < rig.trail.index("definition")


def test_contributors_then_customizers_then_the_rules_provider_all_before_the_run() -> None:
    with started(full=True) as rig:
        rig.submit(envelope(), http_context())
    order = [rig.trail.index(name) for name in ("contributor", "customizer", "option_snapshot", "rules", "sandbox")]
    assert order == sorted(order)


def test_a_redelivery_is_answered_before_the_run_the_validators_and_the_handler() -> None:
    with started(full=True) as rig:
        first = rig.submit(envelope(), http_context(submission_key="attempt-1"))
        rig.trail.clear()
        again = rig.submit(envelope(), http_context(submission_key="attempt-1"))
    assert isinstance(first, Accepted)
    assert isinstance(again, Redelivered)
    assert rig.trail == ["throttle", "pre_check", "definition", "idempotency.find", "event:SubmissionRedeliveredEvent"]
    assert len(rig.handler.calls) == 1


def test_a_handler_that_raises_reaches_the_caller_and_nothing_is_remembered_or_published() -> None:
    with started(full=True) as rig:
        rig.handler.fail = RuntimeError("the queue is full")
        with pytest.raises(RuntimeError, match="the queue is full"):
            rig.submit(envelope(), http_context())
        assert rig.trail[-1] == "handler"
        assert rig.idempotency.records == []
        assert not [name for name in rig.trail if name.startswith("event:")]
        rig.handler.fail = None
        rig.trail.clear()
        retried = rig.submit(envelope(), http_context())
    assert isinstance(retried, Accepted)
    assert rig.trail == FULL_PATH


def test_the_validated_event_comes_last_after_the_handler_and_the_remember() -> None:
    with started() as rig:
        rig.submit()
    assert rig.trail[-3:] == ["handler", "idempotency.record", "event:SubmissionValidatedEvent"]


def test_a_dry_run_runs_every_check_but_neither_the_idempotency_store_nor_the_handler_nor_an_event() -> None:
    with started(full=True) as rig:
        rig.service.test(FormRef.from_document(), wrapped(envelope()), http_context())
    assert rig.trail == [
        "throttle",
        "pre_check",
        "definition",
        "contributor",
        "customizer",
        "option_snapshot",
        "rules",
        "sandbox",
        "validator",
    ]
    assert rig.handler.calls == []
    assert rig.idempotency.finds == []


def test_validate_runs_the_checks_and_the_validators_but_not_idempotency_or_the_handler() -> None:
    with started(full=True) as rig:
        rig.service.validate(FormRef.from_document(), journey_check(envelope()), http_context())
    assert rig.trail == [
        "throttle",
        "pre_check",
        "definition",
        "contributor",
        "customizer",
        "option_snapshot",
        "rules",
        "sandbox",
        "validator",
        "event:JourneyCheckedEvent",
    ]


def test_the_journey_step_comes_after_the_version_and_before_the_run() -> None:
    document = envelope(extra={"journey": {"id": "no-such-journey"}})
    with started(full=True) as rig:
        outcome = rig.service.validate(FormRef.from_document(), journey_check(document), http_context())
    assert attr_of(outcome, "accepted") is False
    assert {code for _, code, _ in attr_of(outcome, "errors")} == {"journey.unknown"}
    assert rig.trail == ["throttle", "pre_check", "definition", "event:JourneyCheckedEvent"]


def test_a_stale_version_wins_over_an_unknown_journey() -> None:
    document = envelope(version="0", extra={"journey": {"id": "no-such-journey"}})
    with started() as rig:
        outcome = rig.service.validate(FormRef.from_document(), journey_check(document), http_context())
    assert isinstance(outcome, Outdated)


def test_the_sandbox_is_taken_after_the_definition_and_before_the_first_contributor(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    with started(full=True) as rig:
        real = Datum.sandbox

        def taken(self: Datum) -> Any:
            rig.trail.append("sandbox_now")
            return real.fget(self)  # type: ignore[attr-defined]

        monkeypatch.setattr(Datum, "sandbox", property(taken))
        rig.submit(envelope(), http_context())
    names = [name for name in rig.trail if name in {"definition", "sandbox_now", "contributor", "sandbox"}]
    assert names[:3] == ["definition", "sandbox_now", "contributor"]
    assert rig.trail.count("sandbox_now") == 1


def test_a_sandbox_that_is_down_refuses_before_any_contributor_or_customizer_runs(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    with started(full=True) as rig:

        def down(self: Datum) -> Any:
            raise ProgramUnavailableError("down")

        monkeypatch.setattr(Datum, "sandbox", property(down))
        outcome = rig.submit(envelope(), http_context())
    assert isinstance(outcome, Unavailable)
    assert rig.trail == ["throttle", "pre_check", "definition", "idempotency.find"]


def test_the_digest_is_taken_before_the_verdict_and_is_the_documents_canonical_digest() -> None:
    document = envelope()
    seen: dict[str, str] = {}

    def validator(candidate: Any, context: Any) -> None:
        seen["validator"] = attr_of(candidate, "digest")

    with started(full=True, validators=[validator]) as rig:
        outcome = rig.submit(document, http_context())
    assert isinstance(outcome, Accepted)
    assert seen["validator"] == canonical_digest(document)
    assert attr_of(rig.handler.calls[0], "digest") == canonical_digest(document)


@pytest.mark.parametrize(
    ("call", "body"),
    [
        ("submit", envelope(version="0")),
        ("validate", journey_check(envelope(version="0"))),
        ("test", wrapped(envelope(version="0"))),
    ],
)
def test_a_stale_version_is_outdated_in_every_mode_and_costs_no_run(call: str, body: Any) -> None:
    with started() as rig:
        outcome = getattr(rig.service, call)(FormRef.from_document(), body, http_context())
    assert isinstance(outcome, Outdated)
    assert rig.sandbox.validations == []
    assert rig.events == []


def deep_envelope(**fields: Any) -> dict[str, Any]:
    """An envelope nested past the document depth limit (64) by one extra member."""
    value: Any = 1
    for _ in range(70):
        value = {"n": value}
    return envelope(extra={"deep": value}, **fields)


@pytest.mark.parametrize(
    ("config", "document", "expected"),
    [
        pytest.param(
            {"web": {"api": {"max_body_size": "4KiB"}}},
            deep_envelope(values={"name": "x" * 5000}),
            TooLarge,
            id="the cap before the document rules",
        ),
        pytest.param({}, deep_envelope(form="a b"), Malformed, id="the document rules before the form key"),
        pytest.param({}, envelope(form="a b", extra={"values": "a string"}), NotFound, id="the form key before values"),
        pytest.param({}, envelope(form="a b", extra={"locale": 5}), NotFound, id="the form key before the locale"),
    ],
)
def test_the_steps_before_the_throttle_answer_in_the_plan_order(
    config: dict[str, Any], document: Mapping[str, Any], expected: type
) -> None:
    with started(config) as rig:
        outcome = rig.submit(document, http_context())
    assert isinstance(outcome, expected)
    assert rig.trail == []
    assert rig.throttle.keys == []


def test_validate_and_test_report_a_validators_errors_in_their_verdict() -> None:
    with started(validators=[refusing_validator]) as rig:
        checked = rig.service.validate(FormRef.from_document(), journey_check(envelope()), http_context())
        published = list(rig.events)
        rig.events.clear()
        dry = rig.service.test(FormRef.from_document(), wrapped(envelope()), http_context())
    assert attr_of(checked, "accepted") is False
    assert any(field is None and code == "validator.no" for field, code, _ in attr_of(checked, "errors"))
    assert len(published) == 1
    assert attr_of(published[0], "accepted") is False
    assert attr_of(dry, "accepted") is False
    assert attr_of(dry, "stage") == "server"
    assert any(code == "validator.no" for _, code, _ in attr_of(dry, "errors"))
    assert rig.events == []
