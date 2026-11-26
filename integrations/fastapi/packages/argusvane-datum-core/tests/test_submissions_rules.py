"""`SubmissionService` built directly (no `Datum`): the document rules, the journey step and the page check, the
customizers' typed draft, the option snapshot in the run, the digest the sandbox names, inspect, the signature slot.

The receiver-order modules hold the order through a started `Datum`; these cases hold the rules that order leaves to the
service itself, over the same recording seams.
"""

import json
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any

import pytest
from submissions_support import (
    FORM,
    SOURCE,
    Handler,
    RecordingIdempotency,
    RecordingSandbox,
    RecordingThrottle,
    Repository,
    SourceProvider,
    body_for,
    bus,
    definition,
    envelope,
    http_context,
    journey_check,
    wrapped,
)

from datum_core.config.models import LogLevel, ThrottleKind, UnknownFields
from datum_core.events import DatumEvent, EventDispatcher
from datum_core.forms import DataSourceService
from datum_core.submissions import (
    Accepted,
    Checked,
    DryRun,
    FormRef,
    Inspected,
    JourneyCheck,
    Malformed,
    Rejected,
    RememberedReceipt,
    RunSettings,
    SubmissionContext,
    SubmissionService,
    Throttled,
    TooLarge,
    Unavailable,
)
from datum_sandbox.checks import DatumConfigurationError
from datum_sandbox.json import JsonValue
from datum_sandbox.protocol import DefinitionTooDeepError, ProgramUnavailableError, SandboxResult


@dataclass
class Parts:
    """The recording seams of one directly built service."""

    trail: list[str] = field(default_factory=list[str])
    events: list[DatumEvent] = field(default_factory=list[DatumEvent])

    def __post_init__(self) -> None:
        self.sandbox = RecordingSandbox(self.trail)
        self.repository = Repository(self.trail, definition())
        self.idempotency = RecordingIdempotency(self.trail)
        self.throttle = RecordingThrottle(self.trail)
        self.handler = Handler(self.trail)

    def service(self, **seams: Any) -> SubmissionService:
        options: dict[str, Any] = {
            "repository": self.repository,
            "sandbox": lambda: self.sandbox,
            "idempotency_store": self.idempotency,
            "events": EventDispatcher([(DatumEvent, self.events.append)]),
            "max_document_bytes": 1024 * 1024,
            "handler": self.handler,
            "throttle": self.throttle,
        }
        options.update(seams)
        return SubmissionService(**options)

    @property
    def sent(self) -> dict[str, JsonValue]:
        """The run input of the last validation."""
        return self.sandbox.validations[-1][0]


@pytest.fixture
def parts() -> Parts:
    return Parts()


JOURNEYS: dict[str, Any] = {
    "journeys": [
        {"id": "main", "pages": [{"id": "p1"}, {"id": "p2"}]},
        {"id": "short", "pages": [{"id": "only"}]},
    ],
    "defaultJourneyId": "main",
}


def with_journeys(**more: Any) -> dict[str, Any]:
    form = definition()
    form["journey"] = {**JOURNEYS, **more}
    return form


# -- document rules ----------------------------------------------------------------------------------------------------
@pytest.mark.parametrize(
    "locale",
    [pytest.param(5, id="a number"), pytest.param("x" * 33, id="too long"), pytest.param("en\n", id="a newline")],
)
def test_a_locale_that_is_no_short_tag_is_malformed_before_the_throttle(parts: Parts, locale: Any) -> None:
    outcome = parts.service().submit(FormRef.from_document(), envelope(locale=locale), http_context())
    assert isinstance(outcome, Malformed)
    assert parts.trail == []


def test_a_document_with_no_locale_is_judged_in_english(parts: Parts) -> None:
    document = envelope()
    del document["submission"]["locale"]
    parts.service().submit(FormRef.from_document(), document, bus())
    assert parts.sent["locale"] == "en"


@pytest.mark.parametrize(
    "body",
    [
        pytest.param({"document": envelope(), "scope": "journey"}, id="a scope on a delivery"),
        pytest.param({"document": envelope(), "pageId": "p1"}, id="a page id on a delivery"),
        pytest.param({"document": envelope(), "extra": 1}, id="a stray member beside the document"),
        pytest.param({"document": "text"}, id="a document that is no object"),
        pytest.param({**envelope(), "scope": "page"}, id="check members on the envelope"),
    ],
)
def test_a_delivery_shaped_as_something_else_is_malformed_and_costs_nothing(parts: Parts, body: Any) -> None:
    outcome = parts.service().submit(FormRef.from_document(), body, http_context())
    assert isinstance(outcome, Malformed)
    assert parts.trail == []


