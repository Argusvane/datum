"""The build guard refuses a build whose generated files are absent or stale, and passes a complete one."""

import importlib.util
import json
import sys
import types
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

_GUARD = Path(__file__).resolve().parents[1] / "hatch_build.py"

pytestmark = pytest.mark.skipif(not _GUARD.is_file(), reason="hatch_build.py is not part of this tree")


def _load_guard(monkeypatch: pytest.MonkeyPatch) -> Any:
    """Load hatch_build.py with a stand-in for hatchling's plugin interface (hatchling is a build requirement only)."""

    class BuildHookInterface:
        def __init__(self, root: str, metadata: object) -> None:
            self.root = root
            self.metadata = metadata

    name = "hatchling.builders.hooks.plugin.interface"
    stubs = {
        "hatchling": types.ModuleType("hatchling"),
        "hatchling.builders": types.ModuleType("hatchling.builders"),
        "hatchling.builders.hooks": types.ModuleType("hatchling.builders.hooks"),
        "hatchling.builders.hooks.plugin": types.ModuleType("hatchling.builders.hooks.plugin"),
        name: types.ModuleType(name),
    }
    stubs[name].BuildHookInterface = BuildHookInterface  # type: ignore[attr-defined]
    for key, module in stubs.items():
        monkeypatch.setitem(sys.modules, key, module)
    spec = importlib.util.spec_from_file_location("datum_hatch_build_under_test", _GUARD)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.GuardHook


def _member(root: Path, *, manifest_candidates: list[str] | None, version: str = "1.2.3") -> Path:
    package = root / "src" / "datum_sample"
    package.mkdir(parents=True)
    table = ""
    if manifest_candidates is not None:
        listed = ", ".join(json.dumps(c) for c in manifest_candidates)
        table = f"[tool.datum-build]\nmanifest = [{listed}]\n"
    (root / "pyproject.toml").write_text(
        f'[project]\nname = "datum-sample"\nversion = "{version}"\n\n{table}', encoding="utf-8"
    )
    return package


def _run(guard: Any, root: Path, version: str = "1.2.3") -> None:
    guard(str(root), SimpleNamespace(version=version)).initialize("standard", {})


def test_complete_member_passes(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    package = _member(tmp_path, manifest_candidates=["resources/manifest.json", "manifest.json"])
    (package / "datum-build.json").write_text('{"version": "1.2.3"}', encoding="utf-8")
    (package / "manifest.json").write_text("{}", encoding="utf-8")
    _run(_load_guard(monkeypatch), tmp_path)


def test_member_without_manifest_table_passes_without_manifest(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    package = _member(tmp_path, manifest_candidates=None)
    (package / "datum-build.json").write_text('{"version": "1.2.3"}', encoding="utf-8")
    _run(_load_guard(monkeypatch), tmp_path)


def test_missing_build_record_refuses(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _member(tmp_path, manifest_candidates=None)
    with pytest.raises(RuntimeError, match=r"generated file missing: .*datum-build\.json.*npm run fastapi:assets"):
        _run(_load_guard(monkeypatch), tmp_path)


def test_unparseable_build_record_names_the_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    package = _member(tmp_path, manifest_candidates=None)
    (package / "datum-build.json").write_text("{not json", encoding="utf-8")
    with pytest.raises(RuntimeError, match=r"datum-build\.json.* is unreadable"):
        _run(_load_guard(monkeypatch), tmp_path)


def test_version_disagreement_refuses(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    package = _member(tmp_path, manifest_candidates=None)
    (package / "datum-build.json").write_text('{"version": "9"}', encoding="utf-8")
    with pytest.raises(RuntimeError, match=r"version 1\.2\.3 disagrees with datum-build\.json \('9'\)"):
        _run(_load_guard(monkeypatch), tmp_path)


def test_missing_manifest_refuses_when_the_member_declares_candidates(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    package = _member(tmp_path, manifest_candidates=["resources/manifest.json", "manifest.json"])
    (package / "datum-build.json").write_text('{"version": "1.2.3"}', encoding="utf-8")
    with pytest.raises(
        RuntimeError, match=r"manifest\.json under .*looked in resources/manifest\.json, manifest\.json"
    ):
        _run(_load_guard(monkeypatch), tmp_path)
