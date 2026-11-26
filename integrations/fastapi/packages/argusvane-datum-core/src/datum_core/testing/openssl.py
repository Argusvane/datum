"""The `openssl` marker's rule: a test that needs the openssl binary skips, with a reason, when there is none.

The binary is the cross-check for the timestamp package (`openssl ts -verify`, `openssl ts -reply -text`), never the
implementation: nothing under `src/` runs it. `DATUM_OPENSSL` names another binary (a path, or a name on the PATH);
without it the first `openssl` on the PATH is used. A test carries `requires_openssl` (it adds the `openssl` marker and
the skip) and reads the binary through `openssl_binary()`; a test marked `openssl` never runs under xdist.
"""

import os
import shutil
from collections.abc import Sequence
from typing import Final, cast

import pytest

__all__ = [
    "OPENSSL_ENV",
    "OPENSSL_MARKER",
    "openssl_binary",
    "openssl_skip_reason",
    "requires_openssl",
    "skip_openssl_under_xdist",
]

OPENSSL_ENV: Final = "DATUM_OPENSSL"
"""The environment variable that names another openssl binary."""
OPENSSL_MARKER: Final = "openssl"
"""The marker name registered in every member's pytest configuration."""
XDIST_REASON: Final = "tests marked openssl never run under xdist: run them in one process"


def openssl_binary() -> str | None:
    """Return the openssl binary's path (`DATUM_OPENSSL`, else the PATH's), or `None` when there is none."""
    named = os.environ.get(OPENSSL_ENV)
    return shutil.which(named or "openssl")


def openssl_skip_reason() -> str | None:
    """Return why openssl tests skip here, or `None` when the binary is present."""
    if openssl_binary() is not None:
        return None
    named = os.environ.get(OPENSSL_ENV)
    if named:
        return f"{OPENSSL_ENV}={named} names no executable openssl binary"
    return f"the openssl binary is not on the PATH (set {OPENSSL_ENV} to use another)"


def requires_openssl[F](test: F) -> F:
    """Mark a test or class `openssl` and skip it, with a reason, when the binary is absent."""
    reason = openssl_skip_reason()
    marked = pytest.mark.skipif(reason is not None, reason=reason or "")(test)
    return cast("F", pytest.mark.openssl(marked))


def skip_openssl_under_xdist(config: pytest.Config, items: Sequence[pytest.Item]) -> int:
    """Skip every `openssl` item when this process is an xdist worker; return how many were skipped."""
    if not hasattr(config, "workerinput"):
        return 0
    skip = pytest.mark.skip(reason=XDIST_REASON)
    marked = [item for item in items if item.get_closest_marker(OPENSSL_MARKER) is not None]
    for item in marked:
        item.add_marker(skip)
    return len(marked)
