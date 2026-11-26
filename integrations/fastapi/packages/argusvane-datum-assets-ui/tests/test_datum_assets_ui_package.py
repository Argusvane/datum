"""Smoke test: the member imports, is typed and carries the workspace version."""

import json
from importlib import metadata, resources

import datum_assets_ui


def test_distribution_version() -> None:
    assert metadata.version("argusvane-datum-assets-ui") == "0.1.0"


def test_typed_marker() -> None:
    assert resources.files(datum_assets_ui.__name__).joinpath("py.typed").is_file()


def test_build_record_ships_and_matches_the_wheel_version() -> None:
    record = resources.files(datum_assets_ui.__name__).joinpath("datum-build.json")
    assert record.is_file()
    assert json.loads(record.read_text(encoding="utf-8"))["version"] == metadata.version("argusvane-datum-assets-ui")


def test_manifest_ships() -> None:
    assert resources.files(datum_assets_ui.__name__).joinpath("manifest.json").is_file()
