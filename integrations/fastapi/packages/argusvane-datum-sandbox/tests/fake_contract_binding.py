"""The four runtime contracts bound to a fake runtime that is wrong about everything (the kit's red proof).

Not collected by the suite (the name does not start with `test_`): `test_runtime_contract_kit.py` runs it in a child
pytest and checks that every contract case fails, or xfails strictly for a declared limit, and that an unregistered
engine's cases are skipped. Run it by hand with `pytest tests/fake_contract_binding.py`.
"""

from collections.abc import Callable, Iterator

import pytest
from fake_runtime import FakeGuestRuntime

from datum_sandbox.testing import (
    Capability,
    GoldenVerdictsContract,
    PdfRenderContract,
    RuntimeCapabilities,
    RuntimeContract,
    SandboxHardeningContract,
)
from datum_sandbox.wasi import GuestRuntime


class TestFakeEngine(RuntimeContract, SandboxHardeningContract, GoldenVerdictsContract, PdfRenderContract):
    capabilities = RuntimeCapabilities(
        lacks={
            Capability.PDF: "the fake does not run the PDF program",
            Capability.MEMORY_STOP: "the fake never allocates",
        }
    )

    @pytest.fixture(scope="class")
    @classmethod
    def runtime(cls) -> Iterator[GuestRuntime]:
        fake = FakeGuestRuntime()
        yield fake
        fake.close()

    @pytest.fixture
    def new_runtime(self) -> Iterator[Callable[[], GuestRuntime]]:
        made: list[FakeGuestRuntime] = []

        def make() -> GuestRuntime:
            made.append(FakeGuestRuntime())
            return made[-1]

        yield make
        for fake in made:
            fake.close()


class TestUnregisteredEngine(RuntimeContract, SandboxHardeningContract, GoldenVerdictsContract, PdfRenderContract):
    capabilities = RuntimeCapabilities(registered=False, unregistered_reason="no engine is registered for this binding")

    @pytest.fixture(scope="class")
    @classmethod
    def runtime(cls) -> Iterator[GuestRuntime]:
        raise AssertionError("an unregistered engine is skipped before its runtime is built")

    @pytest.fixture
    def new_runtime(self) -> Iterator[Callable[[], GuestRuntime]]:
        raise AssertionError("an unregistered engine is skipped before its runtime is built")
