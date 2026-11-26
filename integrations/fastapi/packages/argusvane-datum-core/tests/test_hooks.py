"""Hooks: is_async_callable, resolve, call_hook, the typed refusal, and the typing cases under mypy and pyright."""

# ruff: noqa: PT018, PT011, PLW0108

import asyncio
import functools
import inspect
import shutil
import subprocess
import sys
from collections.abc import Awaitable
from pathlib import Path

import pytest

from datum_core.hooks import (
    Hook,
    HookFindings,
    HookProblem,
    HookRefusedError,
    HookRefusedKind,
    MaybeAwaitable,
    call_hook,
    is_async_callable,
    resolve,
)
from datum_sandbox.checks import DatumConfigurationError

CASES = Path(__file__).parent / "typing_cases"


def sync_fn(x: int) -> int:
    return x + 1


async def async_fn(x: int) -> int:
    return x + 1


class SyncCallable:
    def __call__(self, x: int) -> int:
        return x + 1

    def method(self, x: int) -> int:
        return x + 1

    async def amethod(self, x: int) -> int:
        return x + 1


class AsyncCallable:
    async def __call__(self, x: int) -> int:
        return x + 1


typed_lambda: Hook[[int], int] = lambda x: x  # noqa: E731


def maybe(value: MaybeAwaitable[int]) -> MaybeAwaitable[int]:
    return value


def as_hook(hook: Hook[[int], int]) -> Hook[[int], int]:
    return hook


def as_zero(hook: Hook[[], int]) -> Hook[[], int]:
    return hook


def run_awaiter[T](awaitable: Awaitable[T]) -> T:
    """A stand-in for the binding's awaiter: a private loop is fine in a test."""

    async def wrap() -> T:
        return await awaitable

    return asyncio.run(wrap())


@pytest.mark.parametrize(  # pyright: ignore[reportUnknownArgumentType]
    ("obj", "expected"),
    [
        (sync_fn, False),
        (async_fn, True),
        (functools.partial(sync_fn, 1), False),
        (functools.partial(async_fn, 1), True),
        (functools.partial(functools.partial(async_fn)), True),
        (functools.partial(AsyncCallable()), True),
        (functools.partial(SyncCallable()), False),
        (typed_lambda, False),
        (SyncCallable(), False),
        (AsyncCallable(), True),
        (SyncCallable().method, False),
        (SyncCallable().amethod, True),
        (print, False),
        (42, False),
    ],
)
def test_is_async_callable(obj: object, expected: bool) -> None:
    assert is_async_callable(obj) is expected


def test_resolve_passes_plain_values_and_runs_awaitables() -> None:
    assert resolve(3, None) == 3
    assert resolve(3, run_awaiter) == 3
    assert resolve(maybe(async_fn(1)), run_awaiter) == 2


def test_resolve_with_no_awaiter_refuses_and_closes_the_coroutine() -> None:
    coro = async_fn(1)
    with pytest.raises(DatumConfigurationError, match="no awaiter"):
        resolve(maybe(coro), None)
    assert inspect.getcoroutinestate(coro) == inspect.CORO_CLOSED


def test_call_hook_refuses_an_async_hook_before_calling_it() -> None:
    calls: list[int] = []

    async def hook(x: int) -> int:
        calls.append(x)
        return x

    with pytest.raises(DatumConfigurationError, match="hook"):
        call_hook(as_hook(hook), None, 1)
    assert calls == []
    assert call_hook(sync_fn, None, 1) == 2
    assert call_hook(as_hook(async_fn), run_awaiter, 1) == 2
    assert call_hook(as_zero(functools.partial(async_fn, 4)), run_awaiter) == 5


def test_a_lambda_returning_a_coroutine_is_caught_after_the_call() -> None:
    made: list[object] = []

    def make(x: int) -> Awaitable[int]:
        coro = async_fn(x)
        made.append(coro)
        return coro

    with pytest.raises(DatumConfigurationError):
        call_hook(as_hook(make), None, 1)
    assert inspect.getcoroutinestate(made[0]) == inspect.CORO_CLOSED  # type: ignore[arg-type]
    assert call_hook(as_hook(lambda x: async_fn(x)), run_awaiter, 1) == 2


