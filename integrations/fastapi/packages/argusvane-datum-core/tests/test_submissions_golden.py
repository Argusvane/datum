"""The golden verdicts CTL-01 to CTL-04 through `SubmissionService`: the fake sandbox answers the golden tokens, and
(marker `runtime`) the real engine answers them for the conformance kit's fixture form.

A refused control is a `Rejected` whose `code@field` tokens equal the golden file's; CTL-01 is an `Accepted` with the
handler called once. The same documents give the same verdicts through a `bus` caller and an `http` one.
"""

from collections.abc import Iterator
from typing import Any

import pytest
from submissions_support import Repository, attr_of, bus, definition, envelope, http_context, started

from datum_core import Datum, DatumConfig
from datum_core.canonical import canonical_digest
from datum_core.forms import StoredDefinition
from datum_core.submissions import (
    Accepted,
    AcceptedSubmission,
    FormRef,
    Rejected,
    SubmissionContext,
    SubmissionOutcome,
    SubmissionReceipt,
)
from datum_sandbox.protocol import SandboxResult
from datum_sandbox.testing.fixtures import endpoint_form, golden
from datum_sandbox.testing.runtime_support import control_values

CONTROLS = ["CTL-01", "CTL-02", "CTL-03", "CTL-04"]
FORM_ID = "datum-security-suite"


def tokens(outcome: SubmissionOutcome) -> list[str]:
    assert isinstance(outcome, Rejected)
    return sorted(f"{code}@{field}" for field, code, _ in outcome.errors)


def kernel_verdict(control: str) -> SandboxResult:
    """The sandbox's answer for a control as the golden file states it."""
    want = golden()["controls"][control]
    errors: list[Any] = []
    for token in want["errors"]:
        code, _, field = token.partition("@")
        errors.append({"code": code, "componentId": field, "path": field, "severity": "error"})
    values: dict[str, Any] = want.get("values", {})
    return SandboxResult({"errors": errors, "values": values}, 0.01)


def document(control: str) -> dict[str, Any]:
    return envelope(form=FORM_ID, values=control_values()[control])


@pytest.mark.parametrize("control", CONTROLS)
@pytest.mark.parametrize("context", [bus(), http_context()], ids=["bus", "http"])
def test_the_service_gives_the_golden_verdict_for_a_control_on_either_channel(
    control: str, context: SubmissionContext
) -> None:
    trail: list[str] = []
    with started(form_repository=Repository(trail, definition(FORM_ID))) as rig:
        rig.sandbox.verdict = kernel_verdict(control)
        outcome = rig.submit(document(control), context)
    want = golden()["controls"][control]
    if want["accepted"]:
        assert isinstance(outcome, Accepted)
        assert len(rig.handler.calls) == 1
    else:
        assert tokens(outcome) == sorted(want["errors"])
        assert rig.handler.calls == []


@pytest.fixture
def real_datum(request: pytest.FixtureRequest) -> Iterator[Datum]:
    if hasattr(request.config, "workerinput"):
        pytest.skip("tests marked runtime never run under xdist: run them in one process")
    form = endpoint_form()

    class FixtureRepository:
        def current(self, key: str) -> StoredDefinition | None:
            return StoredDefinition(key, form, canonical_digest(form)) if key == FORM_ID else None

    def handle(accepted: AcceptedSubmission) -> SubmissionReceipt:
        return SubmissionReceipt(id=f"id-{accepted.digest[:8]}", reference="R")

    datum = Datum(
        config=DatumConfig.model_validate({"runtime": {"warm_up_runs": 1}}),
        form_repository=FixtureRepository(),
        handler=handle,
    )
    datum.start()
    try:
        yield datum
    finally:
        datum.stop()


@pytest.mark.runtime
@pytest.mark.parametrize("control", CONTROLS)
def test_the_real_engine_gives_the_golden_verdict_through_the_service(real_datum: Datum, control: str) -> None:
    outcome = real_datum.submission_service.submit(FormRef.from_document(), document(control), bus())
    want = golden()["controls"][control]
    if want["accepted"]:
        assert isinstance(outcome, Accepted)
        assert outcome.submission.values == want["values"]
    else:
        assert tokens(outcome) == sorted(want["errors"])


@pytest.mark.runtime
def test_the_real_engine_redelivers_a_golden_document_with_the_first_receipt(real_datum: Datum) -> None:
    service = real_datum.submission_service
    first = service.submit(FormRef.from_document(), document("CTL-01"), bus(submission_key="attempt-1"))
    again = service.submit(FormRef.from_document(), document("CTL-01"), http_context(submission_key="attempt-1"))
    assert isinstance(first, Accepted)
    assert type(again).__name__ == "Redelivered"
    assert attr_of(again, "receipt") == first.receipt


@pytest.mark.runtime
def test_the_real_engines_refusal_of_a_malformed_depth_is_malformed_before_any_run(real_datum: Datum) -> None:
    node: dict[str, Any] = {"leaf": 1}
    for _ in range(70):
        node = {"n": node}
    outcome = real_datum.submission_service.submit(FormRef.from_document(), envelope(form=FORM_ID, values=node), bus())
    assert type(outcome).__name__ == "Malformed"
