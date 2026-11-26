"""Shared setup of argusvane-datum-fastapi's tests."""

from collections.abc import Sequence

import pytest
from trace_log import TRACE

from datum_core.testing.openssl import skip_openssl_under_xdist
from datum_core.testing.tsa_pki import TsaPki, build_pki
from datum_sandbox.testing.markers import skip_runtime_under_xdist

SERVER_XDIST_REASON = "tests marked server never run under xdist: run them in one process"


def pytest_configure(config: pytest.Config) -> None:
    # The member's pytest table does not list the server marker yet (a request is open); register it here meanwhile.
    config.addinivalue_line(
        "markers", "server: boots a server process (uvicorn, host-check); serial, never under xdist"
    )


def pytest_collection_modifyitems(config: pytest.Config, items: Sequence[pytest.Item]) -> None:
    skip_runtime_under_xdist(config, items)
    skip_openssl_under_xdist(config, items)
    if hasattr(config, "workerinput"):
        skip = pytest.mark.skip(reason=SERVER_XDIST_REASON)
        for item in items:
            if item.get_closest_marker("server") is not None:
                item.add_marker(skip)


@pytest.fixture(autouse=True)
def _clear_trace() -> None:
    TRACE.clear()


@pytest.fixture(scope="session")
def tsa_pki() -> TsaPki:
    """The throwaway timestamp PKI (EC and RSA chains, a wrong-EKU leaf, a BER leaf), built once per session."""
    return build_pki()
