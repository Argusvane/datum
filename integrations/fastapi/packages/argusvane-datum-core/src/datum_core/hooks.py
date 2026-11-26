"""Hook types: callables returning `T | Awaitable[T]`, `resolve`, `is_async_callable`, the refusal.

A one-method hook is a plain callable; sync or async is decided per call. An awaitable goes through the awaiter the
binding supplies; `None` means every hook is sync, and an async hook then is a configuration error. No
`runtime_checkable`: it checks names, not signatures, and an `async def` Protocol method does not type-check against a
sync implementation, which is why the aliases spell `T | Awaitable[T]`.
"""

import enum
import functools
import inspect
import re
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass
from typing import Protocol, cast

from datum_sandbox.checks import DatumConfigurationError

type MaybeAwaitable[T] = T | Awaitable[T]
"""What a hook may return: the value, or an awaitable of it."""

type Hook[**P, T] = Callable[P, MaybeAwaitable[T]]
"""A hook taking `P` and answering `T`, sync or async."""


class Awaiter(Protocol):
    """Resolve an awaitable from a worker thread; the binding's (`anyio.from_thread.run`, `async_to_sync`, ...)."""

    def __call__[T](self, awaitable: Awaitable[T], /) -> T:
        """Run `awaitable` to completion and return its result."""
        ...


def is_async_callable(obj: object) -> bool:
    """Say whether calling `obj` yields a coroutine: coroutine functions, bound methods, callable instances, partials.

    The check is made before the call so that nothing is created and left un-awaited. A lambda or a plain function that
    returns a coroutine is not detected here; `resolve` catches it after the call.
    """
    while isinstance(obj, functools.partial):
        obj = obj.func
    if inspect.iscoroutinefunction(obj):
        return True
    return callable(obj) and inspect.iscoroutinefunction(getattr(obj, "__call__", None))  # noqa: B004


def _missing_awaiter(what: str) -> DatumConfigurationError:
    return DatumConfigurationError(
        f"{what} is asynchronous but no awaiter was supplied",
        hint="use the binding that supplies one (the FastAPI binding does), or make the hook a plain function",
    )


def resolve[T](value: MaybeAwaitable[T], awaiter: Awaiter | None, *, what: str = "a hook") -> T:
    """Return `value`, running it through `awaiter` first when it is awaitable.

    With no awaiter an awaitable raises `DatumConfigurationError`; a coroutine is closed first so that nothing is left
    un-awaited.
    """
    if not inspect.isawaitable(value):
        return value
    if awaiter is None:
        close = getattr(value, "close", None)
        if callable(close):
            close()
        raise _missing_awaiter(what)
    return awaiter(cast("Awaitable[T]", value))


def call_hook[**P, T](hook: Hook[P, T], awaiter: Awaiter | None, /, *args: P.args, **kwargs: P.kwargs) -> T:
    """Call `hook` and resolve its answer; an async hook with no awaiter is refused before it is called."""
    if awaiter is None and is_async_callable(hook):
        raise _missing_awaiter(f"hook {getattr(hook, '__qualname__', repr(hook))}")
    return resolve(hook(*args, **kwargs), awaiter, what=f"hook {getattr(hook, '__qualname__', repr(hook))}")


# -- findings and refusals ---------------------------------------------------------------------------------------------

_CODE = re.compile(r"[A-Za-z][A-Za-z0-9._:\-]{0,127}")


def _check_code(code: str) -> str:
    if not _CODE.fullmatch(code):
        raise ValueError(f"a hook code is letters, digits and . _ : -, at most 128, starting with a letter: {code!r}")
    return code


@dataclass(frozen=True, slots=True)
class HookProblem:
    """One finding: a field (or `None` for the whole request), a stable code and a message for the person."""

    field: str | None
    code: str
    message: str

    def __post_init__(self) -> None:
        """Refuse a code outside the documented alphabet."""
        _check_code(self.code)


@dataclass(frozen=True, slots=True)
class HookFindings:
    """What a validator returns: errors refuse, warnings ride along."""

    errors: tuple[HookProblem, ...] = ()
    warnings: tuple[HookProblem, ...] = ()

    @property
    def ok(self) -> bool:
        """Whether there is no error."""
        return not self.errors

    def merged(self, other: "HookFindings | None") -> "HookFindings":
        """Return these findings followed by `other`'s."""
        if other is None:
            return self
        return HookFindings(self.errors + other.errors, self.warnings + other.warnings)


class HookRefusedKind(enum.StrEnum):
    """Why a hook refused; the kind decides the answer (403, 409, 422)."""

    FORBIDDEN = "forbidden"
    CONFLICT = "conflict"
    INVALID = "invalid"


class HookRefusedError(Exception):
    """The one typed refusal a hook raises; a service caller reads `kind` and `problems`."""

    def __init__(self, kind: HookRefusedKind, problems: tuple[HookProblem, ...]) -> None:
        """Keep the kind and the problems (at least one)."""
        if not problems:
            raise ValueError("a refusal carries at least one problem")
        super().__init__(problems[0].message)
        self.kind = kind
        self.problems = problems

    @classmethod
    def forbidden(cls, code: str, message: str) -> "HookRefusedError":
        """Refuse as forbidden (403)."""
        return cls(HookRefusedKind.FORBIDDEN, (HookProblem(None, code, message),))

    @classmethod
    def conflict(cls, code: str, message: str) -> "HookRefusedError":
        """Refuse as a conflict (409)."""
        return cls(HookRefusedKind.CONFLICT, (HookProblem(None, code, message),))

    @classmethod
    def invalid(cls, code_or_problems: "str | Sequence[HookProblem]", message: str = "") -> "HookRefusedError":
        """Refuse as invalid (422): one `code` and `message`, or a sequence of `HookProblem`."""
        if isinstance(code_or_problems, str):
            return cls(HookRefusedKind.INVALID, (HookProblem(None, code_or_problems, message),))
        return cls(HookRefusedKind.INVALID, tuple(code_or_problems))
