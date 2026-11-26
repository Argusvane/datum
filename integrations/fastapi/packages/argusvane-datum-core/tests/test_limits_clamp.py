"""The budget clamp (`SandboxSettings.build`): the table, one datum.W008 per clamped value, the floor as datum.E003.

`sandbox_settings(config)` maps the `datum.runtime` section onto it; `ProgramLimits` is the bounded record it builds.
"""

from dataclasses import fields
from pathlib import Path

import pytest

from datum_core.config import DatumConfig
from datum_core.config.sandbox import sandbox_settings
from datum_sandbox.checks import E003, W008, CheckLevel, DatumCheck, DatumConfigurationError
from datum_sandbox.protocol import PoolKind, ProgramLimits
from datum_sandbox.protocol import _limits as limits_module
from datum_sandbox.runtime import SandboxSettings
from datum_sandbox.wasi import STDOUT_CAP

MIB = 1024 * 1024


def clamp(*, memory_floor: int = 0, **values: object) -> tuple[ProgramLimits, tuple[object, ...]]:
    settings = SandboxSettings.build(memory_floor=memory_floor, **values)  # type: ignore[arg-type]
    return settings.limits, settings.checks


def from_config(config: DatumConfig) -> tuple[ProgramLimits, tuple[object, ...]]:
    settings = sandbox_settings(config)
    return settings.limits, settings.checks


# (field, below the low bound, the low bound, above the high bound, the high bound)
TABLE = [
    ("validation_time_limit", 0.0001, 0.001, 61.0, 60.0),
    ("validation_memory", 1 * MIB, 4 * MIB, 2048 * MIB, 1024 * MIB),
    ("validation_concurrency", -1, 0, 65, 64),
    ("validation_wait", -0.5, 0.0, 11.0, 10.0),
    ("pdf_time_limit", 0.0001, 0.001, 301.0, 300.0),
    ("pdf_memory", 16 * MIB, 32 * MIB, 5000 * MIB, 4096 * MIB),
    ("pdf_concurrency", -3, 0, 100, 64),
    ("pdf_wait", -1.0, 0.0, 10.5, 10.0),
    ("verify_max_bytes", 1, MIB, 101 * MIB, 100 * MIB),
]


def test_table_covers_every_field() -> None:
    assert {row[0] for row in TABLE} == {f.name for f in fields(ProgramLimits)}
    assert set(ProgramLimits.bounds()) == {f.name for f in fields(ProgramLimits)}


def test_defaults() -> None:
    limits = ProgramLimits()
    assert limits.validation_time_limit == 5
    assert limits.validation_memory == 32 * MIB
    assert limits.validation_concurrency == 0
    assert limits.validation_wait == 2
    assert limits.pdf_time_limit == 60
    assert limits.pdf_memory == 256 * MIB
    assert limits.pdf_concurrency == 0
    assert limits.pdf_wait == 2
    assert limits.verify_max_bytes == 20 * MIB


@pytest.mark.parametrize(("name", "below", "low", "above", "high"), TABLE, ids=[row[0] for row in TABLE])
def test_clamped_to_the_nearest_bound_with_one_warning(
    name: str, below: float, low: float, above: float, high: float
) -> None:
    for asked, expected in ((below, low), (above, high)):
        limits, checks = clamp(**{name: asked})  # type: ignore[arg-type]
        assert getattr(limits, name) == expected
        assert len(checks) == 1
        (check,) = checks
        assert isinstance(check, DatumCheck)
        assert check.id == W008
        assert check.level is CheckLevel.WARNING
        assert check.msg.startswith(ProgramLimits.bounds()[name].setting + " is ")
        assert str(check.hint).startswith("the bound is ")


@pytest.mark.parametrize(("name", "below", "low", "above", "high"), TABLE, ids=[row[0] for row in TABLE])
def test_bounds_themselves_pass_without_a_warning(
    name: str, below: float, low: float, above: float, high: float
) -> None:
    for asked in (low, high):
        limits, checks = clamp(**{name: asked})  # type: ignore[arg-type]
        assert getattr(limits, name) == asked
        assert checks == ()


@pytest.mark.parametrize(("name", "below", "low", "above", "high"), TABLE, ids=[row[0] for row in TABLE])
def test_built_directly_out_of_bounds_is_refused(
    name: str, below: float, low: float, above: float, high: float
) -> None:
    for asked in (below, above):
        with pytest.raises(ValueError, match=name):
            ProgramLimits(**{name: asked})  # type: ignore[arg-type]


def test_several_clamped_values_give_one_warning_each() -> None:
    _, checks = clamp(validation_time_limit=120, pdf_time_limit=900, validation_wait=3)
    found = [c for c in checks if isinstance(c, DatumCheck)]
    assert [c.id for c in found] == [W008, W008]
    assert "datum.runtime.validation.time_limit is 120 s; 60 s is used" in found[0].msg
    assert "datum.runtime.pdf.time_limit is 900 s; 300 s is used" in found[1].msg


def test_none_means_the_default() -> None:
    limits, checks = clamp(validation_time_limit=None, pdf_memory=None)
    assert limits == ProgramLimits()
    assert checks == ()


def test_unknown_budget_name_refused() -> None:
    with pytest.raises(TypeError, match="validation_seconds"):
        clamp(validation_seconds=5)
    with pytest.raises(TypeError, match="validation_seconds"):
        SandboxSettings.build(defaults={"validation_seconds": 5})


