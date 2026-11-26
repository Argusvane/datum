"""The config setting `datum.runtime.worker_threads`."""

import pytest
from pydantic import ValidationError

from datum_core.config import DatumConfig


def test_worker_threads_default_to_zero_meaning_derived_from_the_slots() -> None:
    assert DatumConfig().runtime.worker_threads == 0


def test_worker_threads_take_a_whole_number() -> None:
    assert DatumConfig.model_validate({"runtime": {"worker_threads": 12}}).runtime.worker_threads == 12


def test_a_negative_count_names_the_field() -> None:
    with pytest.raises(ValidationError, match="worker_threads") as raised:
        DatumConfig.model_validate({"runtime": {"worker_threads": -1}})
    assert raised.value.errors()[0]["type"] == "greater_than_equal"  # a bound, not an unknown key


def test_the_field_is_described() -> None:
    field = type(DatumConfig().runtime).model_fields["worker_threads"]
    assert field.description
    assert "slots" in field.description
