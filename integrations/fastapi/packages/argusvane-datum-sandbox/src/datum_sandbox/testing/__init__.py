"""The contract kit an engine's tests bind (behind the testing extra).

The runtime contract classes (`WasiHardeningContract` against the generic run alone; `RuntimeContract`,
`SandboxHardeningContract`, `GoldenVerdictsContract` and `PdfRenderContract` against the Datum programs) are abstract
pytest classes: an engine's test module subclasses them, sets `capabilities` and overrides the `runtime` and
`new_runtime` fixtures. The program contracts run the real programs from `argusvane-datum-programs` against the
fixtures the asset build writes under `build/fixtures/`. `skip_runtime_under_xdist` keeps every `runtime` test out of
pytest-xdist workers.
"""

from datum_sandbox.testing.golden_contract import GoldenVerdictsContract
from datum_sandbox.testing.hardening_contract import SandboxHardeningContract
from datum_sandbox.testing.markers import skip_runtime_under_xdist
from datum_sandbox.testing.pdf_contract import PdfRenderContract
from datum_sandbox.testing.runtime_capabilities import Capability, RuntimeCapabilities, requires
from datum_sandbox.testing.runtime_contract import RuntimeContract
from datum_sandbox.testing.wasi_contract import WasiHardeningContract

__all__ = [
    "Capability",
    "GoldenVerdictsContract",
    "PdfRenderContract",
    "RuntimeCapabilities",
    "RuntimeContract",
    "SandboxHardeningContract",
    "WasiHardeningContract",
    "requires",
    "skip_runtime_under_xdist",
]
