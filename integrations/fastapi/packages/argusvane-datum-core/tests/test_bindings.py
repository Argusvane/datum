"""Which binding each form route is drawn by and the PDF theme its PDF prints under.

`datum.bindings.*` names a default binding and per-route overrides; the catalog (the UI assets manifest's
`builtinBindings`, plus the entries the host adds) maps a binding to the PDF theme a PDF of that route carries as the
request's host theme and names in `X-Datum-Pdf-Theme`. Nothing is written into a layout, and a setting that cannot work
stops the start.
"""

import json
from pathlib import Path
from typing import Any

import pytest
from pdf_support import FORM, started_pdf

from datum_core import DatumConfig
from datum_core.bindings import DEFAULT_BINDING, DEFAULT_PDF_THEME, Binding, HostBindings, builtin_bindings
from datum_core.config.models import Bindings, RegisteredBinding
from datum_core.pdf.outcomes import Printed
from datum_sandbox.checks import DatumConfigurationError

BUILTIN = (Binding("datum", "Datum", "datum-pdf"),)
LEDGER: dict[str, Any] = {"id": "ledger", "version": "1.0.0", "target": "pdf", "label": "Ledger"}


def theme_file(tmp_path: Path, theme: dict[str, Any] | None = None, name: str = "ledger.json") -> str:
    path = tmp_path / name
    path.write_text(json.dumps(theme or LEDGER), encoding="utf-8")
    return str(path)


def ledger_config(tmp_path: Path, **more: Any) -> Bindings:
    fields: dict[str, Any] = {
        "default": "datum",
        "routes": {"benefits": "ledger-binding"},
        "catalog": {"ledger-binding": RegisteredBinding(label="Ledger", pdf_theme="ledger")},
        "pdf_themes": {"ledger": theme_file(tmp_path)},
    }
    fields.update(more)
    return Bindings(**fields)


# -- the table ---------------------------------------------------------------------------------------------------------
def test_a_host_that_configured_nothing_draws_every_route_with_datum_under_the_engines_pdf_theme() -> None:
    bindings = HostBindings.build(Bindings(), BUILTIN)
    assert bindings.default == DEFAULT_BINDING
    assert bindings.binding_of("contact") == "datum"
    assert bindings.pdf_theme_id("contact") == DEFAULT_PDF_THEME
    assert bindings.pdf_theme("contact") is None, "the engine's own look needs no theme object"


def test_two_routes_on_one_host_get_each_routes_catalog_pdf_theme(tmp_path: Path) -> None:
    bindings = HostBindings.build(ledger_config(tmp_path), BUILTIN)
    assert bindings.binding_of("benefits") == "ledger-binding"
    assert bindings.pdf_theme_id("benefits") == "ledger"
    assert bindings.pdf_theme("benefits") == LEDGER
    assert bindings.binding_of("contact") == "datum"
    assert bindings.pdf_theme_id("contact") == "datum-pdf"
    assert bindings.pdf_theme("contact") is None


def test_the_default_binding_is_what_a_route_without_an_override_is_drawn_by(tmp_path: Path) -> None:
    bindings = HostBindings.build(
        ledger_config(tmp_path, default="ledger-binding", routes={"contact": "datum"}), BUILTIN
    )
    assert bindings.pdf_theme_id("anything") == "ledger"
    assert bindings.pdf_theme_id(None) == "ledger"
    assert bindings.pdf_theme_id("contact") == "datum-pdf"


def test_a_binding_without_a_pdf_theme_suggests_none() -> None:
    bindings = HostBindings.build(Bindings(default="plain", catalog={"plain": RegisteredBinding()}), BUILTIN)
    assert bindings.pdf_theme_id("x") is None
    assert bindings.pdf_theme("x") is None
    assert {entry.id: entry.label for entry in bindings.catalog}["plain"] == "plain"


def test_host_json_describes_the_default_the_overrides_and_the_catalog(tmp_path: Path) -> None:
    described = HostBindings.build(ledger_config(tmp_path), BUILTIN).describe()
    assert described["default"] == "datum"
    assert described["routes"] == {"benefits": "ledger-binding"}
    assert {"id": "ledger-binding", "label": "Ledger", "pdfTheme": "ledger"} in described["catalog"]  # type: ignore[operator]
    assert {"id": "datum", "label": "Datum", "pdfTheme": "datum-pdf"} in described["catalog"]  # type: ignore[operator]


# -- what stops the start ----------------------------------------------------------------------------------------------
def test_a_binding_the_catalog_does_not_list_stops_the_start() -> None:
    with pytest.raises(DatumConfigurationError, match="'nope'"):
        HostBindings.build(Bindings(default="nope"), BUILTIN)
    with pytest.raises(DatumConfigurationError, match=r"datum\.bindings\.routes\.contact"):
        HostBindings.build(Bindings(routes={"contact": "nope"}), BUILTIN)


