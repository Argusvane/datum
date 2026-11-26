"""Shared test setup of argusvane-datum-core."""

from collections.abc import Sequence

import pytest

from datum_core.testing.hypothesis_profiles import load_default
from datum_core.testing.openssl import skip_openssl_under_xdist
from datum_core.testing.tsa_pki import TsaPki, build_pki
from datum_sandbox.testing.markers import skip_runtime_under_xdist

load_default()


def pytest_collection_modifyitems(config: pytest.Config, items: Sequence[pytest.Item]) -> None:
    skip_runtime_under_xdist(config, items)
    skip_openssl_under_xdist(config, items)


@pytest.fixture(scope="session")
def tsa_pki() -> TsaPki:
    """The throwaway timestamp PKI (EC and RSA chains, a wrong-EKU leaf, a BER leaf), built once per session."""
    return build_pki()
