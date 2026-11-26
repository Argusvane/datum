"""Shared test setup of argusvane-datum-sandbox-wasmtime: the `runtime` marker never runs under xdist."""

from collections.abc import Sequence

import pytest

from datum_sandbox.testing.markers import skip_runtime_under_xdist


def pytest_collection_modifyitems(config: pytest.Config, items: Sequence[pytest.Item]) -> None:
    skip_runtime_under_xdist(config, items)
