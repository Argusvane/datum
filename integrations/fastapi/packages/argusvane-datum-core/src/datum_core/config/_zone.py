"""The process time zone: read once through tzlocal, UTC when it cannot be read."""

import functools
import warnings
from typing import NamedTuple
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import tzlocal

from datum_core.checks import process_zone_unresolved
from datum_sandbox.checks import DatumCheck


class ProcessZone(NamedTuple):
    """The zone name and, when UTC was a fallback, the WARN check that says so."""

    name: str
    check: DatumCheck | None


def is_zone_name(name: str) -> bool:
    """Say whether ``name`` is an IANA zone ZoneInfo can load."""
    try:
        ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError, OSError):
        return False
    return True


@functools.cache
def process_zone() -> ProcessZone:
    """Resolve the process zone once; tests that change TZ call ``reset_process_zone``."""
    name: str | None
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")  # tzlocal warns "defaulting to UTC"; the check below says it once
            name = tzlocal.get_localzone_name()
    except Exception:
        name = None
    if name and is_zone_name(name):
        return ProcessZone(name, None)
    return ProcessZone("UTC", process_zone_unresolved())


def reset_process_zone() -> None:
    """Forget the resolved zone (tests that change TZ)."""
    process_zone.cache_clear()


def process_zone_name() -> str:
    """Return the default of ``datum.host.time_zone``."""
    return process_zone().name
