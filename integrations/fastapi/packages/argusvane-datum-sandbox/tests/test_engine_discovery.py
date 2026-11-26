"""Entry-point discovery over scratch distributions: real dist-info directories in a temporary directory."""

# ruff: noqa: PT018

import textwrap
from importlib.metadata import EntryPoint
from pathlib import Path
from typing import Any

import pytest

from datum_sandbox.checks import DatumConfigurationError
from datum_sandbox.protocol import PoolKind, ProgramLimits
from datum_sandbox.wasi import (
    GROUP,
    Available,
    EngineConfigurationError,
    EngineInfo,
    EngineLimits,
    EngineSelectionError,
    EngineSettings,
    GuestRuntimes,
    RunBudget,
    Unavailable,
)

PROVIDER = """
from datum_sandbox.wasi import Available, EngineConfigurationError, Unavailable

class Provider:
    id = {id!r}
    def availability(self):
        return {availability}
    def create(self, limits, engine_settings):
        raise NotImplementedError
"""


def make_dist(root: Path, dist: str, entries: dict[str, str], *, module: str | None = None, source: str = "") -> None:
    """Write `<dist>-1.0.dist-info` with an entry_points.txt, and optionally an importable module beside it."""
    info = root / f"{dist.replace('-', '_')}-1.0.dist-info"
    info.mkdir()
    (info / "METADATA").write_text(f"Metadata-Version: 2.1\nName: {dist}\nVersion: 1.0\n")
    lines = "\n".join(f"{name} = {value}" for name, value in entries.items())
    (info / "entry_points.txt").write_text(f"[{GROUP}]\n{lines}\n")
    if module:
        (root / f"{module}.py").write_text(textwrap.dedent(source))


