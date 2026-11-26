"""The wire models this binding writes itself (camelCase through `DatumWireModel`)."""

from starlette.responses import Response

from datum_core.http import DatumWireModel
from datum_sandbox.json import JsonValue

__all__ = ["ItemsBody", "items_response"]

_JSON = "application/json"


class ItemsBody(DatumWireModel):
    """The answer of a data source: `{"items": [{"value": ..., "label": ...}, ...]}`."""

    items: list[dict[str, JsonValue]]


def items_response(items: list[dict[str, JsonValue]]) -> Response:
    """Write a data source's items as the documented body."""
    return Response(ItemsBody(items=items).model_dump_json(), media_type=_JSON)
