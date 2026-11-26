"""The form key rule, re-exported from `datum_core.stores.keys` (where the stores that hold forms can reach it)."""

from datum_core.stores.keys import MAX_KEY_LENGTH, is_form_key, parse_form_key, version_matches

__all__ = ["MAX_KEY_LENGTH", "is_form_key", "parse_form_key", "version_matches"]
