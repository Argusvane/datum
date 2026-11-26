"""A binding that declares a limit its engine does not have (not collected; see `test_runtime_contract_kit`)."""

from collections.abc import Callable, Iterator

import pytest
from fake_runtime import ScriptedRuntime

from datum_sandbox.testing import Capability, RuntimeCapabilities, RuntimeContract
from datum_sandbox.wasi import GuestRuntime


class TestDeclaredButTrue(RuntimeContract):
    """The engine stops a looping run correctly, yet declares it cannot: the case must go red (XPASS strict)."""

    capabilities = RuntimeCapabilities(lacks={Capability.BUDGET_STOP: "declared, but the engine does stop loops"})

    @pytest.fixture(scope="class")
    @classmethod
    def runtime(cls) -> Iterator[GuestRuntime]:
        runtime = ScriptedRuntime()
        yield runtime
        runtime.close()

    @pytest.fixture
    def new_runtime(self) -> Iterator[Callable[[], GuestRuntime]]:
        made: list[ScriptedRuntime] = []

        def make() -> GuestRuntime:
            made.append(ScriptedRuntime())
            return made[-1]

        yield make
        for runtime in made:
            runtime.close()
