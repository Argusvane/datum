"""Typing: mypy and pyright, both strict, accept the builder's hook, event and outcome shapes and reject the
wrong ones.

The accepted file imports `datum_core.builder`; the rejected ones are kept as `.py.txt` so the project's own type run
never sees them. Each rejected case asserts the one error, its line and its code.
"""

import shutil
import subprocess
import sys
from pathlib import Path

import pytest

CASES = Path(__file__).parent / "typing_cases"
GOOD = CASES / "hooks_builder_good.py"

# (case, the line, mypy's error code, pyright's rule)
BAD_CASES = [
    ("builder_bad_customizer", 7, "assignment", "reportAssignmentType"),
    ("builder_bad_validator", 8, "assignment", "reportAssignmentType"),
    ("builder_bad_outcome_match", 13, "arg-type", "reportArgumentType"),
    ("builder_bad_saved_listener", 7, "arg-type", "reportArgumentType"),
    ("builder_bad_hooks_keyword", 7, "list-item", "reportArgumentType"),
]
NO_PYRIGHT = shutil.which("node") is None and shutil.which("pyright") is None


def run(*command: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(  # noqa: S603
        [sys.executable, "-m", *command], capture_output=True, text=True, check=False, timeout=600
    )


def test_mypy_strict_accepts_the_builder_hooks_the_saved_event_and_the_exhaustive_match() -> None:
    result = run("mypy", "--config-file", str(CASES / "mypy.ini"), "--no-incremental", str(GOOD))
    assert result.returncode == 0, result.stdout + result.stderr


@pytest.mark.skipif(NO_PYRIGHT, reason="pyright needs node or its wrapper")
def test_pyright_strict_accepts_the_same_shapes() -> None:
    result = run("pyright", "--project", str(CASES), "--pythonpath", sys.executable, str(GOOD))
    assert result.returncode == 0, result.stdout + result.stderr


@pytest.mark.parametrize(("case", "line", "mypy_code", "pyright_rule"), BAD_CASES, ids=[c[0] for c in BAD_CASES])
def test_both_checkers_reject_the_wrong_forms(
    case: str, line: int, mypy_code: str, pyright_rule: str, tmp_path: Path
) -> None:
    target = tmp_path / f"{case}.py"
    shutil.copy(CASES / f"{case}.py.txt", target)
    shutil.copy(CASES / "mypy.ini", tmp_path / "mypy.ini")
    shutil.copy(CASES / "pyrightconfig.json", tmp_path / "pyrightconfig.json")
    mypy = run("mypy", "--config-file", str(tmp_path / "mypy.ini"), "--no-incremental", str(target))
    assert mypy.returncode == 1, mypy.stdout + mypy.stderr
    mypy_errors = [row for row in mypy.stdout.splitlines() if ": error: " in row]
    assert len(mypy_errors) == 1, mypy.stdout
    assert mypy_errors[0].startswith(f"{target}:{line}: error: "), mypy.stdout
    assert mypy_errors[0].endswith(f"[{mypy_code}]"), mypy.stdout
    if NO_PYRIGHT:
        return
    pyright = run("pyright", "--project", str(tmp_path), "--pythonpath", sys.executable, str(target))
    assert pyright.returncode == 1, pyright.stdout + pyright.stderr
    pyright_errors = [row.strip() for row in pyright.stdout.splitlines() if " - error: " in row]
    assert len(pyright_errors) == 1, pyright.stdout
    assert pyright_errors[0].startswith(f"{target}:{line}:"), pyright.stdout
    assert f"({pyright_rule})" in pyright.stdout, pyright.stdout
