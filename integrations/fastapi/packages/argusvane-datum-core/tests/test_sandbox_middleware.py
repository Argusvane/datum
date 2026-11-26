"""sandbox_middleware: first entry outermost, Datum's observation innermost, a replacement sandbox wrapped once."""

from collections.abc import Mapping, Sequence

import pytest

from datum_sandbox.json import JsonValue
from datum_sandbox.protocol import (
    Program,
    ProgramKind,
    RuleModule,
    Sandbox,
    SandboxMiddleware,
    SandboxResult,
    Smoke,
    compose_sandbox,
)


class Inner:
    """A sandbox that answers by name and records the calls it receives."""

    def __init__(self, name: str, trail: list[str]) -> None:
        self.name = name
        self.trail = trail
        self.program = Program(ProgramKind.SANDBOX, name.encode())

    def validate(
        self, context: Mapping[str, JsonValue], rules: Sequence[RuleModule] = (), *, real: bool
    ) -> SandboxResult:
        self.trail.append(self.name)
        return SandboxResult({"errors": [], "by": self.name}, 0.0)

    def inspect(
        self,
        op: str,
        definition: Mapping[str, JsonValue],
        *,
        formula_errors: str | None = None,
        extra: Mapping[str, JsonValue] | None = None,
        rules: Sequence[RuleModule] = (),
    ) -> dict[str, JsonValue]:
        self.trail.append(self.name)
        return {"ok": True, "by": self.name}

    def check(
        self, definition: Mapping[str, JsonValue], types: Sequence[str], rules: Sequence[RuleModule] = ()
    ) -> dict[str, JsonValue]:
        self.trail.append(self.name)
        return {"ok": True}

    def public_copy(self, definition: Mapping[str, JsonValue]) -> dict[str, JsonValue]:
        self.trail.append(self.name)
        return dict(definition)

    def smoke(self) -> Smoke:
        self.trail.append(self.name)
        return Smoke(ok=True, elapsed=0.0, message="")

    def prove_abi(self) -> None:
        self.trail.append(self.name)


class Recording:
    """A middleware that notes each call on the way in, then delegates."""

    def __init__(self, name: str, inner: Sandbox, trail: list[str]) -> None:
        self.name = name
        self.inner = inner
        self.trail = trail

    @property
    def program(self) -> Program:
        return self.inner.program

    def validate(
        self, context: Mapping[str, JsonValue], rules: Sequence[RuleModule] = (), *, real: bool
    ) -> SandboxResult:
        self.trail.append(self.name)
        return self.inner.validate(context, rules, real=real)

    def inspect(
        self,
        op: str,
        definition: Mapping[str, JsonValue],
        *,
        formula_errors: str | None = None,
        extra: Mapping[str, JsonValue] | None = None,
        rules: Sequence[RuleModule] = (),
    ) -> dict[str, JsonValue]:
        self.trail.append(self.name)
        return self.inner.inspect(op, definition, formula_errors=formula_errors, extra=extra, rules=rules)

    def check(
        self, definition: Mapping[str, JsonValue], types: Sequence[str], rules: Sequence[RuleModule] = ()
    ) -> dict[str, JsonValue]:
        self.trail.append(self.name)
        return self.inner.check(definition, types, rules)

    def public_copy(self, definition: Mapping[str, JsonValue]) -> dict[str, JsonValue]:
        self.trail.append(self.name)
        return self.inner.public_copy(definition)

    def smoke(self) -> Smoke:
        self.trail.append(self.name)
        return self.inner.smoke()

    def prove_abi(self) -> None:
        self.trail.append(self.name)
        self.inner.prove_abi()


def recording(name: str, trail: list[str], built: list[str]) -> SandboxMiddleware:
    def wrap(inner: Sandbox) -> Sandbox:
        built.append(name)
        return Recording(name, inner, trail)

    return wrap


def chain(trail: list[str], built: list[str]) -> tuple[list[SandboxMiddleware], SandboxMiddleware]:
    middleware = [recording("first", trail, built), recording("second", trail, built), recording("third", trail, built)]
    return middleware, recording("observation", trail, built)


def test_first_entry_outermost_observation_innermost() -> None:
    trail: list[str] = []
    built: list[str] = []
    middleware, observation = chain(trail, built)
    sandbox = compose_sandbox(Inner("own", trail), middleware=middleware, observation=observation)
    result = sandbox.validate({}, real=True)
    assert result.outcome["by"] == "own"
    assert trail == ["first", "second", "third", "observation", "own"]
    assert built == ["observation", "third", "second", "first"]


@pytest.mark.parametrize("operation", ["validate", "inspect", "check", "public_copy", "smoke", "prove_abi"])
def test_every_operation_goes_through_the_chain_once(operation: str) -> None:
    trail: list[str] = []
    built: list[str] = []
    middleware, observation = chain(trail, built)
    sandbox = compose_sandbox(Inner("own", trail), middleware=middleware, observation=observation)
    calls = {
        "validate": lambda: sandbox.validate({}, real=False),
        "inspect": lambda: sandbox.inspect("inspect", {}),
        "check": lambda: sandbox.check({}, []),
        "public_copy": lambda: sandbox.public_copy({}),
        "smoke": sandbox.smoke,
        "prove_abi": sandbox.prove_abi,
    }
    calls[operation]()
    assert trail == ["first", "second", "third", "observation", "own"]


def test_replacement_is_wrapped_by_the_same_chain_once() -> None:
    trail: list[str] = []
    built: list[str] = []
    middleware, observation = chain(trail, built)
    own = Inner("own", trail)
    sandbox = compose_sandbox(
        own, replacement=Inner("replacement", trail), middleware=middleware, observation=observation
    )
    assert sandbox.validate({}, real=True).outcome["by"] == "replacement"
    # Each layer once, the replacement innermost, the runtime's own never called and never wrapped as well.
    assert trail == ["first", "second", "third", "observation", "replacement"]
    assert built == ["observation", "third", "second", "first"]
    assert sandbox.program.data == b"replacement"


def test_no_middleware_answers_the_sandbox_itself() -> None:
    own = Inner("own", [])
    assert compose_sandbox(own) is own
    replacement = Inner("replacement", [])
    assert compose_sandbox(own, replacement=replacement) is replacement


def test_middleware_answering_none_is_refused() -> None:
    def broken(inner: Sandbox) -> Sandbox:
        return None  # type: ignore[return-value]

    with pytest.raises(TypeError, match="answered None"):
        compose_sandbox(Inner("own", []), middleware=[broken])


def test_single_middleware_sees_each_call_before_the_sandbox() -> None:
    trail: list[str] = []
    sandbox = compose_sandbox(Inner("own", trail), middleware=[recording("only", trail, [])])
    sandbox.inspect("inspect", {})
    sandbox.smoke()
    assert trail == ["only", "own", "only", "own"]
