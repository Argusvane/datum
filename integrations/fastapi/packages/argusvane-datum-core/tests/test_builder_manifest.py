"""`known_component_types`: the component types come from the UI manifest, and a builder that cannot read them fails."""

import json
from pathlib import Path

import pytest

from datum_core.builder import known_component_types
from datum_sandbox.checks import DatumConfigurationError


def test_the_installed_manifest_names_the_component_types() -> None:
    types = known_component_types()
    assert types
    assert "form" in types
    assert "text" in types


def test_a_missing_package_is_a_configuration_error_not_an_empty_list() -> None:
    with pytest.raises(DatumConfigurationError):
        known_component_types("datum_no_such_package")


def test_a_manifest_without_the_list_is_a_configuration_error(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    package = tmp_path / "datum_manifest_without_types"
    package.mkdir()
    (package / "__init__.py").write_text("")
    (package / "manifest.json").write_text(json.dumps({"other": []}))
    monkeypatch.syspath_prepend(str(tmp_path))
    with pytest.raises(DatumConfigurationError):
        known_component_types("datum_manifest_without_types")
