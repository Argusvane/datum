"""The asset catalog: the files a binding may serve, resolved once at start.

A request path is only ever a key of the dictionary built here. It is never joined to a directory, decoded again,
normalised or stripped: the dictionary is built from the file lists the asset script wrote (`files.json`, one entry per
shipped file with its sha256), each listed name is checked and joined to its distribution's directory exactly once, at
start, and everything else is a miss. The `host.json` model lives with the other wire models in `datum_core.http.wire`.

Libraries: `importlib.resources` finds the installed distributions and `pathlib` holds the real paths;
`mimetypes` is not used (it reads the platform registry, answers nothing for `.map` and differs by platform), so
the media types are an explicit table; the strong ETag is the sha256 the asset script already computed, so `hashlib`
is not needed here; Starlette's `StaticFiles` joins the request path to a directory and this layer imports no
framework (import-linter), so the catalog is a dictionary lookup that a binding's `FileResponse` serves from.
"""

import json
import logging
import re
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass, field, replace
from http import HTTPStatus
from importlib import resources
from importlib.resources.abc import Traversable
from importlib.util import find_spec
from pathlib import Path, PurePosixPath
from types import MappingProxyType
from typing import Final, Self, cast

from datum_core.loggers import ASSETS
from datum_sandbox.checks import DatumConfigurationError

__all__ = [
    "ASSET_NOT_FOUND",
    "MEDIA_TYPES",
    "NO_CACHE",
    "RESOURCE_PACKAGES",
    "AssetCatalog",
    "AssetFile",
    "AssetSource",
    "WithheldAssets",
    "agree_build_ids",
    "media_type_for",
    "resolve_assets_root",
]

_LOG = logging.getLogger(ASSETS)

type WithheldAssets = Callable[[str], bool]
"""Says whether an asset path (case-folded) is never served, on top of the build's own withheld files."""

ASSET_NOT_FOUND: Final = HTTPStatus.NOT_FOUND
"""The status of an asset path the catalog does not hold."""

NO_CACHE: Final = "no-cache"
"""`Cache-Control` of `host.json` and the page glue: they name the build, so they are never cached unvalidated."""

_PLAIN_TEXT: Final = "text/plain; charset=utf-8"
_OCTET_STREAM: Final = "application/octet-stream"

MEDIA_TYPES: Final[Mapping[str, str]] = MappingProxyType(
    {
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".css": "text/css",
        ".json": "application/json",
        ".map": "application/json",
        ".wasm": "application/wasm",
        ".svg": "image/svg+xml",
        ".woff2": "font/woff2",
        ".ttf": "font/ttf",
        ".bcmap": _OCTET_STREAM,
        ".icc": _OCTET_STREAM,
        ".pfb": _OCTET_STREAM,
        ".txt": _PLAIN_TEXT,
    }
)
"""Extension (lower case, with the dot) to media type; the extension-less `LICENSE*` files are plain text."""

_LICENSE_PREFIX: Final = "LICENSE"
_BUILD_ID: Final = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}")
_SHA256: Final = re.compile(r"[0-9A-Fa-f]{64}")
_BAD_SEGMENTS: Final = frozenset({"", ".", ".."})
_BUILD_FILE: Final = "datum-build.json"
_FILE_LIST: Final = "files.json"
_BUILDER_LIST: Final = "builder-files.json"
_ASSETS_DIR: Final = "assets"
_FEATURE_LIST: Final = "feature-files.json"
_PDF_DISTRIBUTION: Final = "datum_assets_pdf"
_PDF_FEATURES: Final = ("pdf", "pdf-pages")

RESOURCE_PACKAGES: Final[tuple[tuple[str, str], ...]] = (
    ("datum_assets_ui", "argusvane-datum-assets-ui"),
    ("datum_assets_pdf", "argusvane-datum-assets-pdf"),
    ("datum_programs", "argusvane-datum-programs"),
    ("datum_qjs_wasm", "argusvane-datum-qjs-wasm"),
)
"""The resource distributions (import name, distribution name) that must carry one build id when installed."""


