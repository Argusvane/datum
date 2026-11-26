"""Guest memory: the engine's address-space reservation, the module's floor, and the start-up reservation refusal.

wasmtime reserves address space per linear memory: by default 4 GiB plus a 64 MiB guard, whatever the guest uses, so
eight slots need 33 GB and fail under `ulimit -v`, in address-space-limited containers and on hardened hosts. Datum
sets `memory_guard_size=0`, `memory_reservation` to the validation memory cap rounded up to whole 64 KiB pages, and
`memory_reservation_for_growth` to the room a larger (PDF) cap needs past it, so a store reserves about its cap. Each
store's real limit is `Store.set_limits(memory_size=<the run's budget>)`: QuickJS sees a refused `memory.grow` and ends
with `InternalError: out of memory`.
"""

import re
from typing import Final

from datum_sandbox.wasi import EngineConfigurationError

PAGE: Final = 64 * 1024
"""The WebAssembly page."""
MIB: Final = 1024 * 1024
RESERVATION_SETTING: Final = "datum.runtime.validation.memory"
"""The setting the reservation follows, named by the start-up refusal."""
GROWTH_SETTING: Final = "datum.runtime.pdf.memory"
"""The setting the growth reservation follows, named when a store cannot grow to it."""

_MMAP: Final = re.compile(r"mmap failed to reserve (0x[0-9a-fA-F]+|\d+) bytes")


def pages_up(size: int) -> int:
    """Return `size` bytes rounded up to whole 64 KiB pages, in bytes."""
    if size < 0:
        raise ValueError("a memory size must not be negative")
    return -(-size // PAGE) * PAGE


def reservation(validation_memory: int, pdf_memory: int) -> tuple[int, int]:
    """Return the engine's `memory_reservation` and `memory_reservation_for_growth` for these two caps.

    The reservation is the validation cap in whole pages; the growth reservation is the room the larger cap needs past
    it, so a store that grows beyond the reservation is moved once into a region that holds its whole cap.
    """
    reserved = pages_up(validation_memory)
    growth = pages_up(max(0, pdf_memory - reserved))
    return reserved, growth


def reservation_refusal(text: str, reserved: int) -> EngineConfigurationError | None:
    """Return the start-up refusal for wasmtime's `mmap failed to reserve` error text, or None for any other text."""
    if not text.startswith("mmap failed to reserve"):
        return None
    found = _MMAP.search(text)
    asked = int(found.group(1), 0) if found else None
    asked_text = f"{asked} bytes" if asked is not None else "address space"
    return EngineConfigurationError(
        f"the wasmtime runtime could not reserve {asked_text} of address space for one run's memory "
        f"({RESERVATION_SETTING} reserves {reserved} bytes per run): mmap failed to reserve; the process's "
        f"address-space limit (ulimit -v) is too low",
        hint=(
            f"raise the address-space limit (ulimit -v) to at least 50 MiB plus, per run slot, {RESERVATION_SETTING} "
            f"plus 1 MiB, or lower {RESERVATION_SETTING} or the run concurrency"
        ),
    )


def growth_refusal(text: str, total: int) -> EngineConfigurationError:
    """Return the start-up refusal for a throwaway store that could not grow to `total` bytes (the PDF cap's room)."""
    return EngineConfigurationError(
        f"the wasmtime runtime could not grow one run's memory to {total} bytes ({GROWTH_SETTING} sets the largest "
        f"run): {text[:200]}; the process's address-space limit (ulimit -v) is too low",
        hint=(
            f"raise the address-space limit (ulimit -v) to at least 50 MiB plus, per run slot, {GROWTH_SETTING} "
            f"plus 1 MiB, or lower {GROWTH_SETTING} or the run concurrency"
        ),
    )
