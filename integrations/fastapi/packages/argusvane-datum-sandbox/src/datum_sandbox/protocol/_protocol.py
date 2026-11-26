"""The `Sandbox` protocol its callers see, the records it answers, and middleware composition.

`SandboxService` is the one implementation that runs the protocol (the depth guard, the slot, the ABI gate, the nonce,
the frame, the strict answer) and it is final: the protocol is not something an application changes. What an application
can do is wrap it: `sandbox_middleware` is a sequence of `Callable[[Sandbox], Sandbox]`, first entry outermost (as in
Starlette), with Datum's own observation innermost. A middleware delegates every call to the sandbox it was handed and
never answers in its place (delegate, observe, rethrow): a middleware that answered for the program would take the
sandbox out of the decision, which the code cannot detect, so the contract is stated instead. A replacement sandbox
(`Datum(sandbox=...)`) goes through the same chain once, in a step Datum owns.
"""

import enum
import hashlib
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Protocol, cast

from datum_sandbox.json import JsonValue
from datum_sandbox.protocol._run_script import RuleModule


class ProgramKind(enum.StrEnum):
    """Which program a `Program` holds."""

    SANDBOX = "sandbox"
    PDF = "pdf"


@dataclass(frozen=True, slots=True)
class Program:
    """A program's verified bytes and their SHA-256 (hex), computed here from the bytes.

    `abi` is the ABI the program's store declares (`programs.json`), for the reports only: it is never trusted, the
    gate asks the program itself.
    """

    kind: ProgramKind
    data: bytes = field(repr=False)
    abi: str = ""
    sha256: str = field(init=False)

    def __post_init__(self) -> None:
        """Hash the bytes once."""
        object.__setattr__(self, "sha256", hashlib.sha256(self.data).hexdigest())


@dataclass(frozen=True, slots=True)
class SandboxResult:
    """A validation's outcome (an object with an `errors` list) and the run's wall time in seconds."""

    outcome: dict[str, JsonValue]
    elapsed: float


@dataclass(frozen=True, slots=True)
class Smoke:
    """What a smoke run found: whether the expected verdict came back, its time in seconds, and a message."""

    ok: bool
    elapsed: float
    message: str


class Sandbox(Protocol):
    """The sandbox program's operations as callers see them; every refusal is `SandboxService`'s."""

    @property
    def program(self) -> Program:
        """The program this sandbox runs."""
        ...

    def validate(
        self, context: Mapping[str, JsonValue], rules: Sequence[RuleModule] = (), *, real: bool
    ) -> SandboxResult:
        """Run one validation; `real` (no default) relays a real submission's run log."""
        ...

    def inspect(
        self,
        op: str,
        definition: Mapping[str, JsonValue],
        *,
        formula_errors: str | None = None,
        extra: Mapping[str, JsonValue] | None = None,
        rules: Sequence[RuleModule] = (),
    ) -> dict[str, JsonValue]:
        """Ask the program about a definition (`__datum_inspect`); answer ``{ok: true, op, ...}``."""
        ...

    def check(
        self, definition: Mapping[str, JsonValue], types: Sequence[str], rules: Sequence[RuleModule] = ()
    ) -> dict[str, JsonValue]:
        """Ask whether a definition may be saved (the `check` op)."""
        ...

    def public_copy(self, definition: Mapping[str, JsonValue]) -> dict[str, JsonValue]:
        """Return the definition a browser may be served (the `public` op)."""
        ...

    def smoke(self) -> Smoke:
        """Run a tiny validation proving the runtime works."""
        ...

    def prove_abi(self) -> None:
        """Prove the program answers for the sandbox ABI floor, once per program."""
        ...


type SandboxMiddleware = Callable[[Sandbox], Sandbox]
"""Wraps a sandbox: delegates every call to the sandbox it was handed and never answers in its place."""


def compose_sandbox(
    own: Sandbox,
    *,
    replacement: Sandbox | None = None,
    middleware: Sequence[SandboxMiddleware] = (),
    observation: SandboxMiddleware | None = None,
) -> Sandbox:
    """Return the sandbox callers use: `replacement` (when given) or `own`, wrapped once by everything.

    Datum's `observation` wraps it first (innermost), then `middleware` from the last entry to the first, so the first
    entry is outermost and sees each call first. A middleware that answers `None` is refused with `TypeError`.
    """
    current = replacement if replacement is not None else own
    layers = [*([observation] if observation is not None else []), *reversed(middleware)]
    for layer in layers:
        wrapped = cast("Sandbox | None", layer(current))  # a middleware is untyped code: hold it to its contract
        if wrapped is None:
            raise TypeError(f"the sandbox middleware {layer!r} answered None instead of a Sandbox")
        current = wrapped
    return current
