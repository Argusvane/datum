"""`ProgramLimits`: the run budgets within their documented bounds, and the bounds table.

The clamp is `SandboxSettings.build`'s: a `datum.runtime.*` budget outside its bound is moved to the nearest bound with
one `datum.W008` warning per value there. A memory budget below the runtime module's initial pages times 64 KiB is the
engine's refusal at start (`datum.E003`), never clamped. A `ProgramLimits` built directly is held to the bounds as well
(a `ValueError` names the field), so nothing reaches a runtime unclamped.

| Budget | Bounds | Default |
|---|---|---|
| `validation.time_limit` | 0.001 s to 60 s | 5 s |
| `validation.memory` | 4 MiB to 1 GiB | 32 MiB |
| `validation.concurrency` | 0 to 64 slots (0: one per CPU) | 0 |
| `validation.wait` | 0 s to 10 s | 2 s |
| `pdf.time_limit` | 0.001 s to 300 s | 60 s |
| `pdf.memory` | 32 MiB to 4 GiB | 256 MiB |
| `pdf.concurrency` | 0 to 64 slots (0: `min(2, CPUs)`) | 0 |
| `pdf.wait` | 0 s to 10 s | 2 s |
| `verify_max_bytes` | 1 MiB to 100 MiB | 20 MiB |
"""

import enum
import math
import os
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
from types import MappingProxyType
from typing import Final

from datum_sandbox.wasi import STDERR_CAP, STDOUT_CAP, EngineLimits, RunBudget

MIB: Final = 1024 * 1024
WASM_PAGE: Final = 64 * 1024
"""Bytes in one WebAssembly page: the memory floor is the module's initial pages times this."""

#: The memory caps a runtime is built for (`datum.runtime.validation.memory` and `datum.runtime.pdf.memory` defaults).
DEFAULT_VALIDATION_MEMORY: Final = 32 * MIB
DEFAULT_PDF_MEMORY: Final = 256 * MIB


class PoolKind(enum.StrEnum):
    """The slot pool a run takes: validation (validations, inspects, raw runs) or PDF (renders)."""

    VALIDATION = "validation"
    PDF = "pdf"


@dataclass(frozen=True, slots=True)
class Bounds:
    """A budget's smallest and largest value, its default, the setting it comes from and its unit for messages."""

    low: float
    high: float
    default: float
    setting: str
    unit: str

    def holds(self, value: float) -> bool:
        """Say whether `value` is within the bounds."""
        return self.low <= value <= self.high

    def nearest(self, value: float) -> float:
        """Return `value` moved to the nearest bound."""
        return min(self.high, max(self.low, value))


_RUNTIME: Final = "datum.runtime."

VALIDATION_TIME: Final = Bounds(0.001, 60, 5, _RUNTIME + "validation.time_limit", "s")
VALIDATION_MEMORY: Final = Bounds(
    4 * MIB, 1024 * MIB, DEFAULT_VALIDATION_MEMORY, _RUNTIME + "validation.memory", "bytes"
)
VALIDATION_CONCURRENCY: Final = Bounds(0, 64, 0, _RUNTIME + "validation.concurrency", "slots")
VALIDATION_WAIT: Final = Bounds(0, 10, 2, _RUNTIME + "validation.wait", "s")
PDF_TIME: Final = Bounds(0.001, 300, 60, _RUNTIME + "pdf.time_limit", "s")
PDF_MEMORY: Final = Bounds(32 * MIB, 4096 * MIB, DEFAULT_PDF_MEMORY, _RUNTIME + "pdf.memory", "bytes")
PDF_CONCURRENCY: Final = Bounds(0, 64, 0, _RUNTIME + "pdf.concurrency", "slots")
PDF_WAIT: Final = Bounds(0, 10, 2, _RUNTIME + "pdf.wait", "s")
VERIFY_BYTES: Final = Bounds(MIB, 100 * MIB, 20 * MIB, _RUNTIME + "verify_max_bytes", "bytes")


def cpus() -> int:
    """Return the CPUs this process may use, at least one."""
    counter: Callable[[], int | None] = getattr(os, "process_cpu_count", os.cpu_count)  # 3.13: the affinity-aware count
    return max(1, counter() or 1)


def _text(value: float, unit: str) -> str:
    number = str(int(value)) if float(value).is_integer() else f"{value:g}"
    return f"{number} {unit}"


