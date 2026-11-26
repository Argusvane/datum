"""A network throttle store is built at the start (`datum.E006`) and both faces share one base class."""

import sys

import pytest
from submissions_support import Repository, plain_datum
from test_health_submissions import SUBMISSIONS_ON
from throttle_support import settings

from datum_core import checks
from datum_core.checks import CHECK_LEVELS
from datum_core.throttle import AsyncLimitsThrottle, LimitsThrottle, LimitsThrottleBase
from datum_sandbox.checks import CheckLevel, DatumConfigurationError

SALT = "s" * 32


@pytest.fixture(autouse=True)
def _no_network_client(monkeypatch: pytest.MonkeyPatch) -> None:
    """Pin the absence the tests depend on: importing the redis or coredis client fails, whatever the venv holds."""
    monkeypatch.setitem(sys.modules, "redis", None)
    monkeypatch.setitem(sys.modules, "coredis", None)


def test_e006_is_a_documented_error_id() -> None:
    assert checks.E006 == "datum.E006"
    assert CHECK_LEVELS[checks.E006] is CheckLevel.ERROR


@pytest.mark.parametrize(
    ("throttle_class", "uri"),
    [(AsyncLimitsThrottle, "async+redis://localhost:6379"), (LimitsThrottle, "redis://localhost:6379")],
    ids=["async", "sync"],
)
def test_a_store_that_cannot_be_built_is_a_start_error_naming_the_setting(throttle_class: type, uri: str) -> None:
    throttle = throttle_class(settings(storage=uri, key_salt=SALT))  # construction does not raise
    check = throttle.storage_check()
    assert check is not None
    assert check.id == checks.E006
    assert "throttle storage cannot be built" in check.msg
    assert "datum.web.throttle.storage" in check.msg + check.hint
    datum = plain_datum(SUBMISSIONS_ON, form_repository=Repository([]), throttle=throttle)
    with pytest.raises(DatumConfigurationError) as raised:
        datum.start()
    assert [problem.id for problem in raised.value.problems] == [checks.E006]


def test_the_error_names_the_class_of_the_failure_never_the_uri() -> None:
    check = AsyncLimitsThrottle(settings(storage="async+redis://:hunter2@cache.internal:6379")).storage_check()
    assert check is not None
    assert "hunter2" not in str(check)
    assert "cache.internal" not in str(check)


def test_a_memory_store_and_a_disabled_throttle_have_nothing_to_build() -> None:
    assert LimitsThrottle(settings()).storage_check() is None
    assert AsyncLimitsThrottle(settings()).storage_check() is None
    assert AsyncLimitsThrottle(settings(storage="async+redis://x", enabled=False)).storage_check() is None


def test_both_faces_share_one_base_class_that_holds_the_checks_and_the_failure_bookkeeping() -> None:
    for name in ("check_key_salt", "check_w004", "details", "_failed", "_counted", "storage_check"):
        assert name not in vars(LimitsThrottle) or name == "details"
        assert name not in vars(AsyncLimitsThrottle) or name == "details"
        assert name in vars(LimitsThrottleBase)
    assert issubclass(LimitsThrottle, LimitsThrottleBase)
    assert issubclass(AsyncLimitsThrottle, LimitsThrottleBase)
