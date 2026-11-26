"""`health()`: contributor functions composed into a frozen report."""

import logging
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass
from types import MappingProxyType
from typing import Literal, cast

from datum_sandbox.loggers import RUNTIME

logger = logging.getLogger(RUNTIME)

type Status = Literal["up", "down"]

READY_COMPONENT = "runtime"
"""The one component `readyz` reads."""


def _frozen(details: Mapping[str, object]) -> Mapping[str, object]:
    return MappingProxyType(dict(details))


@dataclass(frozen=True, slots=True)
class ComponentHealth:
    """One component: `up` or `down` and a flat map of details (camelCase keys, JSON values)."""

    status: Status
    details: Mapping[str, object]

    def __post_init__(self) -> None:
        """Copy the details into a read-only mapping."""
        object.__setattr__(self, "details", _frozen(self.details))

    @classmethod
    def up(cls, **details: object) -> "ComponentHealth":
        """Return an `up` component."""
        return cls("up", details)

    @classmethod
    def down(cls, reason: str, **details: object) -> "ComponentHealth":
        """Return a `down` component whose details start with the reason."""
        return cls("down", {"reason": reason, **details})


@dataclass(frozen=True, slots=True)
class HealthReport:
    """The whole answer: `up` only when every component is up (and there is at least none to fail)."""

    status: Status
    components: Mapping[str, ComponentHealth]

    def __post_init__(self) -> None:
        """Copy the components into a read-only mapping."""
        object.__setattr__(self, "components", MappingProxyType(dict(self.components)))

    @property
    def is_up(self) -> bool:
        """Whether the overall status is up: the `/health` probe is 200, else 503."""
        return self.status == "up"

    @property
    def is_ready(self) -> bool:
        """Whether the `runtime` component is present and up: the `/readyz` probe reads it alone (503 until probed)."""
        runtime = self.components.get(READY_COMPONENT)
        return runtime is not None and runtime.status == "up"

    def to_json(self) -> dict[str, object]:
        """Return the flat wire body `{status, components: {name: {status, details}}}`."""
        return {
            "status": self.status,
            "components": {
                name: {"status": item.status, "details": dict(item.details)} for name, item in self.components.items()
            },
        }


type HealthCheck = Callable[[], ComponentHealth | None]
"""A contributor: answers its component, or `None` (read as down, "no status"); anything else is down, "bad status"."""

type HealthContributor = tuple[str, HealthCheck]


def _run(name: str, check: HealthCheck) -> ComponentHealth:
    try:
        answer = check()
    except Exception as error:
        logger.warning("the health check %r failed", name, exc_info=True)
        return ComponentHealth.down(f"check failed ({type(error).__name__})")
    if answer is None:
        return ComponentHealth.down("no status")
    if not isinstance(cast("object", answer), ComponentHealth):
        logger.warning("the health check %r answered a %s, not a ComponentHealth", name, type(answer).__name__)
        return ComponentHealth.down("bad status")
    return answer


def health(contributors: Iterable[HealthContributor]) -> HealthReport:
    """Run each contributor once and compose the report; a duplicate component name is a `ValueError`."""
    items = list(contributors)
    names = [name for name, _ in items]
    duplicated = sorted({name for name in names if names.count(name) > 1})
    if duplicated:
        raise ValueError(f"duplicate health component names: {', '.join(duplicated)}")
    components = {name: _run(name, check) for name, check in items}
    overall: Status = "up" if all(item.status == "up" for item in components.values()) else "down"
    return HealthReport(overall, components)


class HealthRegistry:
    """Contributors registered by component name as capabilities are wired; a duplicate name is refused at once."""

    def __init__(self) -> None:
        """Start with no contributor."""
        self._items: dict[str, HealthCheck] = {}

    def register(self, name: str, check: HealthCheck) -> None:
        """Add a contributor; a name already registered raises `ValueError`."""
        if name in self._items:
            raise ValueError(f"duplicate health component name: {name}")
        self._items[name] = check

    def health(self) -> HealthReport:
        """Run every registered contributor and return the report."""
        return health(self._items.items())