SIGNING = {"scope": "envelope", "placement": "wrapper", "digest": "sha-256", "canonicalization": "jcs"}


@pytest.mark.parametrize(
    "signed",
    [
        pytest.param({"format": SIGNING, "payload": envelope(), "signatures": [], "smuggled": 1}, id="a stray member"),
        pytest.param({"format": SIGNING, "payload": envelope()}, id="no signatures"),
        pytest.param({"payload": envelope(), "signatures": []}, id="no format"),
        pytest.param({"format": SIGNING, "payload": "x", "signatures": []}, id="a payload that is no object"),
    ],
)
def test_a_signed_wrapper_out_of_shape_is_malformed(parts: Parts, signed: dict[str, Any]) -> None:
    outcome = parts.service().submit(FormRef.from_document(), wrapped(signed), bus())
    assert isinstance(outcome, Malformed)


def test_a_signed_wrapper_in_shape_is_refused_until_the_signature_check_exists(parts: Parts) -> None:
    """The catalog's `signing.not_set_up` (503) answers a signed wrapper while signed submissions are not set up."""
    outcome = parts.service().submit(
        FormRef.from_document(), wrapped({"format": SIGNING, "payload": envelope(), "signatures": []}), bus()
    )
    assert isinstance(outcome, Unavailable)
    assert outcome.code == "signing.not_set_up"
    assert parts.sandbox.validations == []
    assert parts.handler.calls == []


def test_the_run_is_handed_the_document_so_the_sandbox_can_name_it(parts: Parts) -> None:
    document = envelope()
    parts.service().submit(FormRef.from_document(), wrapped(document), bus())
    assert parts.sent["document"] == document


@pytest.mark.parametrize("call", ["submit", "validate", "test"])
def test_a_sandbox_that_names_another_document_is_unavailable_and_nothing_is_kept(parts: Parts, call: str) -> None:
    parts.sandbox.verdict = SandboxResult({"errors": [], "values": {"name": "x"}, "digest": "0" * 64}, 0.01)
    outcome = getattr(parts.service(), call)(FormRef.from_document(), body_for(call, envelope()), bus())
    assert isinstance(outcome, Unavailable)
    assert outcome.code == "validator_unavailable"
    assert parts.handler.calls == []


def test_the_one_cap_is_the_constructors_and_is_measured_on_the_tree(parts: Parts) -> None:
    service = parts.service(max_document_bytes=200)
    big = service.submit(FormRef.from_document(), envelope(values={"name": "x" * 200}), http_context())
    assert isinstance(big, TooLarge)
    assert big.max_bytes == 200
    assert parts.trail == []


# -- the journey step --------------------------------------------------------------------------------------------------
def test_a_delivery_naming_an_unknown_journey_is_rejected_at_the_journey_stage_before_the_run(parts: Parts) -> None:
    parts.repository.forms[FORM] = with_journeys()
    outcome = parts.service().submit(
        FormRef.from_document(), envelope(extra={"journey": {"id": "nope"}}), http_context()
    )
    assert isinstance(outcome, Rejected)
    assert (outcome.stage, [code for _, code, _ in outcome.errors]) == ("journey", ["journey.unknown"])
    assert parts.sandbox.validations == []
    assert [type(e).__name__ for e in parts.events] == ["SubmissionRejectedEvent"]


def test_a_document_naming_no_journey_is_judged_through_the_default_one(parts: Parts) -> None:
    parts.repository.forms[FORM] = with_journeys()
    parts.service().submit(FormRef.from_document(), envelope(), bus())
    journey = parts.sent["journey"]
    assert isinstance(journey, dict)
    assert journey["id"] == "main"


def test_several_journeys_and_no_default_refuse_a_document_naming_none(parts: Parts) -> None:
    parts.repository.forms[FORM] = with_journeys(defaultJourneyId="")
    outcome = parts.service().validate(FormRef.from_document(), journey_check(envelope()), bus())
    assert isinstance(outcome, Checked)
    assert (outcome.accepted, [code for _, code, _ in outcome.errors]) == (False, ["journey.required"])


