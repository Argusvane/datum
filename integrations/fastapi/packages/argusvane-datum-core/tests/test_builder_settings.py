"""The builder's settings, and the retired setting that stays absent.

`datum.forms.too_costly_memory` is read by nothing, so the model, the generated schema and the pinned defaults in
`test_config_pinned_defaults.py` leave it out.
"""

import json
from pathlib import Path

import pytest

from datum_core import DatumConfig
from datum_core.config import models

SCHEMA = Path(models.__file__).resolve().parent.parent / "datum-settings.schema.json"
MIB = 1024 * 1024


def test_the_too_costly_memory_setting_is_gone_from_the_model() -> None:
    assert "too_costly_memory" not in models.Forms.model_fields


def test_a_deployment_that_still_sets_it_is_told_the_field_is_unknown() -> None:
    with pytest.raises(ValueError, match="too_costly_memory"):
        DatumConfig.model_validate({"forms": {"too_costly_memory": 300}})


def test_the_generated_schema_no_longer_lists_it() -> None:
    assert "too_costly_memory" not in SCHEMA.read_text(encoding="utf-8")


def test_the_builder_is_off_by_default_with_a_one_mebibyte_definition_cap() -> None:
    config = DatumConfig()
    assert config.builder.enabled is False
    assert int(config.builder.max_definition_size) == MIB


@pytest.mark.parametrize(("given", "bytes_"), [("1", 1), ("1KiB", 1024), ("64MiB", 64 * MIB)])
def test_the_cap_takes_one_byte_to_sixty_four_mebibytes(given: str, bytes_: int) -> None:
    config = DatumConfig.model_validate({"builder": {"max_definition_size": given}})
    assert int(config.builder.max_definition_size) == bytes_


@pytest.mark.parametrize("given", [0, "0", "65MiB", -1])
def test_a_cap_outside_the_bounds_is_refused_naming_the_field(given: object) -> None:
    with pytest.raises(ValueError, match="max_definition_size"):
        DatumConfig.model_validate({"builder": {"max_definition_size": given}})


def test_the_schema_is_valid_json_and_lists_the_builder_section() -> None:
    document = json.loads(SCHEMA.read_text(encoding="utf-8"))
    assert "builder" in json.dumps(document)
