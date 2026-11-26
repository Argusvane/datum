"""The `runtime` marker's one rule: a test that needs the wasm runtime never runs under pytest-xdist."""

from collections.abc import Sequence

import pytest

RUNTIME_MARKER = "runtime"
"""The marker name registered in every member's pytest configuration."""
XDIST_REASON = "tests marked runtime never run under xdist: run them in one process"


def skip_runtime_under_xdist(config: pytest.Config, items: Sequence[pytest.Item]) -> int:
    """Skip every `runtime` item when this process is an xdist worker; return how many were skipped.

    Call it from `pytest_collection_modifyitems` in the conftest of a member that has runtime tests. The coordinating
    process does not run tests, so only workers (which carry `workerinput`) need the skip.
    """
    if not hasattr(config, "workerinput"):
        return 0
    skip = pytest.mark.skip(reason=XDIST_REASON)
    marked = [item for item in items if item.get_closest_marker(RUNTIME_MARKER) is not None]
    for item in marked:
        item.add_marker(skip)
    return len(marked)