def test_memory_below_the_module_floor_is_an_error_not_a_clamp() -> None:
    floor = 8 * MIB  # the module's initial pages x 64 KiB
    with pytest.raises(DatumConfigurationError) as raised:
        clamp(memory_floor=floor, validation_memory=6 * MIB, pdf_memory=7 * MIB)
    assert [c.id for c in raised.value.problems] == [E003, E003]
    assert all(c.level is CheckLevel.ERROR for c in raised.value.problems)
    # At or above the floor but below the bound's low end: an ordinary clamp.
    limits, checks = clamp(memory_floor=2 * MIB, validation_memory=3 * MIB)
    assert limits.validation_memory == 4 * MIB
    assert [c.id for c in checks if isinstance(c, DatumCheck)] == [W008]


def test_non_numbers_refused() -> None:
    with pytest.raises(TypeError):
        ProgramLimits(validation_time_limit=float("nan"))
    with pytest.raises(TypeError):
        ProgramLimits(validation_memory=True)
    with pytest.raises(TypeError):
        ProgramLimits(validation_memory="32MiB")  # type: ignore[arg-type]


def test_from_config_reads_the_runtime_section() -> None:
    config = DatumConfig.model_validate(
        {"runtime": {"validation": {"time_limit": 120, "memory": "2GiB"}, "pdf": {"time_limit": "PT10M"}}}
    )
    limits, checks = from_config(config)
    assert limits.validation_time_limit == 60
    assert limits.validation_memory == 1024 * MIB
    assert limits.pdf_time_limit == 300
    assert len(checks) == 3
    assert {c.id for c in checks if isinstance(c, DatumCheck)} == {W008}


def test_from_config_defaults_clamp_nothing() -> None:
    limits, checks = from_config(DatumConfig())
    assert limits == ProgramLimits()
    assert checks == ()


def test_slots_and_budgets() -> None:
    limits = ProgramLimits(validation_concurrency=3, pdf_concurrency=5, validation_wait=1.5, pdf_memory=64 * MIB)
    assert limits.validation_slots() == 3
    assert limits.pdf_slots() == 5
    defaults = ProgramLimits()
    assert defaults.validation_slots() == limits_module.cpus()
    assert defaults.pdf_slots() == min(2, limits_module.cpus())
    budget = limits.validation_budget()
    assert (budget.wall_seconds, budget.memory_bytes, budget.wait) == (5, 32 * MIB, 1.5)
    assert budget.pool is PoolKind.VALIDATION
    pdf = limits.pdf_budget()
    assert (pdf.wall_seconds, pdf.memory_bytes, pdf.stdout_cap, pdf.stderr_cap) == (60, 64 * MIB, STDOUT_CAP, 64 * 1024)
    assert pdf.pool is PoolKind.PDF, "a PDF budget runs in the PDF pool"


def test_the_engine_limits_carry_the_two_pools_and_both_memory_caps(tmp_path: Path) -> None:
    limits = ProgramLimits(
        validation_concurrency=3, pdf_concurrency=1, validation_memory=48 * MIB, pdf_memory=512 * MIB
    )
    engine = limits.engine_limits(tmp_path, tick_seconds=0.025)
    assert (dict(engine.pools), engine.work_dir, engine.tick_seconds) == (
        {"validation": 3, "pdf": 1},
        tmp_path,
        0.025,
    )
    assert (engine.memory_bytes, engine.max_memory_bytes) == (48 * MIB, 512 * MIB)
    defaults = ProgramLimits().engine_limits(tmp_path)
    assert (defaults.memory_bytes, defaults.max_memory_bytes, defaults.tick_seconds) == (32 * MIB, 256 * MIB, 0.05)


@pytest.mark.parametrize(
    ("name", "value"),
    [
        ("validation_time_limit", float("nan")),
        ("validation_time_limit", float("inf")),
        ("validation_time_limit", float("-inf")),
        ("validation_concurrency", True),
        ("validation_concurrency", 3.7),
        ("pdf_memory", float("nan")),
    ],
)
def test_clamp_refuses_what_the_constructor_refuses(name: str, value: object) -> None:
    with pytest.raises(TypeError, match=name):
        clamp(**{name: value})  # type: ignore[arg-type]


def test_a_config_outside_the_table_reaches_the_clamp() -> None:
    """The model refuses no budget by range, so the clamp's W008 is reachable."""
    config = DatumConfig.model_validate({"runtime": {"validation": {"concurrency": 65}}})
    limits, checks = from_config(config)
    assert limits.validation_concurrency == 64
    (check,) = checks
    assert isinstance(check, DatumCheck)
    assert check.id == W008
    assert check.msg == "datum.runtime.validation.concurrency is 65 slots; 64 slots is used"
    config = DatumConfig.model_validate({"runtime": {"pdf": {"wait": 30}, "verify_max_bytes": "1GiB"}})
    limits, checks = from_config(config)
    assert (limits.pdf_wait, limits.verify_max_bytes) == (10.0, 100 * MIB)
    assert [c.id for c in checks if isinstance(c, DatumCheck)] == [W008, W008]


def test_a_floor_above_the_bounds_high_end_is_still_an_error() -> None:
    # The asked value is at or above the floor, but the clamp moves it to the high end, below the floor.
    floor = 2048 * MIB
    with pytest.raises(DatumConfigurationError) as raised:
        clamp(memory_floor=floor, validation_memory=3000 * MIB)
    assert [c.id for c in raised.value.problems] == [E003]
    assert str(1024 * MIB) in raised.value.problems[0].msg
