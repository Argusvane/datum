"""The memory settings: whole pages, the reservation formula, and the start-up refusal for `mmap failed to reserve`."""

import subprocess
import sys
import textwrap

import pytest

from datum_sandbox_wasmtime._memory import (
    MIB,
    PAGE,
    RESERVATION_SETTING,
    pages_up,
    reservation,
    reservation_refusal,
)

MMAP_TEXT = "mmap failed to reserve 0x104000000 bytes\n\nCaused by:\n    Out of memory (os error 12)"


@pytest.mark.parametrize(
    ("size", "pages"),
    [(0, 0), (1, PAGE), (PAGE, PAGE), (PAGE + 1, 2 * PAGE), (32 * MIB, 32 * MIB), (32 * MIB + 7, 32 * MIB + PAGE)],
)
def test_sizes_round_up_to_whole_pages(size: int, pages: int) -> None:
    assert pages_up(size) == pages


def test_a_negative_size_is_refused() -> None:
    with pytest.raises(ValueError, match="negative"):
        pages_up(-1)


def test_the_reservation_is_the_validation_cap_and_growth_reaches_the_pdf_cap() -> None:
    assert reservation(32 * MIB, 256 * MIB) == (32 * MIB, 224 * MIB)
    assert reservation(32 * MIB + 1, 256 * MIB) == (32 * MIB + PAGE, 224 * MIB - PAGE)
    assert reservation(64 * MIB, 32 * MIB) == (64 * MIB, 0), "no growth room when the PDF cap is not larger"


def test_an_mmap_refusal_names_the_setting_the_bytes_and_ulimit() -> None:
    refusal = reservation_refusal(MMAP_TEXT, 32 * MIB)
    assert refusal is not None
    assert RESERVATION_SETTING in refusal.message
    assert str(0x104000000) in refusal.message, "the bytes asked for, in decimal"
    assert str(32 * MIB) in refusal.message
    assert "ulimit -v" in refusal.message
    assert "ulimit -v" in refusal.hint


def test_a_decimal_byte_count_is_read_too() -> None:
    refusal = reservation_refusal("mmap failed to reserve 4096 bytes", PAGE)
    assert refusal is not None
    assert "4096 bytes" in refusal.message


def test_other_errors_are_not_an_address_space_refusal() -> None:
    assert reservation_refusal("wasm trap: interrupt", PAGE) is None
    assert reservation_refusal("failed: mmap failed to reserve 1 bytes", PAGE) is None, "only at the start of the text"


@pytest.mark.runtime
@pytest.mark.skipif(sys.platform != "linux", reason="only Linux enforces RLIMIT_AS (macOS ignores ulimit -v)")
def test_an_address_space_limit_too_low_for_the_reservation_stops_the_start() -> None:
    """A child process under `ulimit -v` 1 GiB with a 2 GiB reservation: the start refuses with the setting named."""
    script = textwrap.dedent(
        """
        import resource, tempfile
        from pathlib import Path
        from datum_sandbox.wasi import EngineConfigurationError, EngineLimits
        resource.setrlimit(resource.RLIMIT_AS, (1 << 30, 1 << 30))
        from datum_sandbox_wasmtime import WasmtimeGuestRuntime
        try:
            WasmtimeGuestRuntime(
                EngineLimits({"validation": 1, "pdf": 1}, Path(tempfile.mkdtemp()), memory_bytes=2 << 30)
            )
        except EngineConfigurationError as error:
            print("REFUSED", error.message)
        else:
            print("STARTED")
        """
    )
    done = subprocess.run(  # noqa: S603 - this interpreter and a fixed script
        [sys.executable, "-c", script], capture_output=True, text=True, timeout=120, check=False
    )
    assert "REFUSED" in done.stdout, done.stdout + done.stderr
    assert RESERVATION_SETTING in done.stdout
    assert "ulimit -v" in done.stdout


@pytest.mark.runtime
@pytest.mark.skipif(sys.platform != "linux", reason="only Linux enforces RLIMIT_AS (macOS ignores ulimit -v)")
def test_an_address_space_limit_between_one_validation_and_one_pdf_reservation_names_the_pdf_setting() -> None:
    """The limit admits the validation reservation but not the PDF room: the start is refused naming the PDF setting.

    The first compile's own address space grows with the core count (wasmtime compiles on one thread per core, and
    glibc gives each new thread its own malloc arena): with RAYON_NUM_THREADS set, a first start under
    a limit set before it needs 128 MiB of room with one compile thread, 256 MiB with four and 768 MiB with sixteen,
    so a fixed room above the size before the first start fails on a 4-core runner before the probe. A second start
    in the same process fits in 96 MiB with any count, and the PDF room needs more than 1.1 GiB. So the child starts
    once under no limit and the limit is set 512 MiB above what the process holds after that.
    """
    script = textwrap.dedent(
        """
        import gc, resource, tempfile
        from pathlib import Path
        from datum_sandbox.wasi import EngineConfigurationError, EngineLimits
        from datum_sandbox_wasmtime import WasmtimeGuestRuntime
        warm = WasmtimeGuestRuntime(
            EngineLimits({"validation": 1, "pdf": 1}, Path(tempfile.mkdtemp()), memory_bytes=32 << 20)
        )
        warm.close()
        del warm
        gc.collect()
        size = int([l for l in open("/proc/self/status") if l.startswith("VmSize:")][0].split()[1]) * 1024
        resource.setrlimit(resource.RLIMIT_AS, (size + (512 << 20), size + (512 << 20)))
        try:
            WasmtimeGuestRuntime(
                EngineLimits({"validation": 1, "pdf": 1}, Path(tempfile.mkdtemp()), memory_bytes=32 << 20,
                max_memory_bytes=1 << 30)
            )
        except EngineConfigurationError as error:
            print("REFUSED", error.message)
        else:
            print("STARTED")
        """
    )
    done = subprocess.run(  # noqa: S603 - this interpreter and a fixed script
        [sys.executable, "-c", script], capture_output=True, text=True, timeout=120, check=False
    )
    assert "REFUSED" in done.stdout, done.stdout + done.stderr
    assert "datum.runtime.pdf.memory" in done.stdout
    assert "ulimit -v" in done.stdout
