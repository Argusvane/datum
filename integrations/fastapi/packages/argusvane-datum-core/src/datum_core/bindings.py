"""Which design-system binding each form route is drawn by, and the PDF theme a PDF of it prints under.

A server host knows a form's binding from its own configuration (`datum.bindings.*`), one binding for the
host or one per form route, never from a field of the definition. The catalog (the UI assets manifest's
`builtinBindings`, plus the entries the host adds for a binding it registers on its pages) maps a binding id to the PDF
theme a PDF of that route prints under. That theme is the host rung of the engine's PDF ladder: it rides in the
request's `theme` below the render call's and the layout's own, and nothing is written into a layout.

`datum-pdf` is the engine's own look, so no theme object is sent for it; any other suggested id needs its object, which
the host supplies as a file (`datum.bindings.pdf_themes`). A setting that cannot work (a binding the catalog does not
list, a PDF theme nobody supplies, a theme that is not a PDF theme) is a `DatumConfigurationError` at start, never a
PDF printed under the wrong look.
"""

import json
import re
from collections.abc import Mapping
from dataclasses import dataclass
from importlib import resources
from pathlib import Path
from typing import Final, cast

from datum_core.config.models import Bindings
from datum_core.stores.keys import parse_form_key
from datum_sandbox.checks import DatumConfigurationError
from datum_sandbox.json import JsonValue

__all__ = ["DEFAULT_BINDING", "DEFAULT_PDF_THEME", "Binding", "HostBindings", "builtin_bindings"]

DEFAULT_BINDING: Final = "datum"
"""The binding of a host that names none: the Datum binding."""
DEFAULT_PDF_THEME: Final = "datum-pdf"
"""The engine's own PDF theme: what a request prints under with no theme object, so none is sent."""

_ID: Final = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
_UI_ASSETS: Final = "datum_assets_ui"
_MANIFEST: Final = "manifest.json"


@dataclass(frozen=True, slots=True)
class Binding:
    """A catalog entry: the binding's id, its label and the PDF theme it suggests (None: none)."""

    id: str
    label: str
    pdf_theme: str | None = None


def builtin_bindings(package: str = _UI_ASSETS) -> tuple[Binding, ...]:
    """Return `builtinBindings` of the installed UI assets manifest; the Datum binding alone when it cannot be read.

    A host without the UI assets (a PDF-only deployment) still draws its routes with the Datum binding.
    """
    try:
        document: object = json.loads(resources.files(package).joinpath(_MANIFEST).read_text(encoding="utf-8"))
    except (ImportError, TypeError, OSError, ValueError):
        return (Binding(DEFAULT_BINDING, "Datum", DEFAULT_PDF_THEME),)
    listed = cast("dict[str, object]", document).get("builtinBindings") if isinstance(document, dict) else None
    found: list[Binding] = []
    for entry in cast("list[object]", listed) if isinstance(listed, list) else []:
        if not isinstance(entry, dict):
            continue
        item = cast("dict[str, object]", entry)
        ident, label, theme = item.get("id"), item.get("label"), item.get("pdfTheme")
        if isinstance(ident, str):
            found.append(
                Binding(ident, label if isinstance(label, str) else ident, theme if isinstance(theme, str) else None)
            )
    return tuple(found) or (Binding(DEFAULT_BINDING, "Datum", DEFAULT_PDF_THEME),)