def test_a_form_that_opens_as_a_form_is_judged_whole(parts: Parts) -> None:
    parts.repository.forms[FORM] = with_journeys(opensAs="form")
    parts.service().submit(FormRef.from_document(), envelope(), bus())
    assert "journey" not in parts.sent


def test_a_page_check_sends_the_page_and_keeps_only_the_errors_on_it(parts: Parts) -> None:
    parts.repository.forms[FORM] = with_journeys()
    parts.sandbox.verdict = SandboxResult(
        {
            "errors": [
                {"code": "required", "componentId": "name", "severity": "error"},
                {"code": "required", "componentId": "later", "severity": "error"},
                {"code": "journey.exit", "severity": "error"},
            ],
            "pageComponentIds": ["name"],
        },
        0.01,
    )
    document = envelope(extra={"journey": {"id": "main"}})
    outcome = parts.service().validate(
        FormRef.from_document(), wrapped(document), bus(), check=JourneyCheck("page", "p1")
    )
    assert parts.sent["page"] == "p1"
    assert isinstance(outcome, Checked)
    assert [(f, c) for f, c, _ in outcome.errors] == [("name", "required")]
    assert (outcome.journey_id, outcome.page_id) == ("main", "p1")


def test_the_body_may_name_the_page_check_beside_the_document(parts: Parts) -> None:
    parts.repository.forms[FORM] = with_journeys()
    body = {"document": envelope(extra={"journey": {"id": "main"}}), "scope": "page", "pageId": "p2"}
    outcome = parts.service().validate(FormRef.from_document(), body, bus())
    assert isinstance(outcome, Checked)
    assert outcome.page_id == "p2"


@pytest.mark.parametrize(
    "body",
    [
        pytest.param({"scope": "everything"}, id="a scope that is none of the two"),
        pytest.param({"scope": "page"}, id="a page check without a page"),
        pytest.param({"pageId": "p1"}, id="a page without a page check"),
    ],
)
def test_check_members_out_of_shape_are_malformed(parts: Parts, body: dict[str, Any]) -> None:
    outcome = parts.service().validate(FormRef.from_document(), {"document": envelope(), **body}, bus())
    assert isinstance(outcome, Malformed)
    assert parts.trail == []


@pytest.mark.parametrize(
    "body",
    [
        pytest.param({"document": envelope()}, id="no scope"),
        pytest.param({"document": envelope(), "pageId": "p1"}, id="a page id and no scope"),
        pytest.param({"document": envelope(), "scope": None}, id="a null scope"),
        pytest.param({"document": envelope(), "scope": ["page"]}, id="a list for the scope"),
        pytest.param({"document": envelope(), "scope": {"page": 1}}, id="an object for the scope"),
        pytest.param({"document": envelope(), "scope": "journey", "pageId": "p1"}, id="a page id on a journey check"),
        pytest.param({"document": envelope(), "scope": "page"}, id="a page check with no page id"),
        pytest.param({"document": envelope(), "scope": "page", "pageId": ""}, id="a page check with an empty page id"),
        pytest.param(envelope(), id="a bare envelope"),
        pytest.param({**envelope(), "scope": "journey"}, id="a bare envelope with a scope"),
        pytest.param({"document": envelope(), **envelope()}, id="the envelope beside the document"),
    ],
)
def test_a_validate_body_is_the_wrapper_with_a_scope_or_it_is_malformed_and_costs_nothing(
    parts: Parts, body: Any
) -> None:
    outcome = parts.service().validate(FormRef.from_document(), body, http_context())
    assert isinstance(outcome, Malformed)
    assert parts.trail == []
    assert parts.sandbox.validations == []


@pytest.mark.parametrize("scope", ["journey", "page"])
def test_a_validate_body_with_its_scope_is_judged(parts: Parts, scope: str) -> None:
    parts.repository.forms[FORM] = with_journeys()
    more = {"pageId": "p1"} if scope == "page" else {}
    outcome = parts.service().validate(FormRef.from_document(), journey_check(envelope(), scope, **more), bus())
    assert isinstance(outcome, Checked)


