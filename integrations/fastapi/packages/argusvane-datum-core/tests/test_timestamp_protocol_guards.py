"""Two guards of the timestamp protocols: a `Reading` holds an instant or a reason, a refusal pickles."""

import copy
import pickle
from datetime import UTC, datetime

import pytest

from datum_core.timestamp.protocols import Reading, TimestampRefusedError

NOON = datetime(2026, 10, 20, 12, 0, tzinfo=UTC)


def test_a_reading_with_an_instant_and_a_reason_is_refused() -> None:
    with pytest.raises(ValueError, match="instant or a reason"):
        Reading(NOON, "also unavailable")


def test_a_reading_with_neither_an_instant_nor_a_reason_is_refused() -> None:
    with pytest.raises(ValueError, match="instant or a reason"):
        Reading(None, None)


def test_the_two_constructors_still_build_readings() -> None:
    assert Reading.available(NOON).instant == NOON
    assert Reading.unavailable("no clock").reason == "no clock"


@pytest.mark.parametrize("message", ["", "no such policy"])
def test_a_refusal_survives_pickle_and_copy_with_its_failure_message_and_text(message: str) -> None:
    error = TimestampRefusedError("unacceptedPolicy", message)
    for again in (pickle.loads(pickle.dumps(error)), copy.copy(error), copy.deepcopy(error)):  # noqa: S301 - our own value
        assert isinstance(again, TimestampRefusedError)
        assert again.failure == "unacceptedPolicy"
        assert again.message == message
        assert again.args == error.args == ("unacceptedPolicy", message)  # what a copy or a pickle calls the class with
        assert str(again) == str(error) == (message or "unacceptedPolicy")
