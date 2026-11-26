"""`FileFormDefinitionRepository`: the read-only repository over `datum.forms.locations`.

Built on: `glob.glob` walks the filesystem only (no `importlib.resources` traversables, which have no `glob`),
`glob.translate` is 3.13+ (the floor is 3.12), `pathlib.Path.glob` and `Traversable` share no glob; so the walk is
Datum's, over the `iterdir` / `is_file` / `is_dir` surface both provide, with `fnmatch` for one path segment. Files are
read with the strict bounded JSON reader and hashed with the canonical writer, both in this package.
"""

import fnmatch
import importlib.resources
import logging
import re
from collections.abc import Iterator, Sequence
from importlib.resources.abc import Traversable
from pathlib import Path, PurePath
from typing import Final

from datum_core.canonical import canonical_digest
from datum_core.forms.keys import is_form_key
from datum_core.forms.protocols import StoredDefinition
from datum_core.loggers import FORMS
from datum_sandbox.checks import DatumConfigurationError
from datum_sandbox.json import BadDocumentError, JsonValue, read
from datum_sandbox.protocol import MAX_DEFINITION_DEPTH

__all__ = ["FileFormDefinitionRepository"]

logger = logging.getLogger(FORMS)

_GLOB_CHARACTERS: Final = re.compile(r"[*?\[]")
_PACKAGE_PREFIX: Final = "package:"
_MAX_WALK_DEPTH: Final = 64
"""Directories are walked at most this deep: a symlink loop under `**` ends instead of recursing for ever."""
_HINT: Final = "fix or remove the file, or change datum.forms.locations"


class _Walk:
    """One location's files, in order, and whether a directory could not be read."""

    def __init__(self) -> None:
        self.files: dict[tuple[str, ...], Traversable] = {}
        self.unreadable = False


def _children(directory: Traversable, walk: _Walk) -> list[Traversable]:
    try:
        return sorted(directory.iterdir(), key=lambda node: node.name)
    except OSError:
        logger.warning('The Datum form directory "%s" could not be read; nothing is loaded from it.', directory)
        walk.unreadable = True
        return []


def _descend(directory: Traversable, segments: Sequence[str], trail: tuple[str, ...], walk: _Walk) -> None:
    if not segments or len(trail) > _MAX_WALK_DEPTH:
        return
    head, rest = segments[0], segments[1:]
    if head == "**":
        _descend(directory, rest, trail, walk)  # zero directories: the directory's own files
        for node in _children(directory, walk):
            if _is_dir(node):
                _descend(node, segments, (*trail, node.name), walk)
        return
    for node in _children(directory, walk):
        if not fnmatch.fnmatchcase(node.name, head):
            continue
        if rest:
            if _is_dir(node):
                _descend(node, rest, (*trail, node.name), walk)
        elif _is_file(node):
            walk.files[(*trail, node.name)] = node


def _is_dir(node: Traversable) -> bool:
    try:
        return node.is_dir()
    except OSError:
        return False


def _is_file(node: Traversable) -> bool:
    try:
        return node.is_file()
    except OSError:
        return False


def _split(segments: Sequence[str]) -> tuple[int, Sequence[str]]:
    """Return how many leading segments have no glob character (the start) and the pattern that is left.

    A location with no glob character at all names one file: its last segment is the pattern.
    """
    for index, segment in enumerate(segments):
        if _GLOB_CHARACTERS.search(segment):
            return index, segments[index:]
    return max(len(segments) - 1, 0), segments[-1:]


def _locate(location: str) -> tuple[Traversable, Sequence[str]]:
    """Resolve a location to its start directory and the pattern segments below it."""
    if location.startswith(_PACKAGE_PREFIX):
        spec = location[len(_PACKAGE_PREFIX) :]
        package, _, glob = spec.partition("/")
        if not package or not glob:
            raise DatumConfigurationError(
                f'The Datum form location "{location}" is not package:<pkg>/<glob>.', hint=_HINT
            )
        try:
            root = importlib.resources.files(package)
        except (ImportError, TypeError, ValueError) as error:
            raise DatumConfigurationError(
                f'The Datum form location "{location}" names a package that cannot be imported'
                f" ({type(error).__name__}).",
                hint=_HINT,
            ) from None
        segments = [part for part in glob.split("/") if part]
        count, pattern = _split(segments)
        start = root
        for part in segments[:count]:
            start = start.joinpath(part)
        return start, pattern
    parts = PurePath(location).parts
    count, pattern = _split(parts)
    start_path = Path(*parts[:count]) if count else Path()
    return start_path, pattern


def _walk(location: str) -> list[Traversable]:
    start, pattern = _locate(location)
    walk = _Walk()
    if _is_dir(start) and pattern:
        _descend(start, pattern, (), walk)
    if not walk.files and not walk.unreadable:
        logger.warning('The Datum form location "%s" matched no resources; check datum.forms.locations.', location)
    return [walk.files[trail] for trail in sorted(walk.files)]


def _problem(node: Traversable, text: str) -> str:
    return f"{node}: {text}"


def _load(node: Traversable) -> tuple[str, dict[str, JsonValue]] | str:
    """Read one file; return `(id, definition)` or the sentence that names why it is refused."""
    try:
        body = node.read_bytes()
    except OSError as error:
        return _problem(node, f"cannot be read ({type(error).__name__})")
    try:
        value = read(body, max_depth=MAX_DEFINITION_DEPTH)
    except BadDocumentError as error:
        return _problem(node, f"is not a JSON definition ({error})")
    if not isinstance(value, dict):
        return _problem(node, "is not a JSON object")
    form_id = value.get("id")
    if not isinstance(form_id, str):
        return _problem(node, 'has no string "id"')
    if not is_form_key(form_id) or "@" in form_id:
        return _problem(node, f'has the id "{form_id}", which is no form key (1 to 128 letters, digits, ".", "-", "_")')
    return form_id, value


class FileFormDefinitionRepository:
    """Form definitions loaded once, eagerly, from the files `locations` name; read-only, one current version per id.

    A bad file stops the start with a `DatumConfigurationError` naming it (one line per problem); a location that
    matches nothing and an unreadable directory are warnings on `datum.forms`.
    """

    def __init__(self, locations: Sequence[str]) -> None:
        """Walk every location in order (each sorted by path) and load what it matches."""
        self._forms: dict[str, StoredDefinition] = {}
        self._origin: dict[str, Traversable] = {}
        problems: list[str] = []
        for location in locations:
            for node in _walk(location):
                loaded = _load(node)
                if isinstance(loaded, str):
                    problems.append(loaded)
                    continue
                form_id, definition = loaded
                if form_id in self._origin:
                    problems.append(
                        _problem(node, f'repeats the id "{form_id}" that {self._origin[form_id]} already defines')
                    )
                    continue
                self._origin[form_id] = node
                self._forms[form_id] = StoredDefinition(form_id, definition, canonical_digest(definition))
        if problems:
            raise DatumConfigurationError("\n".join(problems), hint=_HINT)

    def keys(self) -> Iterator[str]:
        """Return the form ids in load order."""
        return iter(tuple(self._forms))

    def current(self, key: str) -> StoredDefinition | None:
        """Return the form with this id, or None."""
        return self._forms.get(key)