def media_type_for(path: str) -> str:
    """Return the media type of a served path; `LookupError` when the table has none (a guess is never made)."""
    name = path.rpartition("/")[2]
    suffix = PurePosixPath(name).suffix.lower()
    if suffix:
        found = MEDIA_TYPES.get(suffix)
        if found is not None:
            return found
    elif name.startswith(_LICENSE_PREFIX):
        return _PLAIN_TEXT
    raise LookupError(f"the media-type table has no entry for {path!r}")


def resolve_assets_root(traversable: Traversable) -> Path:
    """Return the resource directory as a real `pathlib.Path`; refuse anything else (a zip import has no file paths)."""
    if not isinstance(traversable, Path):
        raise DatumConfigurationError(
            f"The asset directory {traversable!s} is not a real directory (a zip or other archive import?); the "
            "asset route serves files by path.",
            hint="Install the Datum asset distributions unpacked (pip and uv do), not as a zipped egg or a zipapp.",
        )
    return traversable


@dataclass(frozen=True, slots=True)
class AssetFile:
    """One served file: its real path, media type, strong ETag (the manifest sha256, quoted) and size at start."""

    path: Path
    media_type: str
    etag: str
    size: int

    def cache_headers(self, cache_period: int) -> dict[str, str]:
        """Return `ETag` and the immutable `Cache-Control` for a file served under its build id."""
        if isinstance(cache_period, bool) or cache_period < 0:
            raise ValueError("cache_period is a whole number of seconds, zero or more")
        return {"ETag": self.etag, "Cache-Control": f"public, max-age={cache_period}, immutable"}


@dataclass(frozen=True, slots=True)
class AssetSource:
    """One resource distribution's asset directory and what its lists say about it.

    `files` maps each served path (relative, forward slashes) to its sha256; `builder_files` names the paths that
    belong to the builder; `features` maps a feature token to the paths it owns (for `omit_features`): the UI
    distribution reads them from `feature-files.json`, which the asset script copies from the bundle.
    """

    name: str
    root: Path
    build_id: str
    files: Mapping[str, str]
    builder_files: frozenset[str] = frozenset()
    features: Mapping[str, frozenset[str]] = field(default_factory=dict[str, frozenset[str]])

    @classmethod
    def from_package(cls, package: str, *, name: str, holds_builder_list: bool = False) -> Self:
        """Read the installed distribution `package`: its build file and the file and builder lists under `assets/`.

        `holds_builder_list` means the distribution is the one that must carry the builder list; its absence is then an
        error, because serving the builder's files with the builder off is the failure the list prevents.
        """
        anchor = _distribution(package, name)
        root = resolve_assets_root(anchor.joinpath(_ASSETS_DIR))
        if not root.is_dir():
            raise DatumConfigurationError(f"{name}: the directory {root} does not exist.")
        files = _string_map(_member(_read_json(root / _FILE_LIST, name), "files"))
        if files is None:
            raise DatumConfigurationError(f'{name}: {root / _FILE_LIST} must be {{"files": {{path: sha256}}}}.')
        builders: frozenset[str] = frozenset()
        builder_path = root / _BUILDER_LIST
        if builder_path.is_file() or holds_builder_list:
            listed = _string_list(_member(_read_json(builder_path, name), "files"))
            if listed is None:
                raise DatumConfigurationError(f'{name}: {builder_path} must be {{"files": [path, ...]}}.')
            builders = frozenset(listed)
        features: dict[str, frozenset[str]] = {}
        feature_path = root / _FEATURE_LIST
        if feature_path.is_file():
            features = _read_features(feature_path, name)
        return cls(
            name=name,
            root=root,
            build_id=_read_build_id(anchor, name),
            files=files,
            builder_files=builders,
            features=features,
        )

    @classmethod
    def build_marker(cls, package: str, *, name: str) -> Self:
        """Read a distribution that serves no file but must agree on the build id (only `datum-build.json`)."""
        anchor = _distribution(package, name)
        return cls(name=name, root=Path(), build_id=_read_build_id(anchor, name), files={})