def test_refusal_kinds_and_codes() -> None:
    forbidden = HookRefusedError.forbidden("auth.denied", "no")
    assert forbidden.kind is HookRefusedKind.FORBIDDEN and str(forbidden) == "no"
    assert HookRefusedError.conflict("a.b", "c").kind is HookRefusedKind.CONFLICT
    many = HookRefusedError.invalid([HookProblem("name", "required", "x"), HookProblem(None, "other", "y")])
    assert many.kind is HookRefusedKind.INVALID and len(many.problems) == 2
    assert HookRefusedError.invalid("one", "msg").problems[0] == HookProblem(None, "one", "msg")
    for bad in ("", "1abc", "has space", "x" * 129):
        with pytest.raises(ValueError):
            HookProblem(None, bad, "m")
    HookProblem(None, "a" + "b" * 127, "m")
    HookProblem(None, "A.b_c:d-e", "m")
    with pytest.raises(ValueError):
        HookRefusedError.invalid([])


def test_findings_merge_and_ok() -> None:
    e, w = HookProblem("f", "e1", "m"), HookProblem(None, "w1", "m")
    assert HookFindings().ok
    merged = HookFindings((e,)).merged(HookFindings((), (w,))).merged(None)
    assert merged.errors == (e,) and merged.warnings == (w,) and not merged.ok


def test_mypy_strict_accepts_sync_async_partial_lambda_and_bound_hooks() -> None:
    result = subprocess.run(  # noqa: S603
        [
            sys.executable,
            "-m",
            "mypy",
            "--config-file",
            str(CASES / "mypy.ini"),
            "--no-incremental",
            str(CASES / "hooks_good.py"),
        ],
        capture_output=True,
        text=True,
        check=False,
        timeout=300,
    )
    assert result.returncode == 0, result.stdout + result.stderr


@pytest.mark.skipif(
    shutil.which("node") is None and shutil.which("pyright") is None, reason="pyright needs node or its wrapper"
)
def test_pyright_strict_accepts_the_same_hooks() -> None:
    result = subprocess.run(  # noqa: S603
        [
            sys.executable,
            "-m",
            "pyright",
            "--project",
            str(CASES),
            "--pythonpath",
            sys.executable,
            str(CASES / "hooks_good.py"),
        ],
        capture_output=True,
        text=True,
        check=False,
        timeout=300,
    )
    assert result.returncode == 0, result.stdout + result.stderr


# (case, the line, mypy's error code, pyright's rule): an import failure would also exit 1, so the codes are asserted.
BAD_CASES = [
    ("hooks_bad_return", 10, "assignment", "reportAssignmentType"),
    ("hooks_bad_listener", 11, "arg-type", "reportArgumentType"),
]


@pytest.mark.parametrize(("case", "line", "mypy_code", "pyright_rule"), BAD_CASES, ids=[c[0] for c in BAD_CASES])
def test_both_checkers_reject_the_wrong_forms(
    case: str, line: int, mypy_code: str, pyright_rule: str, tmp_path: Path
) -> None:
    target = tmp_path / f"{case}.py"
    shutil.copy(CASES / f"{case}.py.txt", target)
    shutil.copy(CASES / "mypy.ini", tmp_path / "mypy.ini")
    shutil.copy(CASES / "pyrightconfig.json", tmp_path / "pyrightconfig.json")
    mypy = subprocess.run(  # noqa: S603
        [sys.executable, "-m", "mypy", "--config-file", str(tmp_path / "mypy.ini"), "--no-incremental", str(target)],
        capture_output=True,
        text=True,
        check=False,
        timeout=300,
    )
    assert mypy.returncode == 1, mypy.stdout + mypy.stderr
    mypy_errors = [row for row in mypy.stdout.splitlines() if ": error: " in row]
    assert len(mypy_errors) == 1, mypy.stdout
    assert mypy_errors[0].startswith(f"{target}:{line}: error: "), mypy.stdout
    assert mypy_errors[0].endswith(f"[{mypy_code}]"), mypy.stdout
    pyright = subprocess.run(  # noqa: S603
        [sys.executable, "-m", "pyright", "--project", str(tmp_path), "--pythonpath", sys.executable, str(target)],
        capture_output=True,
        text=True,
        check=False,
        timeout=300,
    )
    assert pyright.returncode == 1, pyright.stdout + pyright.stderr
    pyright_errors = [row.strip() for row in pyright.stdout.splitlines() if " - error: " in row]
    assert len(pyright_errors) == 1, pyright.stdout
    assert pyright_errors[0].startswith(f"{target}:{line}:"), pyright.stdout
    assert f"({pyright_rule})" in pyright.stdout, pyright.stdout
    assert "1 error, 0 warnings" in pyright.stdout, pyright.stdout
