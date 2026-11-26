"""The component types the kernel's `check` is given: `knownComponentTypes` of the UI assets manifest.

The asset script writes `manifest.json` into the `datum_assets_ui` distribution (the same file the asset catalog reads
its build from); the builder reads only its type list. An unknown type in a definition is then the kernel's warning
`component.type.unknown`, never a refusal.
"""

import json
from importlib import resources
from typing import Final, cast

from datum_sandbox.checks import DatumConfigurationError

__all__ = ["UI_ASSETS_PACKAGE", "known_component_types"]

UI_ASSETS_PACKAGE: Final = "datum_assets_ui"
_MANIFEST: Final = "manifest.json"
_MEMBER: Final = "knownComponentTypes"


def known_component_types(package: str = UI_ASSETS_PACKAGE) -> tuple[str, ...]:
    """Return `knownComponentTypes` of the installed UI assets manifest, in its own order.

    Raises `DatumConfigurationError` when the distribution, its manifest or the list cannot be read: a builder that
    cannot name the component types would check every definition against none.
    """
    try:
        text = resources.files(package).joinpath(_MANIFEST).read_text(encoding="utf-8")
        document: object = json.loads(text)
    except (ImportError, TypeError, OSError, ValueError) as error:
        raise DatumConfigurationError(
            f"the component types cannot be read from {package}/{_MANIFEST} ({type(error).__name__})",
            hint=(
                "install argusvane-datum-assets-ui at the version of argusvane-datum-core; "
                "the asset script writes the manifest"
            ),
        ) from error
    listed = cast("dict[str, object]", document).get(_MEMBER) if isinstance(document, dict) else None
    if not isinstance(listed, list) or not all(isinstance(item, str) for item in cast("list[object]", listed)):
        raise DatumConfigurationError(
            f"{package}/{_MANIFEST} holds no {_MEMBER} list of strings",
            hint="reinstall argusvane-datum-assets-ui; the asset script writes the manifest",
        )
    return tuple(cast("list[str]", listed))