@pytest.mark.parametrize(
    "body",
    [
        pytest.param(envelope(), id="a bare envelope"),
        pytest.param({**envelope(), "submissionKey": "k-1"}, id="a bare envelope with a key"),
        pytest.param({"document": envelope(), "scope": "journey"}, id="a scope"),
    ],
)
def test_a_dry_run_body_is_the_wrapper_or_it_is_malformed_and_costs_nothing(parts: Parts, body: Any) -> None:
    outcome = parts.service().test(FormRef.from_document(), body, http_context())
    assert isinstance(outcome, Malformed)
    assert parts.trail == []
    assert parts.sandbox.validations == []


def test_a_page_the_journey_does_not_have_is_malformed_after_the_definition(parts: Parts) -> None:
    parts.repository.forms[FORM] = with_journeys()
    document = envelope(extra={"journey": {"id": "main"}})
    outcome = parts.service().validate(
        FormRef.from_document(), wrapped(document), http_context(), check=JourneyCheck("page", "nowhere")
    )
    assert isinstance(outcome, Malformed)
    assert parts.trail == ["throttle", "definition"]


def test_the_journey_verdict_comes_before_the_sandbox_is_taken(parts: Parts) -> None:
    def down() -> Any:
        parts.trail.append("sandbox_now")
        raise ProgramUnavailableError("down")

    parts.repository.forms[FORM] = with_journeys()
    document = envelope(extra={"journey": {"id": "nope"}})
    outcome = parts.service(sandbox=down).validate(FormRef.from_document(), journey_check(document), http_context())
    assert isinstance(outcome, Checked)
    assert [code for _, code, _ in outcome.errors] == ["journey.unknown"]
    assert parts.trail == ["throttle", "definition"]


def test_a_page_check_on_a_form_with_no_journey_is_malformed(parts: Parts) -> None:
    outcome = parts.service().validate(
        FormRef.from_document(), wrapped(envelope()), bus(), check=JourneyCheck("page", "p1")
    )
    assert isinstance(outcome, Malformed)


def test_a_check_named_by_the_caller_and_the_body_is_malformed(parts: Parts) -> None:
    body = {"document": envelope(), "scope": "journey"}
    outcome = parts.service().validate(FormRef.from_document(), body, bus(), check=JourneyCheck())
    assert isinstance(outcome, Malformed)


def test_a_journey_check_keeps_the_page_rule_together() -> None:
    with pytest.raises(ValueError, match="page"):
        JourneyCheck("page")
    with pytest.raises(ValueError, match="page"):
        JourneyCheck("journey", "p1")


# -- the customizers' draft, the contributors, the option snapshot -----------------------------------------------------
def test_the_run_words_come_from_the_settings_and_a_customizer_may_change_them(parts: Parts) -> None:
    def keep_unknown(form_key: str, form: Any, settings: RunSettings, context: SubmissionContext) -> None:
        settings.unknown_fields = UnknownFields.KEEP

    service = parts.service(log_level=LogLevel.INFO, host_options_customizers=[keep_unknown])
    service.submit(FormRef.from_document(), envelope(), bus())
    assert (parts.sent["unknownFields"], parts.sent["logLevel"]) == ("keep", "info")


def test_a_customizer_setting_a_word_the_program_does_not_read_is_unavailable(parts: Parts) -> None:
    def typo(form_key: str, form: Any, settings: Any, context: SubmissionContext) -> None:
        settings.unknown_fields = "strpi"

    outcome = parts.service(host_options_customizers=[typo]).submit(FormRef.from_document(), envelope(), bus())
    assert isinstance(outcome, Unavailable)
    assert outcome.code == "validator_unavailable"
    assert parts.sandbox.validations == []


def test_a_customizer_cannot_change_the_form_or_the_identity_the_run_judges(parts: Parts) -> None:
    def rewrite(form_key: str, form: Any, settings: Any, context: SubmissionContext) -> None:
        form["id"] = "other"
        form["root"]["children"]["content"].clear()

    parts.service(host_options_customizers=[rewrite]).submit(FormRef.from_document(), envelope(), bus())
    form = parts.sent["form"]
    assert parts.sent["formId"] == FORM
    assert isinstance(form, dict)
    assert json.dumps(form).count('"name"') == 1  # the stored form, untouched
    assert parts.repository.forms[FORM]["root"]["children"]["content"]