def test_a_suggested_pdf_theme_nobody_supplies_stops_the_start() -> None:
    config = Bindings(default="ledger-binding", catalog={"ledger-binding": RegisteredBinding(pdf_theme="ledger")})
    with pytest.raises(DatumConfigurationError, match="does not supply"):
        HostBindings.build(config, BUILTIN)


def test_a_supplied_pdf_theme_is_a_pdf_theme_under_its_own_id(tmp_path: Path) -> None:
    form_theme = theme_file(tmp_path, {**LEDGER, "target": "form"}, "form.json")
    with pytest.raises(DatumConfigurationError, match="not a PDF theme"):
        HostBindings.build(ledger_config(tmp_path, pdf_themes={"ledger": form_theme}), BUILTIN)
    other = theme_file(tmp_path, {**LEDGER, "id": "other"}, "other.json")
    with pytest.raises(DatumConfigurationError, match="one name"):
        HostBindings.build(ledger_config(tmp_path, pdf_themes={"ledger": other}), BUILTIN)
    with pytest.raises(DatumConfigurationError, match="cannot be read"):
        HostBindings.build(ledger_config(tmp_path, pdf_themes={"ledger": str(tmp_path / "missing.json")}), BUILTIN)


def test_a_route_is_any_form_key_the_store_accepts(tmp_path: Path) -> None:
    long_key = "k" * 128
    bindings = HostBindings.build(
        ledger_config(tmp_path, routes={"_intake": "ledger-binding", long_key: "datum"}), BUILTIN
    )
    assert bindings.binding_of("_intake") == "ledger-binding"
    assert bindings.binding_of(long_key) == "datum"
    for key in ("k" * 129, "a@1", ""):
        with pytest.raises(DatumConfigurationError, match="is not a form key"):
            HostBindings.build(Bindings(routes={key: "datum"}), BUILTIN)


def test_a_route_and_an_id_are_names_not_paths() -> None:
    with pytest.raises(DatumConfigurationError):
        HostBindings.build(Bindings(routes={"../x": "datum"}), BUILTIN)
    with pytest.raises(DatumConfigurationError):
        HostBindings.build(Bindings(catalog={"a b": RegisteredBinding()}), BUILTIN)


def test_the_bundles_manifest_lists_the_datum_binding_alone_with_the_engines_pdf_theme() -> None:
    # The element draws `datum` with no registration and nothing else: dark is its `scheme` attribute, not a binding,
    # so a catalog entry for `datum-dark` would let a host name a binding no page can draw.
    listed = {entry.id: entry.pdf_theme for entry in builtin_bindings()}
    assert listed == {"datum": "datum-pdf"}


def test_datum_dark_is_no_binding_and_stops_the_start() -> None:
    with pytest.raises(DatumConfigurationError, match="'datum-dark'"):
        HostBindings.build(Bindings(default="datum-dark"))


def test_a_missing_manifest_still_has_the_datum_binding() -> None:
    assert builtin_bindings("no_such_package_installed") == (Binding("datum", "Datum", "datum-pdf"),)


def test_the_settings_tree_carries_the_section() -> None:
    assert DatumConfig().bindings.default == "datum"
    config = DatumConfig(bindings=Bindings(routes={"a": "datum"}))
    assert config.bindings.routes == {"a": "datum"}


# -- what the PDF service does with it ---------------------------------------------------------------------------------
def settings(tmp_path: Path, **bindings: Any) -> dict[str, Any]:
    fields: dict[str, Any] = {
        "routes": {FORM: "ledger-binding"},
        "catalog": {"ledger-binding": {"label": "Ledger", "pdf_theme": "ledger"}},
        "pdf_themes": {"ledger": theme_file(tmp_path)},
    }
    fields.update(bindings)
    return {"bindings": fields, "pdf": {"seal": {"enabled": False}}}


def sent_requests(rig: Any) -> list[dict[str, Any]]:
    return [call.request for call in rig.runtime.calls if call.op in {"document", "fill"}]


def test_a_forms_pdf_carries_its_bindings_pdf_theme_as_the_host_theme_and_names_it(tmp_path: Path) -> None:
    with started_pdf(settings(tmp_path)) as rig:
        printed = rig.render()
        request = sent_requests(rig)[0]
    assert isinstance(printed, Printed)
    assert request["theme"] == LEDGER
    assert printed.pdf_theme == "ledger"
    assert "theme" not in (request.get("pdf") or {}), "nothing is written into the layout"


def test_a_route_on_the_default_binding_prints_under_the_engines_own_theme_and_sends_no_theme(tmp_path: Path) -> None:
    with started_pdf(settings(tmp_path, routes={})) as rig:
        printed = rig.render()
        request = sent_requests(rig)[0]
    assert "theme" not in request
    assert printed.pdf_theme == "datum-pdf"


def test_the_start_is_refused_for_a_binding_the_catalog_does_not_list(tmp_path: Path) -> None:
    with pytest.raises(DatumConfigurationError, match="'nope'"), started_pdf(settings(tmp_path, default="nope")):
        pass
