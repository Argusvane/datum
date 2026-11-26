"""Builder hook, event and outcome shapes the type checkers must accept (mypy --strict and pyright strict)."""

import functools
from typing import assert_never

from datum_core import Datum
from datum_core.builder import (
    BuilderOutcome,
    BuilderSaveCandidate,
    BuilderSaveCustomizer,
    BuilderSaveDraft,
    BuilderSaveValidator,
    CatalogOutdated,
    CatalogSaved,
    Declined,
    Exists,
    LocaleChanges,
    Malformed,
    NotFound,
    Outdated,
    ReadOnly,
    Refused,
    Saved,
    TooLarge,
    Unavailable,
)
from datum_core.events import DatumEvent, FormDefinitionSavedEvent, listener
from datum_core.hooks import HookFindings, HookProblem, HookRefusedError


def customize(draft: BuilderSaveDraft) -> None:
    draft.definition["title"] = draft.key


async def async_customize(draft: BuilderSaveDraft) -> None:
    draft.definition["title"] = draft.key


def refuse(draft: BuilderSaveDraft) -> None:
    raise HookRefusedError.forbidden("save.notYours", "Not yours to change.")


def tag(prefix: str, draft: BuilderSaveDraft) -> None:
    draft.definition["prefix"] = prefix


class ClassCustomizer:
    def __call__(self, draft: BuilderSaveDraft) -> None:
        draft.definition["by"] = "class" if draft.creating else repr(draft.principal)


c1: BuilderSaveCustomizer = customize
c2: BuilderSaveCustomizer = async_customize
c3: BuilderSaveCustomizer = refuse
c4: BuilderSaveCustomizer = functools.partial(tag, "p")
c5: BuilderSaveCustomizer = lambda draft: None  # noqa: E731
c6: BuilderSaveCustomizer = ClassCustomizer()


def validate(candidate: BuilderSaveCandidate) -> HookFindings | None:
    if candidate.warnings:
        return HookFindings(warnings=(HookProblem(None, "kernel.warned", "The kernel warned."),))
    return None


async def async_validate(candidate: BuilderSaveCandidate) -> HookFindings | None:
    return HookFindings(errors=(HookProblem("title", "title.reserved", "Reserved."),))


v1: BuilderSaveValidator = validate
v2: BuilderSaveValidator = async_validate
v3: BuilderSaveValidator = lambda candidate: None  # noqa: E731

datum = Datum(builder_save_customizers=[c1, c2, c3, c4, c5, c6], builder_save_validators=(v1, v2, v3))


def on_saved(event: FormDefinitionSavedEvent) -> None:
    previous: str | None = event.previous_sha256
    assert event.key
    assert event.sha256
    assert previous != "x"


async def on_saved_async(event: FormDefinitionSavedEvent) -> None: ...


def on_anything(event: DatumEvent) -> None: ...


listener(FormDefinitionSavedEvent, on_saved)
listener(FormDefinitionSavedEvent, on_saved_async)
listener(FormDefinitionSavedEvent, on_anything)  # a listener typed for the base accepts the subclass event
listener(DatumEvent, on_anything)
listener(FormDefinitionSavedEvent, lambda event: None)

changes: LocaleChanges = LocaleChanges(removed=("de",), renamed=(("fr", "fr-CA"),))


def label(outcome: BuilderOutcome) -> str:
    match outcome:
        case Saved() | CatalogSaved():
            return "saved"
        case Outdated() | CatalogOutdated() | Exists():
            return "conflict"
        case Refused() | Declined() | Malformed() | TooLarge():
            return "refused"
        case NotFound() | ReadOnly() | Unavailable():
            return "unavailable"
        case _ as unreachable:
            assert_never(unreachable)