def _distribution(package: str, name: str) -> Traversable:
    try:
        return resources.files(package)
    except (ImportError, TypeError) as error:
        raise DatumConfigurationError(
            f"{name}: the package {package!r} cannot be found.",
            hint=f"Install {name} at the version of argusvane-datum-core.",
        ) from error


def _read_json(path: Path | Traversable, name: str) -> object:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise DatumConfigurationError(
            f"{name}: {path!s} cannot be read as JSON ({type(error).__name__}).",
            hint=f"Reinstall {name}; the asset script writes {path.name}.",
        ) from error


def _read_build_id(anchor: Traversable, name: str) -> str:
    build_id = _member(_read_json(anchor.joinpath(_BUILD_FILE), name), "buildId")
    if not isinstance(build_id, str):
        raise DatumConfigurationError(f'{name}: {_BUILD_FILE} must hold {{"buildId": "..."}}.')
    return build_id


def _read_features(path: Path, name: str) -> dict[str, frozenset[str]]:
    """Read the bundle's `feature-files.json`: token to the files it owns, an alias taking its target's files."""
    document = _read_json(path, name)
    shape = f'{name}: {path} must be {{"features": {{token: {{"files": [path, ...]}}}}, "aliases": {{token: token}}}}.'
    listed = _member(document, "features")
    if not isinstance(listed, dict):
        raise DatumConfigurationError(shape)
    features: dict[str, frozenset[str]] = {}
    for token, entry in cast("dict[object, object]", listed).items():
        files = _string_list(_member(entry, "files"))
        if not isinstance(token, str) or files is None:
            raise DatumConfigurationError(shape)
        features[token] = frozenset(files)
    aliases_document = _member(document, "aliases")
    aliases = {} if aliases_document is None else _string_map(aliases_document)
    if aliases is None or any(target not in features for target in aliases.values()):
        raise DatumConfigurationError(shape)
    for alias, target in aliases.items():
        features[alias] = features.get(alias, frozenset()) | features[target]
    return features


def _member(document: object, key: str) -> object:
    """Return `document[key]` when the document is a JSON object that has it, else `None`."""
    if isinstance(document, dict):
        return cast("dict[str, object]", document).get(key)
    return None


def _string_map(value: object) -> dict[str, str] | None:
    if not isinstance(value, dict):
        return None
    pairs = cast("dict[object, object]", value)
    if not all(isinstance(key, str) and isinstance(item, str) for key, item in pairs.items()):
        return None
    return cast("dict[str, str]", value)


def _string_list(value: object) -> list[str] | None:
    if not isinstance(value, list):
        return None
    items = cast("list[object]", value)
    if not all(isinstance(item, str) for item in items):
        return None
    return cast("list[str]", value)


@dataclass(frozen=True, slots=True)
class _Entry:
    file: AssetFile
    builder: bool
    features: frozenset[str]


