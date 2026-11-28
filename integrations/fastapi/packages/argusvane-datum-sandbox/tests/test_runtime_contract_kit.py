"""The runtime contract kit's own tests: the fixtures load, the declarations bite, and the contracts are red on a fake.

The contracts run on the real QuickJS in `argusvane-datum-sandbox-wasmtime`'s tests; here a fake runtime shows that they
notice a wrong engine (every case fails, or xfails strictly for a declared limit), that an unregistered engine is
skipped, that nothing marked `runtime` runs under xdist, and, with a fake that is right about the kit's own scripts and
one fault at a time, that each output-cap assertion has a way to fail.
"""

import hashlib
import json
import os
import subprocess
import sys
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from pathlib import Path

import pytest
from fake_runtime import FakeGuestRuntime, Faults, ScriptedRuntime

from datum_sandbox.protocol import PDF_ABI_MIN, SANDBOX_ABI_MIN, ProgramKind, SandboxError
from datum_sandbox.testing import Capability, RuntimeCapabilities, RuntimeContract, requires
from datum_sandbox.testing import fixtures as fx
from datum_sandbox.testing.runtime_capabilities import required_by
from datum_sandbox.testing.runtime_support import (
    LINE_BYTES,
    expected_prefix,
    golden_case_context,
    producer_script,
    stable_json,
    stand_in_program,
)

HERE = Path(__file__).resolve().parent
BINDING = HERE / "fake_contract_binding.py"
DECLARED = HERE / "fake_contract_declared_binding.py"


# -- the fixtures loader -----------------------------------------------------------------------------------------------


def test_the_programs_load_from_datum_programs_with_their_pinned_digests() -> None:
    sandbox, pdf = fx.sandbox_program(), fx.pdf_program()
    assert (sandbox.kind, pdf.kind) == (ProgramKind.SANDBOX, ProgramKind.PDF)
    assert sandbox.sha256 == fx.sha256_hex(sandbox.data) != pdf.sha256
    assert fx.freeze_snippet().strip() != ""
    assert len(fx.font_bytes("DejaVuSans.ttf")) > 1000


def test_a_program_that_no_longer_matches_programs_json_is_refused(monkeypatch: pytest.MonkeyPatch) -> None:
    def tampered(name: str) -> bytes:
        return b"tampered" if name.endswith(".js") else b"x"

    monkeypatch.setattr(fx, "_resource", tampered)
    with pytest.raises(fx.FixturesNotFoundError, match=r"does not match its digest|lists no"):
        fx.program_file("datum-sandbox-program.js")


def test_the_golden_file_is_the_conformance_suites_by_sha256() -> None:
    golden = fx.fixtures_dir() / fx.GOLDEN
    repo = next((p for p in HERE.parents if (p / "packages" / "conformance-suite").is_dir()), None)
    if repo is None:
        pytest.skip("not inside the monorepo: the source golden file is not here")
    source = repo / "packages" / "conformance-suite" / "golden" / "abi-1.0.json"
    assert hashlib.sha256(golden.read_bytes()).hexdigest() == hashlib.sha256(source.read_bytes()).hexdigest()
    # The golden file is the current ABI's; the floor a host accepts is of the same major, no newer.
    assert fx.golden()["abi"].split(".")[0] == SANDBOX_ABI_MIN.split(".")[0]
    assert tuple(int(part) for part in fx.golden()["abi"].split(".")) >= tuple(
        int(part) for part in SANDBOX_ABI_MIN.split(".")
    )
    assert sorted(fx.golden()["controls"]) == ["CTL-01", "CTL-02", "CTL-03", "CTL-04", "CTL-05", "CTL-06"]


def test_the_pdf_documents_and_hashes_are_the_pdf_kernels_by_sha256() -> None:
    repo = next((p for p in HERE.parents if (p / "packages" / "pdf-kernel").is_dir()), None)
    hashes = fx.pdf_hashes()
    assert set(hashes) == {"datum-pdf", "gcds", "uswds"}
    for theme in hashes:
        assert fx.pdf_document(theme)["version"] == "1"
        if repo is not None:
            source = repo / "packages" / "pdf-kernel" / "tests" / "fixtures" / "documents-3.8" / f"{theme}.json"
            assert source.read_bytes() == fx.fixture_bytes(f"{fx.DOCUMENTS}/{theme}.json")
    assert PDF_ABI_MIN.startswith("1.")


