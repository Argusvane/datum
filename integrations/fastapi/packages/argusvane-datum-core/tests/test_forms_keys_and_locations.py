"""Form locations, one test per spelling; a bad file stops the start naming it; the key rule."""

import importlib
import json
import logging
import os
import sys
from pathlib import Path

import pytest
from forms_support import definition, stored_hash

from datum_core.forms import FileFormDefinitionRepository, StoredDefinition, is_form_key, parse_form_key
from datum_sandbox.checks import DatumConfigurationError

FORMS_LOGGER = "datum.forms"


def write_form(path: Path, form_id: str, *, version: str = "1") -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(definition(form_id, version, secret=False)), encoding="utf-8")
    return path


def keys(repository: FileFormDefinitionRepository) -> list[str]:
    return list(repository.keys())


# ---- the key rule ------------------------------------------------------------------------------------------------
@pytest.mark.parametrize("key", ["contact", "a", "A.b-c_d", "x" * 128, "1.0", "datum-security-suite"])
def test_a_form_key_is_one_to_128_letters_digits_dots_hyphens_or_underscores(key: str) -> None:
    assert is_form_key(key)
    assert parse_form_key(key) == (key, None)


@pytest.mark.parametrize("key", ["", "x" * 129, "a b", "a/b", "a\\b", "a\n", "é", "a\x00", "a?b", "a#b", "a%2f"])
def test_anything_else_is_not_a_form_key(key: str) -> None:
    assert not is_form_key(key)
    assert parse_form_key(key) is None


def test_the_catalog_key_is_an_id_and_a_version_after_an_at_sign() -> None:
    assert parse_form_key("datum-security-suite@1") == ("datum-security-suite", "1")
    assert parse_form_key("contact@2.1") == ("contact", "2.1")
    assert is_form_key("contact@1")


@pytest.mark.parametrize("key", ["@1", "contact@", "contact@1@2", "con tact@1", "contact@a b", "contact@" + "1" * 129])
def test_a_malformed_catalog_key_is_no_form_key(key: str) -> None:
    assert parse_form_key(key) is None
    assert not is_form_key(key)


# ---- spellings of a location -------------------------------------------------------------------------------------
def test_a_plain_path_matches_that_one_file(tmp_path: Path) -> None:
    write_form(tmp_path / "one.json", "one")
    write_form(tmp_path / "two.json", "two")
    repository = FileFormDefinitionRepository([str(tmp_path / "one.json")])
    assert keys(repository) == ["one"]


def test_a_star_glob_matches_the_files_directly_in_the_directory_only(tmp_path: Path) -> None:
    write_form(tmp_path / "forms" / "a.json", "a")
    write_form(tmp_path / "forms" / "b.json", "b")
    write_form(tmp_path / "forms" / "deeper" / "c.json", "c")
    (tmp_path / "forms" / "notes.txt").write_text("not a form", encoding="utf-8")
    repository = FileFormDefinitionRepository([str(tmp_path / "forms" / "*.json")])
    assert keys(repository) == ["a", "b"]


def test_a_double_star_glob_matches_below_the_directory_at_any_depth_including_none(tmp_path: Path) -> None:
    write_form(tmp_path / "forms" / "a.json", "a")
    write_form(tmp_path / "forms" / "x" / "b.json", "b")
    write_form(tmp_path / "forms" / "x" / "y" / "z" / "c.json", "c")
    repository = FileFormDefinitionRepository([str(tmp_path / "forms" / "**" / "*.json")])
    assert sorted(keys(repository)) == ["a", "b", "c"]


