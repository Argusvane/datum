"""Shared test setup of argusvane-datum-sandbox."""

from collections.abc import Sequence

import pytest

from datum_sandbox.testing.markers import skip_runtime_under_xdist


def pytest_collection_modifyitems(config: pytest.Config, items: Sequence[pytest.Item]) -> None:
    skip_runtime_under_xdist(config, items)
