"""The translation catalog's rules (`TranslationCatalog`).

A catalog is `locale -> kind -> owner -> tree`: six fixed kinds (`form`, `components`, `chrome`, `journeys`, `pdf`,
`texts`), the owner an id one level below the kind (`form` has none: its tree sits directly under the kind), and a
tree of property segments down to string leaves (a host holds no fingerprints). `read_catalog` judges a strict-JSON
value against the floors (10,000 leaves, 64 locales, 16 KiB of UTF-8 a leaf, 190 characters a segment, 12 levels under a
kind, no segment the engine's `isSafeSegment` refuses) and answers the normalised catalog (keys sorted, blank leaves
and the branches they empty dropped) or the problems, each `catalog.invalid` in fixed words, its `field` the JSON
Pointer of the offence. No text and no key is quoted in a message.

`move_locales` applies a save's `LocaleChanges` to the top-level keys: every removed code goes, then every renamed
pair's tree moves from `from` to `to`, all sources read before any is written (two codes can swap); a move onto a
locale the catalog keeps merges, the moved leaves winning.

Libraries: `json` and the standard library hold the walk and `copy.deepcopy` the copy;
`jsonschema` or pydantic would carry a dependency for a five-rule tree walk whose messages must stay fixed words.
"""

import copy
from collections.abc import Mapping
from typing import Final, cast

from datum_core.builder.changes import MAX_LOCALES, LocaleChanges, is_locale_code
from datum_core.hooks import HookProblem
from datum_core.stores import Catalog, CatalogTree, CatalogView, CatalogViewNode

__all__ = [
    "CATALOG_INVALID",
    "CATALOG_KINDS",
    "MAX_CATALOG_DEPTH",
    "MAX_CATALOG_ENTRIES",
    "MAX_CATALOG_KEY_LENGTH",
    "MAX_CATALOG_TEXT_BYTES",
    "copy_catalog",
    "move_locales",
    "read_catalog",
]

CATALOG_INVALID: Final = "catalog.invalid"
CATALOG_KINDS: Final = ("form", "components", "chrome", "journeys", "pdf", "texts")
"""The six kinds, in the engine's order; `form` holds a tree, the others an owner id to a tree (`texts` owns the
engine's `form` and `messages` tables)."""
MAX_CATALOG_ENTRIES: Final = 10_000
"""The most leaves (texts) a catalog holds."""
MAX_CATALOG_KEY_LENGTH: Final = 190
"""The longest segment, in characters."""
MAX_CATALOG_TEXT_BYTES: Final = 16 * 1024
"""The longest text, in UTF-8 bytes."""
MAX_CATALOG_DEPTH: Final = 12
"""The most levels of keys under a kind (the owner counts as one)."""
_MAX_PROBLEMS: Final = 200
_UNSAFE_SEGMENTS: Final = frozenset({"__proto__", "constructor", "prototype"})


def _pointer(*segments: str) -> str:
    return "".join("/" + segment.replace("~", "~0").replace("/", "~1") for segment in segments)


def copy_catalog(catalog: CatalogView) -> Catalog:
    """Copy a catalog so nobody shares it with the store."""
    return cast("Catalog", copy.deepcopy(catalog))


class _Reading:
    """The walk's state: the problems found and the leaves counted."""

    def __init__(self) -> None:
        self.problems: list[HookProblem] = []
        self.leaves = 0

    @property
    def full(self) -> bool:
        return len(self.problems) >= _MAX_PROBLEMS

    def refuse(self, path: str, message: str) -> None:
        if not self.full:
            self.problems.append(HookProblem(path or None, CATALOG_INVALID, message))


def _segment_problem(segment: str) -> str | None:
    if not segment or segment in _UNSAFE_SEGMENTS:
        return "A key is a name the catalog may hold."
    if len(segment) > MAX_CATALOG_KEY_LENGTH:
        return f"A key is at most {MAX_CATALOG_KEY_LENGTH} characters."
    return None