def test_the_stand_in_program_for_the_stale_abi_is_the_suites_stale_program_byte_for_byte() -> None:
    assert stand_in_program("0.9.0").data == fx.stale_program()


def test_the_hardening_rules_and_the_endpoint_form_are_present() -> None:
    assert "datum-tck-loop" in fx.hardening_rules()
    assert fx.endpoint_form()["root"]["type"] == "form"


def test_missing_fixtures_say_where_to_look(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    fx.fixtures_dir.cache_clear()
    monkeypatch.setenv(fx.FIXTURES_ENV, str(tmp_path))
    try:
        with pytest.raises(fx.FixturesNotFoundError, match=fx.FIXTURES_ENV):
            fx.fixtures_dir()
    finally:
        monkeypatch.undo()
        fx.fixtures_dir.cache_clear()


def test_the_golden_inputs_are_what_the_suite_serialises() -> None:
    text = stable_json({"b": 1, "a": [{"z": 1, "y": 2}]})
    assert text == '{"a":[{"y":2,"z":1}],"b":1}'
    case = json.loads(stable_json(golden_case_context()))
    assert len(case["values"]["rows"]) == 60
    assert case["reportFold"] is True


# -- declarations ------------------------------------------------------------------------------------------------------


def test_requires_marks_a_function_and_the_declaration_reads_it() -> None:
    @requires(Capability.PDF, Capability.OUTPUT_CAP)
    def case() -> None: ...

    assert required_by(case) == (Capability.PDF, Capability.OUTPUT_CAP)
    caps = RuntimeCapabilities(lacks={Capability.PDF: "no PDF kernel"})
    assert caps.missing(required_by(case)) == {Capability.PDF: "no PDF kernel"}
    assert RuntimeCapabilities().missing(required_by(case)) == {}


def test_a_declared_limit_needs_a_reason() -> None:
    with pytest.raises(ValueError, match="needs a reason"):
        RuntimeCapabilities(lacks={Capability.PDF: "  "})


# -- the contracts, red on a fake --------------------------------------------------------------------------------------


def _child(*args: str, junit: Path, target: Path = BINDING) -> subprocess.CompletedProcess[str]:
    env = {k: v for k, v in os.environ.items() if not k.startswith("PYTEST_")}
    command = [
        sys.executable, "-m", "pytest", str(target), "-p", "no:cacheprovider", "-p", "no:randomly", "-q",
        f"--junitxml={junit}", "-c", str(HERE.parent / "pyproject.toml"), *args,
    ]  # fmt: skip
    return subprocess.run(command, capture_output=True, text=True, env=env, cwd=HERE.parent, timeout=300, check=False)  # noqa: S603


def _outcomes(junit: Path) -> dict[str, str]:
    """Return `Class::test` -> `passed`, `failed`, `error`, `skipped` or `xfailed` from a junit file."""
    result: dict[str, str] = {}
    for case in ET.parse(junit).getroot().iter("testcase"):  # noqa: S314 - our own child's report
        name = f"{case.get('classname', '').rsplit('.', 1)[-1]}::{case.get('name', '')}"
        if case.find("failure") is not None:
            result[name] = "failed"
        elif case.find("error") is not None:
            result[name] = "error"
        elif (skipped := case.find("skipped")) is not None:
            result[name] = "xfailed" if skipped.get("type") == "pytest.xfail" else "skipped"
        else:
            result[name] = "passed"
    return result


@pytest.fixture(scope="module")
def red_run(tmp_path_factory: pytest.TempPathFactory) -> dict[str, str]:
    junit = tmp_path_factory.mktemp("junit") / "fake.xml"
    child = _child("-k", "TestFakeEngine", junit=junit)
    assert junit.exists(), child.stdout + child.stderr
    return _outcomes(junit)


# The cases a wrong engine can still pass: the depth guard refuses before any guest runs.
FAKE_PASSES = {
    "TestFakeEngine::test_a_definition_nested_past_the_limit_is_refused_before_any_guest_starts",
}


def test_every_contract_case_is_red_or_a_declared_limit_on_a_fake_engine(red_run: dict[str, str]) -> None:
    assert len(red_run) >= 40, f"the suite collects: {len(red_run)} cases"
    assert not [name for name, kind in red_run.items() if kind == "error"], "red means failed, never a setup error"
    passed = {name for name, kind in red_run.items() if kind == "passed"}
    assert passed <= FAKE_PASSES, f"cases a wrong engine passes: {sorted(passed - FAKE_PASSES)}"
    assert sum(1 for kind in red_run.values() if kind == "failed") >= 35


def test_a_declared_limit_is_a_strict_expected_failure(red_run: dict[str, str]) -> None:
    xfailed = {name.split("::")[1] for name, kind in red_run.items() if kind == "xfailed"}
    assert "test_the_theme_documents_render_to_their_pinned_hashes" in xfailed, "PDF declared lacking"
    assert "test_a_run_past_its_memory_ends_by_itself_and_keeps_its_output" in xfailed, "memory declared lacking"
    assert "test_a_memory_bomb_stops_at_the_limit_and_the_next_run_answers" in xfailed


def test_a_declared_limit_that_is_not_true_turns_red(tmp_path: Path) -> None:
    junit = tmp_path / "xpass.xml"
    child = _child("-k", "TestDeclaredButTrue and test_a_run_stopped_at_its_budget", junit=junit, target=DECLARED)
    outcomes = _outcomes(junit)
    assert outcomes, child.stdout + child.stderr
    assert set(outcomes.values()) == {"failed"}, (
        "XPASS(strict): a limit that was fixed fails until the declaration goes"
    )
    assert "XPASS(strict)" in child.stdout


def test_an_unregistered_engine_is_skipped_not_failed(tmp_path: Path) -> None:
    junit = tmp_path / "skip.xml"
    child = _child("-k", "TestUnregisteredEngine", junit=junit)
    outcomes = _outcomes(junit)
    assert outcomes, child.stdout + child.stderr
    assert set(outcomes.values()) == {"skipped"}, child.stdout
    assert child.returncode == 0


def test_nothing_marked_runtime_runs_under_xdist(tmp_path: Path) -> None:
    junit = tmp_path / "xdist.xml"
    child = _child("-n", "2", "-k", "TestFakeEngine", junit=junit)
    outcomes = _outcomes(junit)
    assert outcomes, child.stdout + child.stderr
    assert set(outcomes.values()) == {"skipped"}, "a worker skips every runtime case"
    assert child.returncode == 0


# -- each output-cap assertion can fail (a fake that is right about the kit's scripts, one fault at a time) ------------


@dataclass(frozen=True)
class _Seen:
    out: str = ""
    err: str = ""


class _Quiet:
    """A `capfd` that saw nothing."""

    @staticmethod
    def readouterr() -> _Seen:
        return _Seen()


class _Noisy:
    """A `capfd` that saw a print from the engine."""

    @staticmethod
    def readouterr() -> _Seen:
        return _Seen(out="failed custom output\n")


CAP_CASES = [(64 * 1024, 4096), (64 * 1024 + 100, 4096), (1023, 64), (1, 64), (64 * 1024 - 1, 64)]


@pytest.mark.parametrize(("cap", "lines"), CAP_CASES)
def test_the_finite_cap_case_passes_a_correct_engine(cap: int, lines: int) -> None:
    RuntimeContract().test_a_finite_producer_past_the_stdout_cap_keeps_exactly_the_first_cap_bytes(
        ScriptedRuntime(),
        _Quiet(),
        cap,
        lines,
    )


@pytest.mark.parametrize(
    "fault",
    [
        Faults(overrun=1),
        Faults(corrupt_prefix=True),
        Faults(no_flag=True),
        Faults(clean_end=True),
    ],
    ids=["one-byte-past-the-cap", "wrong-prefix", "no-flag", "clean-end"],
)
@pytest.mark.parametrize(("cap", "lines"), CAP_CASES)
def test_the_finite_cap_case_fails_a_faulty_engine(cap: int, lines: int, fault: Faults) -> None:
    with pytest.raises(AssertionError):
        RuntimeContract().test_a_finite_producer_past_the_stdout_cap_keeps_exactly_the_first_cap_bytes(
            ScriptedRuntime(fault),
            _Quiet(),
            cap,
            lines,
        )


def test_the_exact_fit_case_passes_a_correct_engine() -> None:
    RuntimeContract().test_a_finite_producer_that_exactly_fits_the_stdout_cap_ends_clean(ScriptedRuntime(), _Quiet())


def test_the_exact_fit_case_fails_an_engine_that_flags_at_the_cap() -> None:
    with pytest.raises(AssertionError):
        RuntimeContract().test_a_finite_producer_that_exactly_fits_the_stdout_cap_ends_clean(
            ScriptedRuntime(Faults(flag_at_cap=True)), _Quiet()
        )


def test_the_finite_cap_case_fails_an_engine_that_prints_on_the_process_streams() -> None:
    with pytest.raises(AssertionError, match="own streams"):
        RuntimeContract().test_a_finite_producer_past_the_stdout_cap_keeps_exactly_the_first_cap_bytes(
            ScriptedRuntime(),
            _Noisy(),
            64 * 1024,
            4096,
        )


@pytest.mark.parametrize("cap", [64 * 1024, 64 * 1024 + 100])
def test_the_endless_case_passes_a_correct_engine_and_fails_a_late_or_overrunning_one(cap: int) -> None:
    contract = RuntimeContract()
    contract.test_an_endless_producer_ends_within_its_wall_budget_with_the_exact_prefix(
        ScriptedRuntime(),
        _Quiet(),
        cap,
        1.0,
    )
    for fault in (Faults(late=2.0), Faults(overrun=1), Faults(clean_end=True)):
        with pytest.raises(AssertionError):
            contract.test_an_endless_producer_ends_within_its_wall_budget_with_the_exact_prefix(
                ScriptedRuntime(fault),
                _Quiet(),
                cap,
                1.0,
            )


def test_the_stderr_case_passes_a_correct_engine_and_fails_a_wrong_one() -> None:
    contract = RuntimeContract()
    contract.test_a_stderr_past_its_cap_keeps_exactly_the_first_cap_bytes(ScriptedRuntime(), _Quiet(), 1000)
    with pytest.raises(AssertionError):
        contract.test_a_stderr_past_its_cap_keeps_exactly_the_first_cap_bytes(
            FakeGuestRuntime(),
            _Quiet(),
            1000,
        )


def test_the_race_case_passes_a_correct_engine_and_fails_a_second_frame() -> None:
    contract = RuntimeContract()
    contract.test_a_looping_run_beside_fifteen_honest_runs_every_honest_run_answers(ScriptedRuntime())
    with pytest.raises(SandboxError, match=r"no outcome|frame"):
        contract.test_a_looping_run_beside_fifteen_honest_runs_every_honest_run_answers(
            ScriptedRuntime(Faults(second_frame=True))
        )


def test_the_settled_runs_case_passes_a_correct_engine_and_fails_a_leaked_thread() -> None:
    contract = RuntimeContract()
    contract.test_a_hundred_settled_runs_add_no_thread_and_only_bounded_memory(ScriptedRuntime())
    leaking = ScriptedRuntime(Faults(leak_thread=True))
    try:
        with pytest.raises(AssertionError, match="threads left behind"):
            contract.test_a_hundred_settled_runs_add_no_thread_and_only_bounded_memory(leaking)
    finally:
        for hold in leaking.leaked:
            hold.set()


def test_the_budget_case_passes_a_correct_engine() -> None:
    RuntimeContract().test_a_run_stopped_at_its_budget_keeps_the_started_marker_and_the_next_run_answers(
        ScriptedRuntime()
    )


def test_the_producer_helpers_agree() -> None:
    assert len(expected_prefix(LINE_BYTES)) == LINE_BYTES
    assert producer_script(1).startswith("var tail")
