"""The unknown-key scan: DATUM_ environment names that match no setting."""

import typing
from collections.abc import Iterator, Mapping

from pydantic import BaseModel

from datum_core.checks import unknown_env_key
from datum_core.config._types import NAME_CUTOFF, closest
from datum_core.config.models import DatumConfig
from datum_sandbox.checks import DatumCheck

PREFIX = "DATUM_"
DELIMITER = "__"
ALLOWED = frozenset({"DATUM_CONFIG_FILE"})
"""Names the host reads outside the settings tree."""


def _section(annotation: object) -> type[BaseModel] | None:
    return annotation if isinstance(annotation, type) and issubclass(annotation, BaseModel) else None


def _is_mapping(annotation: object) -> bool:
    return typing.get_origin(annotation) is dict or annotation is dict


def setting_names(model: type[BaseModel] = DatumConfig, prefix: str = PREFIX) -> Iterator[str]:
    """Every environment name the tree answers to, sections included: ``DATUM_RUNTIME``, ``DATUM_RUNTIME__ENGINE``."""
    for name, field in model.model_fields.items():
        full = prefix + name.upper()
        yield full
        section = _section(field.annotation)
        if section is not None:
            yield from setting_names(section, full + DELIMITER)


def _known(model: type[BaseModel], parts: list[str]) -> bool:
    fields = {name.upper(): field for name, field in model.model_fields.items()}
    field = fields.get(parts[0])
    if field is None:
        return False
    rest = parts[1:]
    if not rest:
        return True
    section = _section(field.annotation)
    if section is not None:
        return _known(section, rest)
    return _is_mapping(field.annotation)  # DATUM_WEB__THROTTLE__LIMITS__SUBMIT names a key of a mapping


def unknown_env_checks(env: Mapping[str, str], model: type[BaseModel] = DatumConfig) -> tuple[DatumCheck, ...]:
    """One ``datum.W007`` per DATUM_ name in ``env`` that matches no field, with the closest name as a hint.

    Names are compared case-insensitively through the ``__`` nesting; the hint draws on the setting names and the
    allowlist (``DATUM_CONFIG_FIL`` is offered ``DATUM_CONFIG_FILE``). Empty values count: the key is still a typo. The
    caller decides what to do with the checks (the binding's settings source raises under ``strict_env``).
    """
    names = (*setting_names(model), *ALLOWED)
    found: list[DatumCheck] = []
    for key in sorted(env):
        upper = key.upper()
        if not upper.startswith(PREFIX) or upper in ALLOWED:
            continue
        if _known(model, upper[len(PREFIX) :].split(DELIMITER)):
            continue
        found.append(unknown_env_key(key, closest(upper, names, cutoff=NAME_CUTOFF)))
    return tuple(found)