class AssetCatalog:
    """The dictionary from served path to a real file, with the rules that withhold some of them.

    Built once at start from the distributions' file lists. `find` is a dictionary lookup on the exact string it is
    given and answers `None` for everything else: another build id, a path the lists do not name, a builder file while
    the builder is off, a file of an omitted feature, a file an application callable withholds.
    """

    def __init__(
        self,
        sources: Sequence[AssetSource],
        *,
        builder_enabled: bool = False,
        omit_features: Iterable[str] = (),
        withheld: Sequence[Callable[[str], bool]] = (),
    ) -> None:
        """Resolve `sources` into the dictionary; a start error names the distribution and the file at fault."""
        if not sources:
            raise DatumConfigurationError("There is no asset distribution to serve.")
        self.build_id: str = _agreed_build_id(sources)
        omitted = frozenset(token.casefold() for token in omit_features)
        builder_names = frozenset(name for source in sources for name in source.builder_files)
        owned = _feature_paths(sources)
        unmatched = sorted(omitted - owned.keys())
        if unmatched:
            raise DatumConfigurationError(
                "omit_features names "
                + ", ".join(repr(token) for token in unmatched)
                + ", which no installed distribution lists as a feature.",
                hint="Known features: " + (", ".join(sorted(owned)) or "none") + ".",
            )
        entries: dict[str, _Entry] = {}
        owners: dict[str, str] = {}
        folded: dict[str, str] = {}
        for source in sources:
            root = source.root.absolute()
            for key, digest in source.files.items():
                _check_key(source, key)
                if key in owners:
                    raise DatumConfigurationError(f"{key!r} is listed by both {owners[key]} and {source.name}.")
                other = folded.setdefault(key.casefold(), key)
                if other != key:
                    raise DatumConfigurationError(
                        f"{source.name} lists {key!r} and {other!r}, which differ only by case; one file system "
                        "would hold one of them."
                    )
                owners[key] = source.name
                entries[key] = _Entry(
                    file=_resolve_file(source, root, key, digest),
                    builder=key in builder_names,
                    features=frozenset(token for token, paths in owned.items() if key in paths),
                )
        unknown = sorted(builder_names - entries.keys())
        if unknown:
            listed_by = ", ".join(
                sorted({source.name for source in sources if not source.builder_files.isdisjoint(unknown)})
            )
            raise DatumConfigurationError(
                f"builder-files.json (listed by {listed_by}) names files no file list holds: "
                + ", ".join(repr(name) for name in unknown)
                + ".",
                hint="The builder list and files.json must spell every path alike; rebuild the asset distributions.",
            )
        self._files: dict[str, _Entry] = {
            key: entry
            for key, entry in entries.items()
            if (builder_enabled or not entry.builder) and omitted.isdisjoint(entry.features)
        }
        self._longest: int = max((len(key) for key in self._files), default=0)
        self._withheld: tuple[Callable[[str], bool], ...] = tuple(withheld)
        self._reported: set[tuple[int, str]] = set()

    @classmethod
    def installed(
        cls,
        *,
        builder_enabled: bool = False,
        omit_features: Iterable[str] = (),
        withheld: Sequence[Callable[[str], bool]] = (),
        agreeing: Sequence[str] = tuple(
            package for package, _ in RESOURCE_PACKAGES if package not in ("datum_assets_ui", _PDF_DISTRIBUTION)
        ),
    ) -> Self:
        """Build the catalog of the installed distributions: the UI assets, the PDF assets when installed.

        The packages named in `agreeing` serve nothing here but must carry the same build id (skipped when not
        installed). The `pdf` and `pdf-pages` feature tokens name the whole PDF distribution.
        """
        ui = AssetSource.from_package("datum_assets_ui", name="argusvane-datum-assets-ui", holds_builder_list=True)
        sources = [ui]
        if find_spec(_PDF_DISTRIBUTION) is None:
            # The UI list also names the builder's PDF chunks; without the PDF distribution they are served by nobody.
            sources = [replace(ui, builder_files=frozenset(name for name in ui.builder_files if name in ui.files))]
        else:
            pdf = AssetSource.from_package(_PDF_DISTRIBUTION, name="argusvane-datum-assets-pdf")
            whole = frozenset(pdf.files)
            sources.append(replace(pdf, features=dict.fromkeys(_PDF_FEATURES, whole)))
        sources.extend(AssetSource.build_marker(package, name=package) for package in agreeing if find_spec(package))
        return cls(sources, builder_enabled=builder_enabled, omit_features=omit_features, withheld=withheld)

    def find(self, build_id: str, path: str) -> AssetFile | None:
        """Return the file served at `path` under `build_id`, or `None`. `path` is only ever a dictionary key."""
        if build_id != self.build_id or len(path) > self._longest:
            return None
        entry = self._files.get(path)
        if entry is None or self._is_withheld(path):
            return None
        return entry.file

    def _is_withheld(self, path: str) -> bool:
        folded = path.casefold()
        for check in self._withheld:
            try:
                if check(folded):
                    return True
            except Exception as error:
                self._report(check, path, error)
                return True
        return False

    def _report(self, check: Callable[[str], bool], path: str, error: Exception) -> None:
        seen = (id(check), path)
        if seen in self._reported:
            return
        self._reported.add(seen)
        _LOG.warning(
            "A withheld_assets callable (%s) raised %s for %s; the file is withheld.",
            getattr(check, "__qualname__", type(check).__name__),
            type(error).__name__,
            path,
        )


