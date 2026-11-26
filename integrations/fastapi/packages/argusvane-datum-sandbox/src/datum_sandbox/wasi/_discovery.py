"""Entry-point discovery of engines (`datum.guest_runtimes`) and the selection of one by id.

`select` raises `EngineSelectionError` (an unknown id, an unavailable engine, one id claimed by two distributions); the
layer above refuses the start with it whatever its fail-fast setting says.
"""

import importlib.metadata
import inspect
import logging
import re
from collections import defaultdict
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from importlib.metadata import EntryPoint
from typing import cast

from datum_sandbox.wasi._errors import EngineSelectionError
from datum_sandbox.wasi._protocols import GuestRuntimeProvider
from datum_sandbox.wasi._records import LOGGER_NAME, Availability, Available, Unavailable

logger = logging.getLogger(LOGGER_NAME)

GROUP = "datum.guest_runtimes"


@dataclass(frozen=True, slots=True)
class DiscoveredRuntime:
    """One entry point as found: `provider` and `availability` are set unless `error` says why it is broken."""

    id: str
    distribution: str
    provider: GuestRuntimeProvider | None = None
    availability: Availability | None = None
    error: str | None = None


def _distribution_of(entry: EntryPoint) -> str:
    dist = entry.dist
    names = dist.metadata.get_all("Name") if dist is not None else None
    return (names[0] if names else None) or "<unnamed distribution>"


def _entry_points(path: Sequence[str] | None) -> list[EntryPoint]:
    """Use the standard library's discovery; `path` (tests) walks those directories, hiding a second copy by name."""
    if path is None:
        return list(importlib.metadata.entry_points(group=GROUP))
    seen: set[str] = set()
    found: list[EntryPoint] = []
    for dist in importlib.metadata.distributions(path=list(path)):
        names = dist.metadata.get_all("Name")
        name = names[0] if names else None
        if name:
            key = re.sub(r"[-_.]+", "-", name).lower()
            if key in seen:
                continue
            seen.add(key)
        found.extend(ep for ep in dist.entry_points if ep.group == GROUP)
    return found


def _load(entry: EntryPoint) -> DiscoveredRuntime:
    distribution = _distribution_of(entry)
    try:
        loaded = entry.load()
        provider = cast("GuestRuntimeProvider", loaded() if inspect.isclass(loaded) else loaded)
        provider_id = provider.id
        if provider_id != entry.name:
            return DiscoveredRuntime(
                entry.name,
                distribution,
                error=f"the provider answers to {provider_id!r}, not to its entry-point name",
            )
        availability = provider.availability()
        if not isinstance(cast("object", availability), Available | Unavailable):
            return DiscoveredRuntime(
                entry.name, distribution, error="availability() answered neither Available nor Unavailable"
            )
    except Exception as error:
        logger.warning("engine %r from %s is broken: %s: %s", entry.name, distribution, type(error).__name__, error)
        return DiscoveredRuntime(entry.name, distribution, error=f"{type(error).__name__}: {error}")
    return DiscoveredRuntime(entry.name, distribution, provider=provider, availability=availability)


class GuestRuntimes:
    """The engines installed, as discovered; `select(id)` picks one or stops the start with `EngineSelectionError`."""

    def __init__(self, found: Iterable[DiscoveredRuntime]) -> None:
        """Hold the listing."""
        self._found = tuple(found)

    @classmethod
    def discover(
        cls,
        *,
        path: Sequence[str] | None = None,
        entry_points: Iterable[EntryPoint] | None = None,
    ) -> "GuestRuntimes":
        """List the providers in the `datum.guest_runtimes` group.

        `path` limits the search to those directories (tests); `entry_points` supplies the entries directly. A provider
        whose import raises is listed with its `error`; the others are unaffected. Two distributions claiming one id are
        both listed and `select` refuses the id naming both: `importlib.metadata` hides only a second copy of one
        distribution, so the entry names are counted here.
        """
        entries = list(entry_points) if entry_points is not None else _entry_points(path)
        return cls(_load(entry) for entry in entries)

    @property
    def listing(self) -> tuple[DiscoveredRuntime, ...]:
        """Every entry point found, in discovery order."""
        return self._found

    def ids(self) -> tuple[str, ...]:
        """Return the distinct ids found, sorted."""
        return tuple(sorted({item.id for item in self._found}))

    def duplicates(self) -> dict[str, tuple[str, ...]]:
        """Return the ids claimed by more than one entry, with the distributions' names."""
        claims: defaultdict[str, list[str]] = defaultdict(list)
        for item in self._found:
            claims[item.id].append(item.distribution)
        return {key: tuple(names) for key, names in claims.items() if len(names) > 1}

    def select(self, engine_id: str) -> GuestRuntimeProvider:
        """Return the provider for `engine_id`, or raise `EngineSelectionError` saying why not.

        Ids are compared case-folded on both sides (`MyEngine` and `myengine` are one id), so two distributions whose
        ids differ only in case are refused as one id claimed twice.
        """
        wanted = engine_id.strip().casefold()
        claims: defaultdict[str, list[str]] = defaultdict(list)
        for item in self._found:
            claims[item.id.casefold()].append(item.distribution)
        if len(claims.get(wanted, [])) > 1:
            names = " and ".join(sorted(claims[wanted]))
            raise EngineSelectionError(
                f"engine id {engine_id!r} is registered by more than one distribution: {names}",
                hint="uninstall one of them, or select the other by an id it alone provides",
            )
        matches = [item for item in self._found if item.id.casefold() == wanted]
        if not matches:
            known = ", ".join(self.ids()) or "none installed"
            raise EngineSelectionError(
                f"no program runtime engine {engine_id!r} is installed (found: {known})",
                hint="install the distribution that provides it, or set datum.runtime.engine to one found",
            )
        item = matches[0]
        if item.provider is None or item.availability is None:
            raise EngineSelectionError(
                f"engine {engine_id!r} from {item.distribution} is broken: {item.error}",
                hint="reinstall the distribution; the import or its availability check failed",
            )
        if isinstance(item.availability, Unavailable):
            raise EngineSelectionError(
                f"engine {engine_id!r} from {item.distribution} is unavailable here: {item.availability.reason}",
                hint="see the engine's documentation for the platforms it supports",
            )
        return item.provider
