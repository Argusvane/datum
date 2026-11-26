"""The base of the four runtime contract classes: the capabilities declaration, the two runtime fixtures and the guards.

A binding subclasses the contracts it wants, sets `capabilities` and overrides `runtime` (class scoped, one shared
runtime) and `new_runtime` (a factory of fresh runtimes for the cases that close one):

    class TestWasmtimeRuntime(RuntimeContract, SandboxHardeningContract, GoldenVerdictsContract, PdfRenderContract):
        capabilities = RuntimeCapabilities()

        @pytest.fixture(scope="class")
        @classmethod
        def runtime(cls) -> Iterator[GuestRuntime]: ...

        @pytest.fixture
        def new_runtime(self) -> Iterator[Callable[[], GuestRuntime]]: ...

The runtime under test is built with at least 16 validation slots (the race case runs 16 guests at once); fewer
slots make the cases slower, not wrong, because every run here waits for a slot. Tests marked `runtime` never
run under xdist.
"""

import contextlib
from collections.abc import Callable, Iterator
from typing import ClassVar

import pytest

from datum_sandbox.testing.runtime_capabilities import RuntimeCapabilities, required_by
from datum_sandbox.testing.runtime_support import budget, run_raw
from datum_sandbox.wasi import GuestRuntime


class ContractBase:
    """What every contract class shares; a binding overrides `capabilities`, `runtime` and `new_runtime`."""

    pytestmark: ClassVar = [pytest.mark.runtime]

    capabilities: ClassVar[RuntimeCapabilities] = RuntimeCapabilities()
    """What the engine lacks, with reasons; nothing declared holds it to every contract."""
    stop_grace: ClassVar[float] = 5.0
    """The engine's stop grace in seconds (`EngineSettings.stop_grace`): the longest a stop may take past the budget."""
    wall_margin: ClassVar[float] = 0.75
    """Slack in seconds on a wall-budget assertion: the clock tick and a loaded machine (measured when idle)."""

    @pytest.fixture(scope="class")
    @classmethod
    def runtime(cls) -> Iterator[GuestRuntime]:
        """Yield the one runtime shared by the class's tests (override in the binding, as a class method)."""
        raise NotImplementedError("bind the contract: override the class-scoped `runtime` fixture")

    @pytest.fixture
    def new_runtime(self) -> Iterator[Callable[[], GuestRuntime]]:
        """Yield a factory of fresh runtimes for a test that closes one; the binding closes what is left (override)."""
        raise NotImplementedError("bind the contract: override the `new_runtime` fixture")

    @pytest.fixture(scope="class", autouse=True)
    @classmethod
    def contract_binding(cls, request: pytest.FixtureRequest) -> None:
        """Skip the class when the engine is not registered, or under xdist; a runtime test is never run in a worker."""
        if hasattr(request.config, "workerinput"):
            pytest.skip("tests marked runtime never run under xdist: run them in one process")
        if not cls.capabilities.registered:
            pytest.skip(cls.capabilities.unregistered_reason)

    @pytest.fixture(autouse=True)
    def declared_limits(self, request: pytest.FixtureRequest) -> None:
        """Make a test `xfail(strict=True)` when the engine declared a capability the test needs as lacking."""
        missing = self.capabilities.missing(required_by(request.function))
        if missing:
            why = "; ".join(f"{cap.value}: {reason}" for cap, reason in missing.items())
            request.applymarker(pytest.mark.xfail(strict=True, reason=f"declared limit ({why})"))

    @pytest.fixture(scope="class", autouse=True)
    @classmethod
    def warm_up_the_engine(cls, contract_binding: None, runtime: GuestRuntime) -> None:
        """Pay the engine's first-run set-up here, not in a budget: three raw runs."""
        del contract_binding  # an ordering dependency only: the class is skipped before the engine is touched
        for _ in range(3):
            # Best effort: a wrong engine fails the cases themselves, not the set-up of every case.
            with contextlib.suppress(Exception):
                run_raw(runtime, "print(1);", budget(30, 32))
