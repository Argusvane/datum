"""Smoke test: the member imports, is typed and carries the workspace version."""

import json
from importlib import metadata, resources

import datum_core


def test_distribution_version() -> None:
    assert metadata.version("argusvane-datum-core") == "0.1.0"


def test_typed_marker() -> None:
    assert resources.files(datum_core.__name__).joinpath("py.typed").is_file()


def test_build_record_ships_and_matches_the_wheel_version() -> None:
    record = resources.files(datum_core.__name__).joinpath("datum-build.json")
    assert record.is_file()
    assert json.loads(record.read_text(encoding="utf-8"))["version"] == metadata.version("argusvane-datum-core")