def test_a_rules_provider_cannot_change_the_form_or_the_identity_the_run_judges(parts: Parts) -> None:
    def rewrite(form_key: str, form: Any, context: SubmissionContext) -> list[Any]:
        form["id"] = "other"
        form["root"]["children"]["content"].clear()
        return []

    parts.service(rules_providers=[rewrite]).submit(FormRef.from_document(), envelope(), bus())
    form = parts.sent["form"]
    assert parts.sent["formId"] == FORM
    assert isinstance(form, dict)
    assert json.dumps(form).count('"name"') == 1  # the stored form, untouched
    assert parts.repository.forms[FORM]["root"]["children"]["content"]
    assert parts.repository.forms[FORM]["id"] == FORM


def test_contributed_entries_reach_the_run_as_external_data(parts: Parts) -> None:
    def tenant(context: SubmissionContext) -> Mapping[str, JsonValue]:
        return {"tenant": "acme"}

    parts.service(context_contributors=[tenant]).submit(FormRef.from_document(), envelope(), bus())
    assert parts.sent["externalData"] == {"tenant": "acme"}


def test_the_option_snapshot_reaches_the_run_with_values_and_text_labels_only(parts: Parts) -> None:
    parts.repository.forms[FORM] = definition(sourced=True)
    sources = DataSourceService([SourceProvider(parts.trail)])
    parts.service(data_sources=sources).submit(FormRef.from_document(), envelope(), bus())
    sources.close()
    assert parts.sent["optionSnapshot"] == {
        SOURCE: [{"value": "ca", "label": "Canada"}, {"value": "us", "label": "United States"}]
    }


def test_a_failing_option_snapshot_is_unavailable_server_unavailable_and_costs_no_run(parts: Parts) -> None:
    class Failing(SourceProvider):
        def items(self, request: Any) -> list[dict[str, JsonValue]]:
            raise RuntimeError("down")

    parts.repository.forms[FORM] = definition(sourced=True)
    sources = DataSourceService([Failing(parts.trail)])
    outcome = parts.service(data_sources=sources).submit(FormRef.from_document(), envelope(), bus())
    sources.close()
    assert isinstance(outcome, Unavailable)
    assert outcome.code == "server.unavailable"
    assert parts.sandbox.validations == []


def test_a_form_with_no_data_sourced_choice_sends_no_snapshot(parts: Parts) -> None:
    parts.service().submit(FormRef.from_document(), envelope(), bus())
    assert "optionSnapshot" not in parts.sent


# -- the dry run -------------------------------------------------------------------------------------------------------
def test_a_dry_run_reports_the_values_and_the_run_and_takes_its_own_log_level(parts: Parts) -> None:
    outcome = parts.service().test(FormRef.from_document(), wrapped(envelope()), http_context(), log_level="debug")
    assert isinstance(outcome, DryRun)
    assert outcome.values == {"name": "Ada Lovelace"}
    assert isinstance(outcome.report["sandbox"], dict)
    assert outcome.report["sandbox"]["logLevel"] == "debug"
    assert "elapsedMs" in outcome.report["sandbox"]
    assert parts.sent["logLevel"] == "debug"
    assert parts.sandbox.validations[-1][2] is False  # a dry run relays no run log
    assert parts.throttle.keys[0].kind == ThrottleKind.TEST
    assert parts.events == []


def test_a_throttled_dry_run_publishes_no_event(parts: Parts) -> None:
    parts.throttle.deny = 3
    outcome = parts.service().test(FormRef.from_document(), wrapped(envelope()), http_context())
    assert isinstance(outcome, Throttled)
    assert parts.events == []


def test_only_a_real_delivery_relays_the_run_log(parts: Parts) -> None:
    service = parts.service()
    service.validate(FormRef.from_document(), journey_check(envelope()), bus())
    service.submit(FormRef.from_document(), envelope(), bus())
    assert [real for _, _, real in parts.sandbox.validations] == [False, True]


# -- inspect -----------------------------------------------------------------------------------------------------------
def test_inspect_answers_the_programs_answer_as_it_gave_it(parts: Parts) -> None:
    outcome = parts.service().inspect("inspect", definition(), http_context())
    assert outcome == Inspected({"ok": True, "op": "inspect"})
    assert parts.trail == ["throttle", "sandbox.inspect"]
    assert (parts.throttle.keys[0].kind, parts.throttle.keys[0].form_key) == (ThrottleKind.TEST, FORM)


