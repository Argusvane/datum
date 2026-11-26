"""Loading the wasmtime binding: an import that fails says which platform it failed on and what to do.

`import wasmtime` loads a native library with `ctypes`. Where no wheel carries one for the platform, pip still installs
the `py3-none-any` wheel (it holds only the Windows library) and the import dies with a bare `OSError`; on Alpine the
musl wheel needs `libgcc_s.so.1` (`apk add libgcc`). Both become Datum's start-up refusal, naming the platform and
`platform.machine()`. Nothing here imports wasmtime at module import time, so the provider stays listable everywhere.
"""

import importlib
import platform
import sys
from collections.abc import Callable
from pathlib import Path
from types import ModuleType
from typing import Final

from datum_sandbox.wasi import EngineConfigurationError

SUPPORTED: Final = (
    "Linux (glibc or musl), macOS or Windows, on x86_64 or arm64 (64-bit Python only, as wasmtime-py supports)"
)
"""The platforms wasmtime-py publishes a native library for."""


def is_musl() -> bool:
    """Whether this is a musl Linux (Alpine): the C library Python reports, or the musl loader on disk."""
    if platform.system() != "Linux":
        return False
    libc, _ = platform.libc_ver()
    return libc == "musl" or any(Path("/lib").glob("ld-musl-*.so.1"))


def platform_name() -> str:
    """Return the platform as the refusal names it: system, machine and C library."""
    system = platform.system() or sys.platform
    libc = " (musl)" if is_musl() else ""
    return f"{system}{libc} {platform.machine()!r} (platform.machine())"


def unavailable_reason(error: BaseException, *, musl: bool | None = None) -> str:
    """Return the refusal text for an `import wasmtime` that raised `error` on this platform."""
    on_musl = is_musl() if musl is None else musl
    where = platform_name()
    if isinstance(error, ImportError):
        text = (
            f"wasmtime is not installed on {where}: argusvane-datum-sandbox-wasmtime "
            f"installs it only on the platforms it "
            f"supports, {SUPPORTED}"
        )
    else:
        text = (
            f"the wasmtime binding could not load its native library on {where}: {error}. Either no wasmtime binary "
            f"exists for this platform (the py3-none-any wheel installs anywhere and carries only the Windows "
            f"library) or a system library it needs is missing; wasmtime runs on {SUPPORTED}"
        )
    if on_musl:
        text += "; on Alpine and other musl systems the wheel needs libgcc_s.so.1: apk add libgcc"
    return text


def load_wasmtime(importer: Callable[[str], ModuleType] = importlib.import_module) -> ModuleType:
    """Import the wasmtime binding, or raise `EngineConfigurationError` naming the platform.

    `importer` is the import function (a test passes one that fails the way an unsupported platform does).
    """
    try:
        return importer("wasmtime")
    except (OSError, ImportError) as error:
        raise EngineConfigurationError(
            unavailable_reason(error),
            hint="run Datum on a supported platform, or select another engine with datum.runtime.engine",
        ) from error