@dataclass(frozen=True, slots=True)
class ProgramLimits:
    """The budgets of the sandbox and PDF programs, each within its bounds (see the module's table).

    Times and waits are seconds, memories and sizes bytes; a concurrency of 0 means the default slot count.
    """

    validation_time_limit: float = VALIDATION_TIME.default
    validation_memory: int = int(VALIDATION_MEMORY.default)
    validation_concurrency: int = int(VALIDATION_CONCURRENCY.default)
    validation_wait: float = VALIDATION_WAIT.default
    pdf_time_limit: float = PDF_TIME.default
    pdf_memory: int = int(PDF_MEMORY.default)
    pdf_concurrency: int = int(PDF_CONCURRENCY.default)
    pdf_wait: float = PDF_WAIT.default
    verify_max_bytes: int = int(VERIFY_BYTES.default)

    def __post_init__(self) -> None:
        """Refuse a value outside its bounds (build clamped limits with `SandboxSettings.build`)."""
        for name, bounds in BOUNDS.items():
            value = getattr(self, name)
            if isinstance(value, bool) or not isinstance(value, int | float) or not math.isfinite(value):
                raise TypeError(f"ProgramLimits.{name} must be a finite number, not {value!r}")
            if not bounds.holds(value):
                raise ValueError(
                    f"ProgramLimits.{name} = {value} is outside [{bounds.low:g}, {bounds.high:g}]: "
                    "build limits with SandboxSettings.build"
                )

    @staticmethod
    def bounds() -> Mapping[str, Bounds]:
        """Return each budget's bounds by field name (the module's table)."""
        return MappingProxyType(BOUNDS)

    def validation_slots(self) -> int:
        """Return the validation slots: the setting, or one per CPU when it is 0."""
        return self.validation_concurrency or cpus()

    def pdf_slots(self) -> int:
        """Return the PDF slots: the setting, or `min(2, CPUs)` when it is 0."""
        return self.pdf_concurrency or min(2, cpus())

    def validation_budget(self) -> RunBudget:
        """Return one validation or inspect run's budget: its time, memory and wait, 32 MiB stdout and 64 KiB stderr.

        It runs in the validation pool.
        """
        return RunBudget(
            wall_seconds=self.validation_time_limit,
            memory_bytes=self.validation_memory,
            stdout_cap=STDOUT_CAP,
            stderr_cap=STDERR_CAP,
            wait=self.validation_wait,
            pool=PoolKind.VALIDATION,
        )

    def pdf_budget(self) -> RunBudget:
        """Return one PDF run's budget: its time, memory and wait, 32 MiB stdout and 64 KiB stderr; the PDF pool."""
        return RunBudget(
            wall_seconds=self.pdf_time_limit,
            memory_bytes=self.pdf_memory,
            stdout_cap=STDOUT_CAP,
            stderr_cap=STDERR_CAP,
            wait=self.pdf_wait,
            pool=PoolKind.PDF,
        )

    def engine_limits(
        self,
        work_dir: Path,
        tick_seconds: float = 0.05,
        *,
        qjs_path: str | None = None,
        qjs_sha256: str | None = None,
    ) -> EngineLimits:
        """Return what a provider builds a runtime from: the two pools' slots and the two memory caps.

        `qjs_path` and `qjs_sha256` are `datum.runtime.qjs_path` and `qjs_sha256` (the guest's location is no budget,
        so it is not a field of the limits); the engine verifies the digest. The runtime builds it once with the clamped
        settings, so the engine sizes itself (wasmtime's address-space reservation) for exactly the caps its runs get:
        the validation memory is the common size, the PDF memory the largest.
        """
        return EngineLimits(
            pools={PoolKind.VALIDATION: self.validation_slots(), PoolKind.PDF: self.pdf_slots()},
            work_dir=work_dir,
            tick_seconds=tick_seconds,
            memory_bytes=self.validation_memory,
            max_memory_bytes=self.pdf_memory,
            module_path=None if qjs_path is None else Path(qjs_path),
            module_sha256=qjs_sha256,
        )


BOUNDS: Final[dict[str, Bounds]] = {
    "validation_time_limit": VALIDATION_TIME,
    "validation_memory": VALIDATION_MEMORY,
    "validation_concurrency": VALIDATION_CONCURRENCY,
    "validation_wait": VALIDATION_WAIT,
    "pdf_time_limit": PDF_TIME,
    "pdf_memory": PDF_MEMORY,
    "pdf_concurrency": PDF_CONCURRENCY,
    "pdf_wait": PDF_WAIT,
    "verify_max_bytes": VERIFY_BYTES,
}
INTEGERS: Final = frozenset(
    {"validation_memory", "validation_concurrency", "pdf_memory", "pdf_concurrency", "verify_max_bytes"}
)