def _read_tree(value: object, path: tuple[str, ...], depth: int, reading: _Reading) -> CatalogTree:
    """Walk one tree, noting problems; answer the normalised tree (blank leaves and empty branches dropped)."""
    if not isinstance(value, dict):
        reading.refuse(_pointer(*path), "A branch of the catalog is an object of keys.")
        return {}
    if depth > MAX_CATALOG_DEPTH:
        reading.refuse(_pointer(*path), f"A catalog nests at most {MAX_CATALOG_DEPTH} levels under a kind.")
        return {}
    branch = cast("dict[str, object]", value)
    kept: CatalogTree = {}
    for segment, child in sorted(branch.items()):
        if reading.full:
            break
        fault = _segment_problem(segment)
        if fault is not None:
            reading.refuse(_pointer(*path, segment), fault)
            continue
        if isinstance(child, dict):
            tree = _read_tree(child, (*path, segment), depth + 1, reading)
            if tree:
                kept[segment] = tree
        elif isinstance(child, str):
            reading.leaves += 1
            if len(child.encode("utf-8")) > MAX_CATALOG_TEXT_BYTES:
                reading.refuse(
                    _pointer(*path, segment), f"A translation is at most {MAX_CATALOG_TEXT_BYTES} bytes of UTF-8 text."
                )
            elif child.strip():
                kept[segment] = child
        else:
            reading.refuse(_pointer(*path, segment), "A translation is text.")
    return kept


def _read_kind(kind: str, value: object, locale: str, reading: _Reading) -> CatalogTree:
    if kind == "form":
        return _read_tree(value, (locale, kind), 1, reading)
    if not isinstance(value, dict):
        reading.refuse(_pointer(locale, kind), "A kind holds an object of owner ids.")
        return {}
    owners: CatalogTree = {}
    for owner, tree in sorted(cast("dict[str, object]", value).items()):
        if reading.full:
            break
        fault = _segment_problem(owner)
        if fault is not None:
            reading.refuse(_pointer(locale, kind, owner), fault)
            continue
        if not isinstance(tree, dict):
            reading.refuse(_pointer(locale, kind, owner), "An owner holds an object of property keys.")
            continue
        read = _read_tree(tree, (locale, kind, owner), 2, reading)
        if read:
            owners[owner] = read
    return owners


def read_catalog(value: object) -> Catalog | tuple[HookProblem, ...]:
    """Answer the normalised catalog, or the problems that refuse it (at most 200, each `catalog.invalid`).

    `value` is strict JSON (`read_tree` found no fault), so every key is text.
    """
    if not isinstance(value, dict):
        return (HookProblem(None, CATALOG_INVALID, "A catalog is an object of locale codes."),)
    locales = cast("dict[str, object]", value)
    if len(locales) > MAX_LOCALES:
        return (HookProblem(None, CATALOG_INVALID, f"A catalog holds at most {MAX_LOCALES} locales."),)
    reading = _Reading()
    normalised: Catalog = {}
    for locale, by_kind in sorted(locales.items()):
        if reading.full:
            break
        if not is_locale_code(locale):
            reading.refuse(_pointer(locale), "A top-level key is not a locale code (a language and optional subtags).")
            continue
        if not isinstance(by_kind, dict):
            reading.refuse(_pointer(locale), "A locale holds an object of kinds.")
            continue
        kept: dict[str, CatalogTree] = {}
        for kind, content in sorted(cast("dict[str, object]", by_kind).items()):
            if kind not in CATALOG_KINDS:
                reading.refuse(_pointer(locale, kind), "A kind is form, components, chrome, journeys, pdf or texts.")
                continue
            read = _read_kind(kind, content, locale, reading)
            if read:
                kept[kind] = read
        if kept:
            normalised[locale] = kept
    if reading.leaves > MAX_CATALOG_ENTRIES:
        return (HookProblem(None, CATALOG_INVALID, f"A catalog holds at most {MAX_CATALOG_ENTRIES} texts."),)
    if reading.problems:
        return tuple(reading.problems)
    return normalised


def _merge(base: CatalogViewNode, over: CatalogViewNode) -> CatalogTree:
    """Return `base` with `over` laid on it, leaf by leaf (`over` wins); neither is changed."""
    merged = cast("CatalogTree", copy.deepcopy(base))
    for segment, child in over.items():
        held = merged.get(segment)
        if isinstance(child, Mapping) and isinstance(held, dict):
            merged[segment] = _merge(held, child)
        else:
            merged[segment] = cast("str | CatalogTree", copy.deepcopy(child))
    return merged


def move_locales(catalog: CatalogView, changes: LocaleChanges) -> Catalog:
    """Apply the language changes to a catalog and answer the new one (the given catalog is not changed)."""
    gone = set(changes.removed) | {old for old, _ in changes.renamed}
    moved: Catalog = {
        locale: cast("dict[str, CatalogTree]", copy.deepcopy(by_kind))
        for locale, by_kind in catalog.items()
        if locale not in gone
    }
    for old, new in changes.renamed:
        if old not in catalog or not catalog[old]:
            continue
        moved[new] = cast("dict[str, CatalogTree]", _merge(moved.get(new, {}), catalog[old]))
    return moved
