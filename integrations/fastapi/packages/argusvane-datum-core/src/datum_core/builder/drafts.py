"""The builder's hook records and types: `builder_save_customizers`, `builder_save_validators`.

A customizer runs after the host's own checks and before the kernel, on a copy of the definition it may change in place
or refuse (`HookRefusedError`); it never changes the `id` or the `version` (`CustomizerIdentityError`, a defect of the
hook). What the customizers leave is held to the same rules again and is what the kernel checks and the store keeps.
A validator runs after the kernel's check with the verdict: it answers `HookFindings` (every validator runs; errors
refuse together, warnings ride in the answer) or refuses at once. The principal is passed to the hooks and decides
nothing in the service. A hook is told about the form being saved and nothing else.
"""

from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any

from datum_core.hooks import HookFindings, HookProblem, MaybeAwaitable
from datum_sandbox.json import JsonValue

__all__ = ["BuilderSaveCandidate", "BuilderSaveCustomizer", "BuilderSaveDraft", "BuilderSaveValidator"]


@dataclass(frozen=True, slots=True)
class BuilderSaveDraft:
    """What a customizer is told: the form key, whether it is a create, who saves, and a copy to change in place.

    `definition` is the service's own copy of what was sent (JSON, keys as sent); changing it changes what is checked
    and stored. The record itself cannot be rebound.
    """

    key: str
    creating: bool
    principal: object | None
    definition: dict[str, Any]


@dataclass(frozen=True, slots=True)
class BuilderSaveCandidate:
    """What a validator is told: the draft's fields, the definition the customizers left, and the kernel's verdict.

    `definition` is a copy the validators share; changing it changes nothing stored. `problems` is the kernel's formula
    problems (empty: a problem refuses before the validators run), `warnings` its formula warnings and
    `structure_warnings` its structure warnings, each with the kernel's location as `field`.
    """

    key: str
    creating: bool
    principal: object | None
    definition: Mapping[str, JsonValue]
    problems: tuple[HookProblem, ...] = ()
    warnings: tuple[HookProblem, ...] = ()
    structure_warnings: tuple[HookProblem, ...] = ()


type BuilderSaveCustomizer = Callable[[BuilderSaveDraft], MaybeAwaitable[None]]
"""Changes `draft.definition` in place, or raises `HookRefusedError`; sync or async."""

type BuilderSaveValidator = Callable[[BuilderSaveCandidate], MaybeAwaitable[HookFindings | None]]
"""Answers findings (or None), or raises `HookRefusedError`; sync or async."""
