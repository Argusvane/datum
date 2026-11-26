"""The five runtime contracts bound to the wasmtime engine: red until the engine is registered, then green.

`WasmtimeGuestRuntime` registers as provider `wasmtime` in the `datum.guest_runtimes` entry-point group. Until it
does, this class is skipped through the capabilities declaration (`registered=False`), not failed; once it does, nothing
is declared as lacking, so the engine is held to every contract. Nothing here runs under xdist.
"""

import shutil
import tempfile
from collections.abc import Callable, Iterator
from pathlib import Path

import pytest
from guests import datum_limits

from datum_sandbox.testing import (
    GoldenVerdictsContract,
    PdfRenderContract,
    RuntimeCapabilities,
    RuntimeContract,
    SandboxHardeningContract,
    WasiHardeningContract,
)
from datum_sandbox.wasi import EngineSettings, GuestRuntime, GuestRuntimes
from datum_sandbox.wasi._records import Available
from datum_sandbox_wasmtime import ENGINE_ID

SLOTS = 16
"""The race case runs a looping guest beside fifteen honest ones: sixteen at once."""


def _registration() -> tuple[bool, str]:
    """Return whether the engine is registered and available here, and the reason it is not."""
    found = GuestRuntimes.discover()
    items = [item for item in found.listing if item.id == ENGINE_ID]
    if not items:
        return False, f"no engine {ENGINE_ID!r} is registered in the datum.guest_runtimes group"
    item = items[0]
    if item.provider is None or not isinstance(item.availability, Available):
        return False, f"the {ENGINE_ID!r} engine is not available here: {item.error or item.availability}"
    return True, ""


REGISTERED, WHY_NOT = _registration()


def _create(work_dir: Path) -> GuestRuntime:
    provider = GuestRuntimes.discover().select(ENGINE_ID)
    limits = datum_limits(SLOTS, 2, work_dir, 0.05)
    return provider.create(limits, EngineSettings())


class TestWasmtimeRuntime(
    WasiHardeningContract, RuntimeContract, SandboxHardeningContract, GoldenVerdictsContract, PdfRenderContract
):
    """Every contract, nothing declared as lacking: the generic run's guarantees and the Datum programs'."""

    capabilities = RuntimeCapabilities(registered=REGISTERED, unregistered_reason=WHY_NOT)

    @pytest.fixture(scope="class")
    @classmethod
    def runtime(cls) -> Iterator[GuestRuntime]:
        work_dir = Path(tempfile.mkdtemp(prefix="datum-contract-"))
        runtime = _create(work_dir)
        try:
            yield runtime
        finally:
            runtime.close()
            shutil.rmtree(work_dir, ignore_errors=True)

    @pytest.fixture
    def new_runtime(self, tmp_path: Path) -> Iterator[Callable[[], GuestRuntime]]:
        made: list[GuestRuntime] = []

        def make() -> GuestRuntime:
            made.append(_create(tmp_path))
            return made[-1]

        yield make
        for runtime in made:
            runtime.close()