class HostBindings:
    """The host's binding table: the default, the per-route overrides, the catalog and the PDF theme objects."""

    __slots__ = ("_catalog", "_default", "_routes", "_themes")

    def __init__(
        self,
        catalog: Mapping[str, Binding],
        default: str,
        routes: Mapping[str, str],
        themes: Mapping[str, Mapping[str, JsonValue]],
    ) -> None:
        """Keep a table `build` has validated."""
        self._catalog = dict(catalog)
        self._default = default
        self._routes = dict(routes)
        self._themes = dict(themes)

    @classmethod
    def build(cls, config: Bindings, builtin: tuple[Binding, ...] | None = None) -> "HostBindings":
        """Validate `config` against the catalog and read its PDF theme files; raise `DatumConfigurationError`."""
        catalog: dict[str, Binding] = {
            entry.id: entry for entry in (builtin if builtin is not None else builtin_bindings())
        }
        if not catalog:
            catalog[DEFAULT_BINDING] = Binding(DEFAULT_BINDING, "Datum", DEFAULT_PDF_THEME)
        for ident, registered in config.catalog.items():
            if not _ID.fullmatch(ident):
                raise DatumConfigurationError(
                    f"datum.bindings.catalog: {ident!r} is not a binding id",
                    hint="use letters, digits, '.', '_' and '-'",
                )
            if registered.pdf_theme is not None and not _ID.fullmatch(registered.pdf_theme):
                raise DatumConfigurationError(f"datum.bindings.catalog.{ident}.pdf_theme is not a PDF theme id")
            catalog[ident] = Binding(ident, registered.label or ident, registered.pdf_theme)
        themes: dict[str, Mapping[str, JsonValue]] = {}
        for ident, location in config.pdf_themes.items():
            themes[ident] = _read_theme(ident, location)
        default = config.default
        _require_listed(catalog, default, "datum.bindings.default")
        for key, ident in config.routes.items():
            if not _is_route_key(key):
                raise DatumConfigurationError(
                    f"datum.bindings.routes: {key!r} is not a form key", hint="name the route by its form key"
                )
            _require_listed(catalog, ident, f"datum.bindings.routes.{key}")
        for ident in (default, *config.routes.values()):
            theme = catalog[ident].pdf_theme
            if theme is not None and theme != DEFAULT_PDF_THEME and theme not in themes:
                raise DatumConfigurationError(
                    f"the binding {ident!r} suggests the PDF theme {theme!r}, which this host does not supply",
                    hint=f"add the theme object under datum.bindings.pdf_themes.{theme}, or name another theme",
                )
        return cls(catalog, default, config.routes, themes)

    @property
    def default(self) -> str:
        """The binding id a route with no override is drawn by."""
        return self._default

    @property
    def routes(self) -> Mapping[str, str]:
        """The per-route overrides: form key to binding id."""
        return dict(self._routes)

    @property
    def catalog(self) -> tuple[Binding, ...]:
        """Every binding the host knows, built in or registered, by id."""
        return tuple(sorted(self._catalog.values(), key=lambda entry: entry.id))

    def binding_of(self, form_key: str | None) -> str:
        """Return the binding id a form is drawn by."""
        return self._default if form_key is None else self._routes.get(form_key, self._default)

    def pdf_theme_id(self, form_key: str | None) -> str | None:
        """Return the id of the PDF theme the form's binding suggests, or None when it suggests none."""
        return self._catalog[self.binding_of(form_key)].pdf_theme

    def pdf_theme(self, form_key: str | None) -> Mapping[str, JsonValue] | None:
        """Return the theme object a PDF of the form carries as the request's `theme`, or None.

        None when the binding suggests no PDF theme, or the engine's own (`datum-pdf`), which needs none.
        """
        ident = self.pdf_theme_id(form_key)
        return None if ident is None or ident == DEFAULT_PDF_THEME else self._themes.get(ident)

    def describe(self) -> dict[str, JsonValue]:
        """Return `host.json`'s `bindings`: the default, the overrides and the catalog with each PDF theme."""
        entries: list[JsonValue] = []
        for entry in self.catalog:
            item: dict[str, JsonValue] = {"id": entry.id, "label": entry.label}
            if entry.pdf_theme is not None:
                item["pdfTheme"] = entry.pdf_theme
            entries.append(item)
        routes: dict[str, JsonValue] = dict(sorted(self._routes.items()))
        return {"default": self._default, "routes": routes, "catalog": entries}


def _is_route_key(key: str) -> bool:
    """Whether `key` names a route: a form key without a version (the store's rule), as `binding_of` is asked it."""
    parsed = parse_form_key(key)
    return parsed is not None and parsed[1] is None


def _require_listed(catalog: Mapping[str, Binding], ident: str, setting: str) -> None:
    if ident not in catalog:
        raise DatumConfigurationError(
            f"{setting}: the binding {ident!r} is not in the host's catalog",
            hint=f"use one of {', '.join(sorted(catalog))}, or add it under datum.bindings.catalog",
        )


def _read_theme(ident: str, location: str) -> Mapping[str, JsonValue]:
    setting = f"datum.bindings.pdf_themes.{ident}"
    try:
        document: object = json.loads(Path(location).read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise DatumConfigurationError(
            f"{setting}: the PDF theme file cannot be read as JSON ({type(error).__name__})"
        ) from error
    if not isinstance(document, dict):
        raise DatumConfigurationError(f"{setting}: the PDF theme is a JSON object")
    theme = cast("dict[str, JsonValue]", document)
    if theme.get("id") != ident:
        raise DatumConfigurationError(f"{setting}: the theme object has another id; the two are one name")
    if theme.get("target") != "pdf":
        raise DatumConfigurationError(
            f"{setting}: the theme is not a PDF theme (its target is not 'pdf'); a form look is never printed from"
        )
    return theme
