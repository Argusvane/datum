"""`Datum` and the submissions seams: the keywords, their defaults, and the service it builds."""

import inspect
import json
import logging
import typing
from pathlib import Path
from typing import Any, get_type_hints

import pytest
from submissions_support import bus, definition, envelope, plain_datum

from datum_core import Datum, DatumNotStartedError, submissions
from datum_core.datum import DatumOptions
from datum_core.forms import FileFormDefinitionRepository
from datum_core.submissions import (
    FormRef,
    NotFound,
    PreCheckStatuses,
    Reject,
    SubmissionReceipt,
    SubmissionService,
)
from datum_core.throttle import LimitsThrottle

KEYWORDS = [
    "handler",
    "pre_checks",
    "pre_check_statuses",
    "host_options_customizers",
    "rules_providers",
    "context_contributors",
    "validators",
    "throttle",
    "idempotency_store",
    "signature_check",
]


def bare(**seams: Any) -> Datum:
    return plain_datum({}, **seams)


@pytest.mark.parametrize("keyword", KEYWORDS)
def test_each_hook_and_store_is_a_keyword_only_seam_a_binding_can_pass_on(keyword: str) -> None:
    parameter = inspect.signature(Datum).parameters[keyword]
    assert parameter.kind is inspect.Parameter.KEYWORD_ONLY
    assert keyword in get_type_hints(DatumOptions)


@pytest.mark.parametrize(
    "keyword",
    ["pre_checks", "host_options_customizers", "rules_providers", "context_contributors", "validators"],
)
def test_a_hook_sequence_defaults_to_nothing_and_keeps_the_list_order(keyword: str) -> None:
    first, second = (lambda *a: None), (lambda *a: None)
    datum = bare(**{keyword: [first, second]})
    assert getattr(datum, keyword) == (first, second)
    assert getattr(bare(), keyword) == ()


def test_the_defaults_are_standard_statuses_the_limits_throttle_and_no_signature_check() -> None:
    datum = bare()
    assert datum.pre_check_statuses(Reject("any.code", "m")) == 403
    assert isinstance(datum.throttle, LimitsThrottle)
    assert datum.signature_check is None
    assert datum.handler is not None


def test_an_application_throttle_handler_and_statuses_are_used_as_given() -> None:
    class Throttle:
        def check(self, key: Any) -> Any: ...
        def record(self, key: Any) -> None: ...

    def handle(accepted: Any) -> SubmissionReceipt:
        return SubmissionReceipt("1", "R")

    own = PreCheckStatuses.by_suffix()
    datum = bare(throttle=Throttle(), handler=handle, pre_check_statuses=own)
    assert isinstance(datum.throttle, Throttle)
    assert datum.handler is handle
    assert datum.pre_check_statuses is own


def test_the_submission_service_exists_only_while_started() -> None:
    datum = bare()
    with pytest.raises(DatumNotStartedError):
        _ = datum.submission_service
    datum.start()
    try:
        assert isinstance(datum.submission_service, SubmissionService)
    finally:
        datum.stop()
    with pytest.raises(DatumNotStartedError):
        _ = datum.submission_service


def test_a_started_datum_with_no_forms_answers_not_found_and_needs_no_awaiter() -> None:
    datum = bare()
    datum.start()
    try:
        outcome = datum.submission_service.submit(FormRef.from_document(), envelope(), bus())
    finally:
        datum.stop()
    assert isinstance(outcome, NotFound)


@pytest.mark.parametrize(
    "name", ["SubmissionHandler", "SubmissionPreCheck", "SubmissionValidator", "ContextContributor", "RulesProvider"]
)
def test_a_one_method_hook_is_a_callable_type_alias_not_a_protocol(name: str) -> None:
    assert isinstance(getattr(submissions, name), typing.TypeAliasType)


def test_the_service_class_is_not_a_runtime_checkable_protocol() -> None:
    assert not getattr(SubmissionService, "_is_runtime_protocol", False)


# -- the form files load for every route that resolves a form by its id ------------------------------------------------
FORMS_LOGGER = "datum.forms"


def _form_file(directory: Path) -> str:
    path = directory / "contact.json"
    path.write_text(json.dumps(definition("contact")), encoding="utf-8")
    return str(path)


def _forms_held(config: dict[str, Any]) -> list[str]:
    datum = plain_datum(config)
    datum.start()
    try:
        repository = datum.form_repository
        assert isinstance(repository, FileFormDefinitionRepository)
        return list(repository.keys())
    finally:
        datum.stop()


def _on(locations: list[str], **endpoints: bool) -> dict[str, Any]:
    return {"forms": {"locations": locations}, "web": {"api": {"endpoints": endpoints}}}


@pytest.mark.parametrize("switch", ["submissions", "validate", "test", "definition", "pdf", "fill"])
def test_a_route_that_resolves_a_form_by_id_loads_the_form_files_on_its_own(tmp_path: Path, switch: str) -> None:
    assert _forms_held(_on([_form_file(tmp_path)], **{switch: True})) == ["contact"]


def test_the_builder_loads_the_form_files(tmp_path: Path) -> None:
    config = {"forms": {"locations": [_form_file(tmp_path)]}, "builder": {"enabled": True}}
    assert _forms_held(config) == ["contact"]


def test_no_form_route_on_loads_nothing_and_does_not_warn_about_the_default_location(
    caplog: pytest.LogCaptureFixture,
) -> None:
    with caplog.at_level(logging.WARNING, logger=FORMS_LOGGER):
        assert _forms_held({}) == []
    assert [r for r in caplog.records if r.name == FORMS_LOGGER] == []


def test_a_form_route_on_with_a_location_that_matches_nothing_still_warns(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    config = _on([str(tmp_path / "none" / "*.json")], submissions=True)
    with caplog.at_level(logging.WARNING, logger=FORMS_LOGGER):
        assert _forms_held(config) == []
    assert [r for r in caplog.records if r.name == FORMS_LOGGER and r.levelno == logging.WARNING]


def test_a_submission_finds_the_form_with_only_the_submissions_switch_on(tmp_path: Path) -> None:
    datum = plain_datum(_on([_form_file(tmp_path)], submissions=True))
    datum.start()
    try:
        outcome = datum.submission_service.submit(FormRef.from_document(), envelope(form="contact"), bus())
    finally:
        datum.stop()
    assert not isinstance(outcome, NotFound)
