"""Smoke test: the member imports, is typed and carries the workspace version."""

import json
from importlib import metadata, resources

import datum_assets_pdf


def test_distribution_version() -> None:
    assert metadata.version("argusvane-datum-assets-pdf") == "0.1.0"


def test_typed_marker() -> None:
    assert resources.files(datum_assets_pdf.__name__).joinpath("py.typed").is_file()


def test_build_record_ships_and_matches_the_wheel_version() -> None:
    record = resources.files(datum_assets_pdf.__name__).joinpath("datum-build.json")
    assert record.is_file()
    assert json.loads(record.read_text(encoding="utf-8"))["version"] == metadata.version("argusvane-datum-assets-pdf")


def test_manifest_ships() -> None:
    assert resources.files(datum_assets_pdf.__name__).joinpath("manifest.json").is_file()
