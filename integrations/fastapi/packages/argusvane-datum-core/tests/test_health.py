"""health(): composition, duplicates refused, frozen report, the readyz split."""

# ruff: noqa: PT018, PLW0108

import logging
from dataclasses import FrozenInstanceError
from typing import cast

import pytest

from datum_core.health import ComponentHealth, HealthCheck, HealthRegistry, HealthReport, health


def test_all_up_is_up_and_the_report_is_frozen() -> None:
    report = health([("runtime", lambda: ComponentHealth.up(engine="x")), ("stores", lambda: ComponentHealth.up())])
    assert report.status == "up" and report.is_up and report.is_ready
    with pytest.raises(FrozenInstanceError):
        report.status = "down"  # type: ignore[misc]
    with pytest.raises(TypeError):
        report.components["new"] = ComponentHealth.up()  # type: ignore[index]
    with pytest.raises(TypeError):
        report.components["runtime"].details["x"] = 1  # type: ignore[index]
    assert report.to_json() == {
        "status": "up",
        "components": {
            "runtime": {"status": "up", "details": {"engine": "x"}},
            "stores": {"status": "up", "details": {}},
        },
    }


def test_one_down_component_makes_the_whole_down_and_readyz_reads_runtime_only() -> None:
    report = health([("runtime", lambda: ComponentHealth.up()), ("tsa", lambda: ComponentHealth.down("no clock"))])
    assert report.status == "down" and not report.is_up
    assert report.is_ready  # a TSA problem never fails readyz
    assert report.components["tsa"].details == {"reason": "no clock"}
    down_runtime = health([("runtime", lambda: ComponentHealth.down("lifespan not run"))])
    assert not down_runtime.is_ready


def test_not_ready_until_the_runtime_component_exists() -> None:
    assert not health([]).is_ready
    assert health([]).status == "up"
    assert not health([("pdf", lambda: ComponentHealth.up())]).is_ready


def test_a_check_answering_nothing_is_down_with_no_status() -> None:
    report = health([("runtime", lambda: None)])
    assert report.components["runtime"] == ComponentHealth("down", {"reason": "no status"})


def test_a_raising_check_is_down_and_does_not_fail_the_probe(caplog: pytest.LogCaptureFixture) -> None:
    def boom() -> ComponentHealth:
        raise RuntimeError("secret detail")

    with caplog.at_level(logging.WARNING):
        report = health([("runtime", boom), ("pdf", lambda: ComponentHealth.up())])
    assert report.components["runtime"].status == "down"
    assert "secret detail" not in str(report.components["runtime"].details)
    assert report.components["pdf"].status == "up"


def test_duplicate_names_are_refused() -> None:
    with pytest.raises(ValueError, match="runtime"):
        health([("runtime", lambda: ComponentHealth.up()), ("runtime", lambda: ComponentHealth.up())])
    registry = HealthRegistry()
    registry.register("runtime", lambda: ComponentHealth.up())
    with pytest.raises(ValueError, match="runtime"):
        registry.register("runtime", lambda: ComponentHealth.up())
    assert registry.health().is_ready


def test_each_check_runs_once_per_report() -> None:
    calls: list[str] = []

    def check() -> ComponentHealth:
        calls.append("x")
        return ComponentHealth.up()

    health([("a", check)])
    assert calls == ["x"]
    assert isinstance(HealthReport("up", {}), HealthReport)


def answering(value: object) -> HealthCheck:
    """A contributor that breaks its type: it answers `value`, not a ComponentHealth."""
    return cast("HealthCheck", lambda: value)


def test_a_contributor_answering_something_else_is_down_bad_status() -> None:
    report = health(
        [
            ("runtime", lambda: ComponentHealth.up()),
            ("stores", answering("up")),
            ("pdf", answering({"status": "up"})),
        ]
    )
    assert report.status == "down"
    assert report.components["runtime"].status == "up"
    for name in ("stores", "pdf"):
        assert report.components[name].status == "down"
        assert report.to_json()["components"][name]["details"] == {"reason": "bad status"}  # type: ignore[index]
