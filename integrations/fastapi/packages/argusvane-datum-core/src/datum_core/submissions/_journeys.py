"""The journey step: which journey a document is judged through, and what a page check answers for.

A document that names a journey is judged through it, and one the form does not have is refused `journey.unknown`.
One that names none is judged through the form's only journey, else the one `journey.defaultJourneyId` names; a form
with several and no usable default refuses it `journey.required`; a form with no journeys, or one that opens as a
form (`journey.opensAs: "form"`), is judged whole. A page check needs a journey and a page of it (else `Malformed`).
The program works out the path from the values; the page's scope is the components it lists (`pageComponentIds`).
"""

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Final, cast

from datum_core.submissions._model import JourneyCheck
from datum_core.submissions._outcomes import Malformed
from datum_sandbox.json import JsonValue

__all__ = ["JourneyScope", "choose_journey", "in_scope"]

UNKNOWN: Final = "journey.unknown"
REQUIRED: Final = "journey.required"
_EXIT: Final = "journey.exit"


@dataclass(frozen=True, slots=True)
class JourneyScope:
    """The journey a run is judged through (`None`: the whole form), its id, and the page of a page check."""

    journey: Mapping[str, JsonValue] | None
    journey_id: str | None
    page_id: str | None


def _record(value: object) -> Mapping[str, JsonValue] | None:
    return cast("Mapping[str, JsonValue]", value) if isinstance(value, Mapping) else None


def _pages(journey: Mapping[str, JsonValue]) -> list[str] | None:
    pages = journey.get("pages")
    if not isinstance(pages, list):
        return None
    ids: list[str] = []
    for page in pages:
        record = _record(page)
        page_id = record.get("id") if record is not None else None
        if not isinstance(page_id, str) or not page_id:
            return None
        ids.append(page_id)
    return ids


def _journeys(
    definition: Mapping[str, JsonValue],
) -> tuple[Mapping[str, JsonValue] | None, list[Mapping[str, JsonValue]]]:
    """Return the definition's journey block and its usable journeys (an id and pages with ids), read tolerantly."""
    block = _record(definition.get("journey"))
    listed = block.get("journeys") if block is not None else None
    if not isinstance(listed, list):
        return block, []
    usable: list[Mapping[str, JsonValue]] = []
    for item in listed:
        journey = _record(item)
        if journey is None:
            continue
        journey_id = journey.get("id")
        if isinstance(journey_id, str) and journey_id and _pages(journey) is not None:
            usable.append(journey)
    return block, usable


def choose_journey(
    definition: Mapping[str, JsonValue], named: JsonValue, check: JourneyCheck | None
) -> JourneyScope | Malformed | str:
    """Return the scope, a `Malformed` page check, or the refusal code (`journey.unknown`, `journey.required`)."""
    block, journeys = _journeys(definition)
    chosen: Mapping[str, JsonValue] | None
    if named is None:
        implied = _implied(block, journeys)
        if isinstance(implied, str):
            return implied
        chosen = implied
    else:
        chosen = next((j for j in journeys if isinstance(named, str) and j.get("id") == named), None)
        if chosen is None:
            return UNKNOWN
    journey_id = cast("str", chosen.get("id")) if chosen is not None else None
    if check is None or check.scope != "page":
        return JourneyScope(chosen, journey_id, None)
    if chosen is None:
        return Malformed("a page check names the journey its answers were given through")
    if check.page_id not in (_pages(chosen) or []):
        return Malformed("a page check names a page of its journey")
    return JourneyScope(chosen, journey_id, check.page_id)


def _implied(
    block: Mapping[str, JsonValue] | None, journeys: Sequence[Mapping[str, JsonValue]]
) -> Mapping[str, JsonValue] | str | None:
    if not journeys or (block is not None and block.get("opensAs") == "form"):
        return None
    if len(journeys) == 1:
        return journeys[0]
    default = block.get("defaultJourneyId") if block is not None else None
    found = next((j for j in journeys if isinstance(default, str) and default and j.get("id") == default), None)
    return found if found is not None else REQUIRED


def in_scope(item: JsonValue, scope: JourneyScope, outcome: Mapping[str, JsonValue]) -> bool:
    """Say whether a verdict's error belongs to the check.

    Every error does, except on a page check, where the program's `pageComponentIds` decide; an error on no
    component stays (`journey.exit` excepted: it is where Continue leads).
    """
    if scope.page_id is None:
        return True
    listed = outcome.get("pageComponentIds")
    if not isinstance(listed, list):
        return True  # the program named no scope: every error is shown, never fewer than were found
    record = _record(item) or {}
    component = record.get("componentId")
    if not isinstance(component, str):
        return record.get("code") != _EXIT
    return component in listed