@pytest.mark.parametrize("op", ["", "two words", "x" * 65, "check;", "é"])
def test_an_inspect_op_that_is_no_word_is_malformed_and_costs_nothing(parts: Parts, op: str) -> None:
    assert isinstance(parts.service().inspect(op, definition(), http_context()), Malformed)
    assert parts.trail == []


def test_an_inspect_definition_over_the_cap_or_no_object_is_refused_before_the_throttle(parts: Parts) -> None:
    service = parts.service(max_document_bytes=100)
    assert isinstance(service.inspect("check", definition(), http_context()), TooLarge)
    assert isinstance(parts.service().inspect("check", ["a"], http_context()), Malformed)
    assert parts.trail == []


def test_an_inspect_the_sandbox_refuses_is_unavailable_under_its_own_code(parts: Parts) -> None:
    parts.sandbox.error = DefinitionTooDeepError(32, "deep")
    outcome = parts.service().inspect("check", definition(), bus())
    assert isinstance(outcome, Unavailable)
    assert outcome.code == "definition.tooDeep"


# -- the signature slot and the seams ----------------------------------------------------------------------------------
def test_the_signature_slot_takes_none_only_until_the_passkey_capability(parts: Parts) -> None:
    with pytest.raises(DatumConfigurationError, match="signature"):
        parts.service(signature_check=object())


def test_a_handler_that_answers_no_receipt_reaches_the_caller_as_a_type_error(parts: Parts) -> None:
    def handler(accepted: Any) -> Any:
        return {"id": "x"}

    with pytest.raises(TypeError, match="SubmissionReceipt"):
        parts.service(handler=handler).submit(FormRef.from_document(), envelope(), bus())
    assert parts.idempotency.records == []


class ForgetfulStore(RecordingIdempotency):
    """Answers finds; fails every record."""

    def record(
        self, form_key: str, version: str, submission_key: str, remembered: RememberedReceipt
    ) -> RememberedReceipt:
        raise OSError("disk full")


class BlindStore(RecordingIdempotency):
    """Fails every find."""

    def find(self, form_key: str, version: str, submission_key: str) -> RememberedReceipt | None:
        raise OSError("disk gone")


class CoroutineFind(RecordingIdempotency):
    """A store whose `find` is a coroutine function: with no awaiter the service cannot resolve it."""

    async def find(  # type: ignore[override]
        self, form_key: str, version: str, submission_key: str
    ) -> RememberedReceipt | None:
        return None


class CoroutineRecord(RecordingIdempotency):
    """A store whose `record` is a coroutine function."""

    async def record(  # type: ignore[override]
        self, form_key: str, version: str, submission_key: str, remembered: RememberedReceipt
    ) -> RememberedReceipt:
        return remembered


def test_a_store_find_that_needs_an_awaiter_that_is_missing_reaches_the_caller_as_raised(parts: Parts) -> None:
    service = parts.service(idempotency_store=CoroutineFind(parts.trail), awaiter=None)
    with pytest.raises(DatumConfigurationError, match=r"awaiter|bridge"):
        service.submit(FormRef.from_document(), envelope(), bus())
    assert parts.handler.calls == []


def test_a_store_record_that_needs_an_awaiter_that_is_missing_raises_after_the_effect_happened(parts: Parts) -> None:
    # The handler ran (the effect happened) and the caller still sees the configuration error.
    service = parts.service(idempotency_store=CoroutineRecord(parts.trail), awaiter=None)
    with pytest.raises(DatumConfigurationError):
        service.submit(FormRef.from_document(), envelope(), bus())
    assert len(parts.handler.calls) == 1


def test_a_store_that_fails_to_keep_the_receipt_leaves_the_answer_standing(parts: Parts) -> None:
    store = ForgetfulStore(parts.trail)
    outcome = parts.service(idempotency_store=store).submit(FormRef.from_document(), envelope(), bus())
    assert isinstance(outcome, Accepted)
    assert outcome.receipt.id == "id-1"


def test_a_store_that_fails_to_answer_is_unavailable_before_the_handler(parts: Parts) -> None:
    store = BlindStore(parts.trail)
    outcome = parts.service(idempotency_store=store).submit(FormRef.from_document(), envelope(), bus())
    assert isinstance(outcome, Unavailable)
    assert outcome.code == "server.unavailable"
    assert parts.handler.calls == []