@pytest.fixture
def site(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    root = tmp_path / "site"
    root.mkdir()
    monkeypatch.syspath_prepend(str(root))  # pyright: ignore[reportUnknownMemberType]
    return root


def provider(id_: str, availability: str = "Available(('ok',))") -> str:
    return PROVIDER.format(id=id_, availability=availability)


def test_a_scratch_provider_is_discovered_listed_and_selected(site: Path) -> None:
    make_dist(
        site, "scratch-engine", {"fake": "scratch_mod_a:Provider"}, module="scratch_mod_a", source=provider("fake")
    )
    found = GuestRuntimes.discover(path=[str(site)])
    assert found.ids() == ("fake",)
    (item,) = found.listing
    assert (item.id, item.distribution, item.error) == ("fake", "scratch-engine", None)
    assert item.availability == Available(("ok",))
    chosen = found.select("fake")
    assert chosen.id == "fake"
    assert found.duplicates() == {}


def test_two_distributions_claiming_one_id_stop_the_start_naming_both(site: Path) -> None:
    make_dist(
        site,
        "engine-one",
        {"wasmtime": "scratch_mod_b1:Provider"},
        module="scratch_mod_b1",
        source=provider("wasmtime"),
    )
    make_dist(
        site,
        "engine-two",
        {"wasmtime": "scratch_mod_b2:Provider"},
        module="scratch_mod_b2",
        source=provider("wasmtime"),
    )
    found = GuestRuntimes.discover(path=[str(site)])
    assert len(found.listing) == 2  # both are listed
    with pytest.raises(EngineSelectionError) as refusal:
        found.select("wasmtime")
    message = str(refusal.value)
    assert "engine-one" in message and "engine-two" in message and "wasmtime" in message
    # The WASI layer's own refusal: the sandbox's start translates it into a DatumConfigurationError, once.
    assert isinstance(refusal.value, EngineConfigurationError)
    assert not isinstance(refusal.value, DatumConfigurationError)
    assert refusal.value.hint


def test_a_second_copy_of_one_distribution_is_not_a_duplicate(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    first, second = tmp_path / "a", tmp_path / "b"
    first.mkdir()
    second.mkdir()
    monkeypatch.syspath_prepend(str(first))  # pyright: ignore[reportUnknownMemberType]
    for root in (first, second):
        make_dist(
            root, "same-dist", {"solo": "scratch_mod_c:Provider"}, module="scratch_mod_c", source=provider("solo")
        )
    found = GuestRuntimes.discover(path=[str(first), str(second)])
    assert len(found.listing) == 1  # importlib.metadata hides the second copy of one distribution
    assert found.select("solo").id == "solo"


def test_a_broken_provider_is_listed_broken_and_hides_no_other(site: Path) -> None:
    make_dist(
        site, "good-engine", {"good": "scratch_mod_d1:Provider"}, module="scratch_mod_d1", source=provider("good")
    )
    make_dist(
        site,
        "bad-import",
        {"bad": "scratch_mod_d2:Provider"},
        module="scratch_mod_d2",
        source="raise ImportError('boom')\n",
    )
    make_dist(
        site,
        "bad-name",
        {"named": "scratch_mod_d3:Provider"},
        module="scratch_mod_d3",
        source=provider("other"),
    )
    make_dist(
        site,
        "bad-availability",
        {"avail": "scratch_mod_d4:Provider"},
        module="scratch_mod_d4",
        source=provider("avail", "1 / 0"),
    )
    found = GuestRuntimes.discover(path=[str(site)])
    by_id = {item.id: item for item in found.listing}
    assert set(by_id) == {"good", "bad", "named", "avail"}
    assert by_id["good"].error is None
    for broken in ("bad", "named", "avail"):
        assert by_id[broken].error and by_id[broken].provider is None
    assert "boom" in (by_id["bad"].error or "")
    assert found.select("good").id == "good"
    with pytest.raises(EngineSelectionError, match="broken"):
        found.select("bad")


def test_unknown_and_unavailable_engines_stop_the_start(site: Path) -> None:
    make_dist(
        site,
        "away",
        {"away": "scratch_mod_e:Provider"},
        module="scratch_mod_e",
        source=provider("away", "Unavailable('no wheel for this platform')"),
    )
    found = GuestRuntimes.discover(path=[str(site)])
    with pytest.raises(EngineSelectionError, match="no wheel for this platform"):
        found.select("away")
    with pytest.raises(EngineSelectionError, match=r"'missing'.*away"):
        found.select("missing")
    assert isinstance(found.listing[0].availability, Unavailable)


def test_an_empty_group_names_nothing_found(site: Path) -> None:
    found = GuestRuntimes.discover(path=[str(site)])
    assert found.listing == ()
    with pytest.raises(EngineSelectionError, match="none installed"):
        found.select("wasmtime")


def test_entry_points_may_be_supplied_directly(site: Path) -> None:
    (site / "scratch_mod_f.py").write_text(provider("direct"))
    entry = EntryPoint("direct", "scratch_mod_f:Provider", GROUP)
    found = GuestRuntimes.discover(entry_points=[entry])
    assert found.select("direct").id == "direct"
    assert found.listing[0].distribution == "<unnamed distribution>"


def test_the_installed_group_is_readable_without_error() -> None:
    # No engine is installed in this tree yet; discovery over the real environment must still answer.
    assert isinstance(GuestRuntimes.discover().ids(), tuple)


def test_engine_records() -> None:
    info = EngineInfo("wasmtime", "50.0.0", "interpreter", notes=("a",))
    assert (info.id, info.release, info.mode, info.notes) == ("wasmtime", "50.0.0", "interpreter", ("a",))
    assert not hasattr(info, "pdf_capable"), "whether the PDF program runs is the sandbox's decision, not the engine's"
    assert EngineInfo("x", "1", "m").notes == ()
    limits = EngineLimits({"validation": 2, "pdf": 1}, Path("/w"))
    assert limits.tick_seconds == 0.05
    assert (limits.memory_bytes, limits.max_memory_bytes) == (32 << 20, 256 << 20), "the documented defaults"
    bad_caps: list[dict[str, Any]] = [{"memory_bytes": 0}, {"max_memory_bytes": -1}]
    for bad in bad_caps:
        with pytest.raises(ValueError, match="memory"):
            EngineLimits({"validation": 2}, Path("/w"), **bad)
    for pools in ({}, {"validation": 0}, {"": 1}, {"pdf": True}):
        with pytest.raises(ValueError, match="pool"):
            EngineLimits(pools, Path("/w"))
    assert RunBudget(wall_seconds=1, memory_bytes=1).pool == "default", "a generic budget names the default pool"
    assert [kind.value for kind in PoolKind] == ["validation", "pdf"]
    assert ProgramLimits().validation_budget().pool is PoolKind.VALIDATION, "a Datum run names its pool"
    assert EngineSettings(stray_bound=3).stray_bound == 3


def test_a_nameless_distribution_does_not_hide_the_others(site: Path) -> None:
    make_dist(
        site, "good", {"good": "scratch_mod_nameless:Provider"}, module="scratch_mod_nameless", source=provider("good")
    )
    info = site / "broken_1.0.dist-info"
    info.mkdir()
    (info / "METADATA").write_text("Metadata-Version: 2.1\nVersion: 1.0\n")
    (info / "entry_points.txt").write_text(f"[{GROUP}]\nbroken = no_such_module_xyz:Provider\n")
    found = GuestRuntimes.discover(path=[str(site)])
    assert found.ids() == ("broken", "good")
    assert found.select("good").id == "good"


def test_an_availability_of_the_wrong_type_is_listed_broken(site: Path) -> None:
    make_dist(
        site,
        "wrong-type",
        {"yes": "scratch_mod_yes:Provider"},
        module="scratch_mod_yes",
        source=provider("yes", availability='"yes"'),
    )
    found = GuestRuntimes.discover(path=[str(site)])
    (item,) = found.listing
    assert (item.id, item.distribution, item.availability) == ("yes", "wrong-type", None)
    assert item.error == "availability() answered neither Available nor Unavailable"
    with pytest.raises(EngineSelectionError):
        found.select("yes")