def test_a_package_location_walks_the_packages_resources(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    package = tmp_path / "libs" / "datum_test_forms_pkg"
    (package).mkdir(parents=True)
    (package / "__init__.py").write_text("", encoding="utf-8")
    write_form(package / "forms" / "p.json", "from-package")
    write_form(package / "forms" / "nested" / "q.json", "nested-not-matched")
    monkeypatch.syspath_prepend(str(tmp_path / "libs"))  # pyright: ignore[reportUnknownMemberType]
    importlib.invalidate_caches()
    try:
        repository = FileFormDefinitionRepository(["package:datum_test_forms_pkg/forms/*.json"])
        assert keys(repository) == ["from-package"]
        deep = FileFormDefinitionRepository(["package:datum_test_forms_pkg/forms/**/*.json"])
        assert sorted(keys(deep)) == ["from-package", "nested-not-matched"]
    finally:
        sys.modules.pop("datum_test_forms_pkg", None)


def test_the_walk_takes_regular_files_only_sorted_by_path(tmp_path: Path) -> None:
    write_form(tmp_path / "forms" / "b.json", "alpha")
    write_form(tmp_path / "forms" / "a.json", "zeta")
    (tmp_path / "forms" / "dir.json").mkdir()  # a directory with a form's name is not a file
    repository = FileFormDefinitionRepository([str(tmp_path / "forms" / "*.json")])
    assert keys(repository) == ["zeta", "alpha"]  # a.json before b.json, whatever the keys sort to


def test_the_walk_starts_at_the_deepest_directory_with_no_glob_character(tmp_path: Path) -> None:
    write_form(tmp_path / "one" / "two" / "a.json", "a")
    write_form(tmp_path / "one" / "other" / "b.json", "b")
    repository = FileFormDefinitionRepository([str(tmp_path / "one" / "two" / "*.json")])
    assert keys(repository) == ["a"]


@pytest.mark.skipif(os.geteuid() == 0, reason="root reads any directory")
def test_an_unreadable_directory_logs_a_warning_and_loads_nothing_from_it(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    write_form(tmp_path / "open" / "a.json", "a")
    write_form(tmp_path / "locked" / "b.json", "b")
    (tmp_path / "locked").chmod(0o000)
    try:
        with caplog.at_level(logging.WARNING, logger=FORMS_LOGGER):
            repository = FileFormDefinitionRepository(
                [str(tmp_path / "open" / "*.json"), str(tmp_path / "locked" / "*.json")]
            )
    finally:
        (tmp_path / "locked").chmod(0o700)
    assert keys(repository) == ["a"]
    assert [r for r in caplog.records if r.name == FORMS_LOGGER and r.levelno == logging.WARNING]


def test_a_location_that_matches_nothing_logs_the_documented_sentence(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    location = str(tmp_path / "none" / "*.json")
    with caplog.at_level(logging.WARNING, logger=FORMS_LOGGER):
        repository = FileFormDefinitionRepository([location])
    assert keys(repository) == []
    expected = f'The Datum form location "{location}" matched no resources; check datum.forms.locations.'
    assert expected in [r.getMessage() for r in caplog.records if r.name == FORMS_LOGGER]


def test_a_location_that_matches_something_logs_no_warning(tmp_path: Path, caplog: pytest.LogCaptureFixture) -> None:
    write_form(tmp_path / "a.json", "a")
    with caplog.at_level(logging.WARNING, logger=FORMS_LOGGER):
        FileFormDefinitionRepository([str(tmp_path / "*.json")])
    assert not [r for r in caplog.records if r.name == FORMS_LOGGER]


# ---- a bad file stops the start naming the file --------------------------------------------------------------------
def refuses_naming(path: Path, locations: list[str]) -> str:
    with pytest.raises(DatumConfigurationError) as raised:
        FileFormDefinitionRepository(locations)
    text = str(raised.value)
    assert str(path) in text
    return text


def test_a_file_that_is_not_json_stops_the_start_naming_it(tmp_path: Path) -> None:
    bad = tmp_path / "broken.json"
    bad.write_text("{not json", encoding="utf-8")
    refuses_naming(bad, [str(tmp_path / "*.json")])


def test_a_file_that_is_not_a_json_object_stops_the_start_naming_it(tmp_path: Path) -> None:
    bad = tmp_path / "list.json"
    bad.write_text("[1, 2]", encoding="utf-8")
    refuses_naming(bad, [str(tmp_path / "*.json")])


def test_a_file_with_no_id_stops_the_start_naming_it(tmp_path: Path) -> None:
    bad = tmp_path / "noid.json"
    bad.write_text(json.dumps({"version": "1", "root": {}}), encoding="utf-8")
    refuses_naming(bad, [str(tmp_path / "*.json")])


def test_a_file_whose_id_is_not_a_form_key_stops_the_start_naming_the_file_and_the_key(tmp_path: Path) -> None:
    bad = write_form(tmp_path / "badkey.json", "has a space")
    text = refuses_naming(bad, [str(tmp_path / "*.json")])
    assert "has a space" in text


def test_a_file_with_the_nan_constant_stops_the_start_because_the_strict_reader_reads_it(tmp_path: Path) -> None:
    bad = tmp_path / "nan.json"
    bad.write_text('{"id": "n", "version": "1", "x": NaN}', encoding="utf-8")
    refuses_naming(bad, [str(tmp_path / "*.json")])


def test_two_files_with_one_key_stop_the_start_naming_both(tmp_path: Path) -> None:
    first = write_form(tmp_path / "a.json", "same")
    second = write_form(tmp_path / "b.json", "same")
    text = refuses_naming(first, [str(tmp_path / "*.json")])
    assert str(second) in text


# ---- what the repository answers -----------------------------------------------------------------------------------
def test_current_answers_the_stored_definition_with_its_canonical_hash(tmp_path: Path) -> None:
    write_form(tmp_path / "a.json", "contact")
    repository = FileFormDefinitionRepository([str(tmp_path / "*.json")])
    stored = repository.current("contact")
    assert isinstance(stored, StoredDefinition)
    assert stored.key == "contact"
    assert stored.sha256 == stored_hash(stored.definition)
    assert len(stored.sha256) == 64
    assert repository.current("other") is None
