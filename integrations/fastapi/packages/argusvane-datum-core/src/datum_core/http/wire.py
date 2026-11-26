"""Wire models and the OpenAPI request-body helper.

Libraries: `pydantic.alias_generators.to_camel` is the alias generator and pydantic's own config
(`validate_by_name`, `validate_by_alias`, `serialize_by_alias`) is the whole base, so `DatumWireModel` is a configured
subclass, not a new mechanism. `fastapi.openapi.utils` and `pydantic.json_schema` can generate a schema but neither
inlines `$defs` (raw nested `model_json_schema()` breaks Swagger UI), and this layer imports no framework, so the
inliner is written here.
"""

from copy import deepcopy
from typing import Any, Final

from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel

_DEFS_PREFIX: Final = "#/$defs/"


class DatumWireModel(BaseModel):
    """Base of every host-owned wire model: camelCase on the wire, Python names accepted on input."""

    model_config = ConfigDict(
        alias_generator=to_camel, validate_by_name=True, validate_by_alias=True, serialize_by_alias=True
    )


class HostCsrf(DatumWireModel):
    """The names `host.json` publishes for token-based applications; Datum ships no CSRF middleware."""

    model_config = ConfigDict(frozen=True)

    header_name: str
    cookie_name: str
    meta_name: str


class HostBindingEntry(DatumWireModel):
    """A catalog entry of `host.json`'s `bindings`: the binding and the PDF theme it suggests, when it suggests one."""

    model_config = ConfigDict(frozen=True)

    id: str
    label: str
    pdf_theme: str | None = None


class HostBindingsTable(DatumWireModel):
    """`host.json`'s `bindings`: the binding a route with no override is drawn by, the overrides, the catalog."""

    model_config = ConfigDict(frozen=True)

    default: str
    routes: dict[str, str]
    catalog: list[HostBindingEntry]


class HostJson(DatumWireModel):
    """`host.json`: `{buildId, assetsBase, apiBase, csrf{...}, bindings{default, routes, catalog}, paths?}`.

    `paths` names the endpoint bases of the capabilities whose routers registered one (`tsa`, `webauthn`), with the
    root path; the page glue reads `paths.webauthn` for the passkey endpoints. It is left out when none registered.
    """

    model_config = ConfigDict(frozen=True)

    build_id: str
    assets_base: str
    api_base: str
    csrf: HostCsrf
    bindings: HostBindingsTable | None = None
    paths: dict[str, str] | None = None


def _inline(node: Any, defs: dict[str, Any], resolving: tuple[str, ...]) -> Any:  # noqa: ANN401 -- a JSON schema node
    if isinstance(node, list):
        return [_inline(item, defs, resolving) for item in node]
    if not isinstance(node, dict):
        return node
    reference = node.get("$ref")
    if reference is None:
        return {key: _inline(value, defs, resolving) for key, value in node.items() if key != "$defs"}
    if not isinstance(reference, str) or not reference.startswith(_DEFS_PREFIX):
        raise ValueError(f"cannot inline the reference {reference!r}: only {_DEFS_PREFIX}<name> is supported")
    name = reference.removeprefix(_DEFS_PREFIX)
    if name in resolving:
        raise ValueError(f"cannot inline a recursive schema ({' -> '.join((*resolving, name))})")
    if name not in defs:
        raise ValueError(f"cannot inline {reference!r}: no such definition")
    siblings = {key: value for key, value in node.items() if key not in {"$ref", "$defs"}}
    return {**_inline(defs[name], defs, (*resolving, name)), **_inline(siblings, defs, resolving)}


def openapi_extra(schema: dict[str, Any], *, media_type: str = "application/json") -> dict[str, Any]:
    """Return FastAPI's `openapi_extra` for a raw body: a required `requestBody` with `schema` and no `$defs` or `$ref`.

    `ValueError` for a recursive schema (it cannot be inlined) or a reference outside `#/$defs/`. The input is not
    modified.
    """
    defs = deepcopy(schema.get("$defs", {}))
    inlined = _inline(deepcopy(schema), defs, ())
    return {"requestBody": {"required": True, "content": {media_type: {"schema": inlined}}}}