def agree_build_ids(
    *, packages: Sequence[tuple[str, str]] = RESOURCE_PACKAGES, markers: Iterable[AssetSource] = ()
) -> str:
    """Hold the installed resource distributions to one build id and return it; refuse naming every id otherwise.

    `packages` are (import name, distribution name) pairs read when installed; `markers` are further sources the caller
    already holds, typically argusvane-datum-core's own `datum-build.json` (`AssetSource.build_marker`). It needs no
    asset configuration: a binding runs it at start whether or not the asset route is on.
    """
    sources = [
        AssetSource.build_marker(package, name=name) for package, name in packages if find_spec(package) is not None
    ]
    sources.extend(markers)
    if not sources:
        raise DatumConfigurationError("There is no Datum resource distribution to agree on a build id.")
    return _agreed_build_id(sources)


def _feature_paths(sources: Sequence[AssetSource]) -> dict[str, frozenset[str]]:
    """Merge every source's feature lists by case-folded token: a token owns its paths in every distribution."""
    merged: dict[str, set[str]] = {}
    for source in sources:
        for token, paths in source.features.items():
            merged.setdefault(token.casefold(), set()).update(paths)
    return {token: frozenset(paths) for token, paths in merged.items()}


def _agreed_build_id(sources: Sequence[AssetSource]) -> str:
    for source in sources:
        if not _BUILD_ID.fullmatch(source.build_id):
            raise DatumConfigurationError(f"{source.name} has an invalid build id {source.build_id!r}.")
    first = sources[0]
    if any(source.build_id != first.build_id for source in sources):
        listing = ", ".join(f"{source.name} is build {source.build_id}" for source in sources)
        raise DatumConfigurationError(
            f"The Datum resource distributions disagree on the build id: {listing}.",
            hint="Install the datum-assets and argusvane-datum-programs distributions at one version.",
        )
    return first.build_id


def _check_key(source: AssetSource, key: str) -> None:
    """Refuse a listed name that is not a plain relative path (it is joined to the directory once, here)."""
    parts = key.split("/")
    if "\x00" in key or "\\" in key or ":" in key or any(part in _BAD_SEGMENTS for part in parts):
        raise DatumConfigurationError(f"{source.name} lists {key!r}, which is not a plain relative path.")


def _resolve_file(source: AssetSource, root: Path, key: str, digest: str) -> AssetFile:
    where = f"{source.name} lists {key!r}"
    if not _SHA256.fullmatch(digest):
        raise DatumConfigurationError(f"{where} with a digest that is not a sha256 (64 hexadecimal digits).")
    try:
        media_type = media_type_for(key)
    except LookupError as error:
        raise DatumConfigurationError(f"{where}, an extension the media-type table lacks.") from error
    target = root / key
    try:
        real = target.resolve(strict=True)
        inside = real.is_relative_to(root.resolve(strict=True))
    except (OSError, RuntimeError) as error:
        raise DatumConfigurationError(f"{where}, but the file is missing under {root}.") from error
    if not real.is_file():
        raise DatumConfigurationError(f"{where}, but it is not a file.")
    if not inside:
        raise DatumConfigurationError(f"{where}, a file that resolves outside {root}.")
    return AssetFile(path=real, media_type=media_type, etag=f'"{digest.lower()}"', size=real.stat().st_size)
