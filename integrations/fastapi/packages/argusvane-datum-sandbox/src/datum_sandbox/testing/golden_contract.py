"""`GoldenVerdictsContract`: the real program answers what the security suite pins for the sandbox ABI.

The golden case's outcome bytes (UTF-16 length and SHA-256), sent as a host serialises it (keys sorted, no host options
merged, so the program sees what the golden writer's kernel saw), and the six control vectors CTL-01 to CTL-06 through
`SandboxService` (host options merged, as an endpoint runs them): their accepted flag, error tokens and
sanitised values.
"""

# ruff: noqa: S101 - a contract is assertions

import statistics
import time
from typing import Any

from datum_sandbox.json import JsonValue
from datum_sandbox.protocol import ProgramLimits, new_nonce, sandbox_answer, utf16_units
from datum_sandbox.testing._base import ContractBase
from datum_sandbox.testing.fixtures import endpoint_form, golden, sha256_hex
from datum_sandbox.testing.runtime_support import (
    budget,
    control_values,
    golden_case_context,
    sandbox_run,
    service,
    stable_json,
    valid_values,
)
from datum_sandbox.wasi import GuestRuntime


def _tokens(outcome: dict[str, JsonValue]) -> tuple[list[str], bool]:
    """Return the sorted `code@field` tokens of an outcome's errors, and whether only warnings and infos were found."""
    tokens: list[str] = []
    accepted = True
    errors = outcome["errors"]
    assert isinstance(errors, list)
    for error in errors:
        assert isinstance(error, dict)
        path = error.get("path")
        component = error.get("componentId")
        field = path if isinstance(path, str) and path else (component if isinstance(component, str) else "")
        code = error["code"]
        tokens.append(f"{code}@{field}" if field else str(code))
        severity = error.get("severity", "error")
        accepted = accepted and severity in {"warning", "info"}
    return sorted(tokens), accepted


class GoldenVerdictsContract(ContractBase):
    """The golden contract: byte-for-byte pinned outcomes and the control verdicts."""

    def test_the_golden_case_outcome_is_byte_for_byte_pinned(self, runtime: GuestRuntime) -> None:
        """The outcome's UTF-16 length and SHA-256 equal the golden file's."""
        pinned: dict[str, Any] = golden()["goldenCase"]
        nonce = new_nonce()
        run_budget = budget(30, 64)
        result = sandbox_run(runtime, nonce, run_budget, body=stable_json(golden_case_context()))
        answer = sandbox_answer(result, nonce, run_budget)
        assert utf16_units(answer) == pinned["canonicalLength"]
        assert sha256_hex(answer) == pinned["canonicalSha256"]

    def test_the_control_vectors_match_their_golden_verdicts(self, runtime: GuestRuntime) -> None:
        """CTL-01 to CTL-06 through the service: accepted flag, error tokens and values equal the golden file's."""
        controls: dict[str, Any] = golden()["controls"]
        definition = endpoint_form()
        sandbox = service(runtime)
        answers = control_values()
        assert sorted(answers) == sorted(controls), (
            "the vectors this contract sends are the vectors the golden file pins"
        )
        for key in sorted(answers):
            context: dict[str, JsonValue] = {
                "formId": definition["id"],
                "values": answers[key],
                "locale": "en",
                "form": definition["root"],
            }
            outcome = sandbox.validate(context, real=False).outcome
            tokens, accepted = _tokens(outcome)
            want = controls[key]
            assert accepted == want["accepted"], f"{key} accepted"
            assert tokens == sorted(want["errors"]), f"{key} errors"
            if "values" in want:
                assert outcome["values"] == want["values"], f"{key} values"

    def test_the_warm_validation_stays_inside_its_budget(self, runtime: GuestRuntime) -> None:
        """The median of ten warm validations of CTL-01 is under the validation time limit."""
        definition = endpoint_form()
        sandbox = service(runtime)
        context: dict[str, JsonValue] = {
            "formId": definition["id"],
            "values": valid_values(),
            "locale": "en",
            "form": definition["root"],
        }
        for _ in range(5):
            sandbox.validate(context, real=False)
        times: list[float] = []
        for _ in range(10):
            began = time.monotonic()
            sandbox.validate(context, real=False)
            times.append(time.monotonic() - began)
        assert statistics.median(times) < ProgramLimits().validation_time_limit
