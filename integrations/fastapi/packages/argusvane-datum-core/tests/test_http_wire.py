"""The wire model base, the `openapi_extra` helper that inlines `$defs`, and the host.json model."""

import json
from typing import Any

import pytest
from pydantic import BaseModel, Field

from datum_core.http import DatumWireModel, HostBindingEntry, HostBindingsTable, HostCsrf, HostJson, openapi_extra


class Address(DatumWireModel):
    street_name: str
    postal_code: str | None = None


class Person(DatumWireModel):
    full_name: str
    home_address: Address
    other_addresses: list[Address] = Field(default_factory=list)


def refs(node: Any) -> list[str]:
    found: list[str] = []
    if isinstance(node, dict):
        for key, value in node.items():
            if key == "$ref":
                found.append(str(value))
            else:
                found.extend(refs(value))
    elif isinstance(node, list):
        for item in node:
            found.extend(refs(item))
    return found


def test_the_wire_model_reads_and_writes_camel_case_and_still_accepts_python_names() -> None:
    person = Person.model_validate({"fullName": "A B", "homeAddress": {"streetName": "Main", "postalCode": "X1"}})
    assert person.home_address.street_name == "Main"
    assert Person(full_name="A B", home_address=Address(street_name="Main")).full_name == "A B"
    dumped = json.loads(person.model_dump_json(by_alias=True))
    assert set(dumped) == {"fullName", "homeAddress", "otherAddresses"}
    assert json.loads(person.model_dump_json())["fullName"] == "A B"  # serialize_by_alias is the default


def test_the_wire_model_is_a_pydantic_model_and_keeps_its_config() -> None:
    assert issubclass(DatumWireModel, BaseModel)
    assert DatumWireModel.model_config.get("serialize_by_alias") is True
    assert DatumWireModel.model_config.get("validate_by_name") is True
    assert DatumWireModel.model_config.get("validate_by_alias") is True


def test_openapi_extra_inlines_every_defs_entry_and_leaves_no_ref_behind() -> None:
    schema = Person.model_json_schema(by_alias=True)
    assert "$defs" in schema  # the raw schema is what breaks Swagger UI
    extra = openapi_extra(schema)
    content = extra["requestBody"]["content"]["application/json"]["schema"]
    assert "$defs" not in json.dumps(extra)
    assert refs(extra) == []
    assert content["properties"]["homeAddress"]["properties"]["streetName"]["type"] == "string"
    assert content["properties"]["otherAddresses"]["items"]["properties"]["postalCode"]


def test_openapi_extra_marks_the_body_required_and_accepts_another_media_type() -> None:
    assert openapi_extra({"type": "object"})["requestBody"]["required"] is True
    extra = openapi_extra({"type": "string", "format": "binary"}, media_type="application/pdf")
    assert extra["requestBody"]["content"]["application/pdf"]["schema"] == {"type": "string", "format": "binary"}


def test_openapi_extra_refuses_a_recursive_schema_it_cannot_inline() -> None:
    schema = {
        "$ref": "#/$defs/Node",
        "$defs": {"Node": {"type": "object", "properties": {"next": {"$ref": "#/$defs/Node"}}}},
    }
    with pytest.raises(ValueError, match="recursive"):
        openapi_extra(schema)


def test_host_json_is_the_documented_members_in_camel_case() -> None:
    model = HostJson(
        build_id="abc123",
        assets_base="/datum/assets/abc123",
        api_base="/api",
        csrf=HostCsrf(header_name="X-XSRF-TOKEN", cookie_name="XSRF-TOKEN", meta_name="_csrf"),
    )
    assert json.loads(model.model_dump_json(exclude_none=True)) == {
        "buildId": "abc123",
        "assetsBase": "/datum/assets/abc123",
        "apiBase": "/api",
        "csrf": {"headerName": "X-XSRF-TOKEN", "cookieName": "XSRF-TOKEN", "metaName": "_csrf"},
    }


def test_host_json_carries_the_bindings_table_of_the_hosts_routes() -> None:
    model = HostJson(
        build_id="abc123",
        assets_base="/datum/assets/abc123",
        api_base="/api",
        csrf=HostCsrf(header_name="X-XSRF-TOKEN", cookie_name="XSRF-TOKEN", meta_name="_csrf"),
        bindings=HostBindingsTable(
            default="datum",
            routes={"benefits": "gcds"},
            catalog=[
                HostBindingEntry(id="datum", label="Datum", pdf_theme="datum-pdf"),
                HostBindingEntry(id="plain", label="Plain"),
            ],
        ),
    )
    assert json.loads(model.model_dump_json(exclude_none=True))["bindings"] == {
        "default": "datum",
        "routes": {"benefits": "gcds"},
        "catalog": [{"id": "datum", "label": "Datum", "pdfTheme": "datum-pdf"}, {"id": "plain", "label": "Plain"}],
    }


def test_host_json_names_the_endpoint_bases_in_paths_and_leaves_paths_out_when_none_registered() -> None:
    csrf = HostCsrf(header_name="X-XSRF-TOKEN", cookie_name="XSRF-TOKEN", meta_name="_csrf")
    named = HostJson(
        build_id="abc123",
        assets_base="/datum/assets/abc123",
        api_base="/api",
        csrf=csrf,
        paths={"tsa": "/tsa", "webauthn": "/api/webauthn"},
    )
    assert json.loads(named.model_dump_json(exclude_none=True))["paths"] == {"tsa": "/tsa", "webauthn": "/api/webauthn"}
    plain = HostJson(build_id="abc123", assets_base="/datum/assets/abc123", api_base="/api", csrf=csrf)
    assert "paths" not in json.loads(plain.model_dump_json(exclude_none=True))
