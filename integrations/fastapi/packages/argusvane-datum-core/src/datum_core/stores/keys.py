"""The form key rule: one to 128 letters, digits, dots, hyphens or underscores; `id@version` names one version.

Lives beside the stores that hold forms; `datum_core.forms.keys` re-exports it. One module-level function every
route and service asks. The rule is the URL segment's and the snapshot table's `form_key VARCHAR(128)`.
"""

import re
from typing import Final

__all__ = ["MAX_KEY_LENGTH", "is_form_key", "parse_form_key", "version_matches"]

MAX_KEY_LENGTH: Final = 128
_PART: Final = re.compile(r"[A-Za-z0-9._-]{1,128}")


def parse_form_key(raw: object) -> tuple[str, str | None] | None:
    """Split a key into `(id, version)` (`version` None for a plain id), or None when it is no form key."""
    if not isinstance(raw, str):
        return None
    form_id, at, version = raw.partition("@")
    if _PART.fullmatch(form_id) is None:
        return None
    if not at:
        return form_id, None
    if _PART.fullmatch(version) is None:
        return None
    return form_id, version


def is_form_key(raw: object) -> bool:
    """Whether `raw` is a form key: a plain id, or `id@version` as the catalog spells it."""
    return parse_form_key(raw) is not None


def version_matches(definition: object, version: str | None) -> bool:
    """Whether a definition is the version a key names: none asked matches; a string or integer version by spelling."""
    if version is None:
        return True
    held = definition.get("version") if isinstance(definition, dict) else None  # pyright: ignore[reportUnknownMemberType, reportUnknownVariableType]
    return isinstance(held, str | int) and not isinstance(held, bool) and str(held) == version
