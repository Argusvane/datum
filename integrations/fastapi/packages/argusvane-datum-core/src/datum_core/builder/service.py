"""`BuilderService`: the builder's save, create and catalog write in a fixed order, for every caller.

    save:   NotFound > ReadOnly > TooLarge (the tree) > Outdated > strict JSON > shape > id > language changes
            > finite numbers > customizers (identity after each) > the same rules on what they left > kernel check
            > validators > under the form's lock: the hash again, the repository's compare-and-set, the catalog's move,
            the previous and the new snapshot > FormDefinitionSavedEvent
    create: ReadOnly > TooLarge > strict JSON > shape > id > Exists > language changes > finite numbers > ... as save
    catalog: NotFound > TooLarge > CatalogOutdated > strict JSON > the catalog rules > under the lock: the write

A refusal stores nothing and publishes nothing; a refusal before the kernel costs no kernel run. The kernel's check runs
outside the lock (it is slow and bounded by the validation slots), so the stored hash is read again under the lock and
the repository's own compare-and-set is the safety across instances: a save as sent passes the hash it read under
the lock, so it never overwrites a write it did not see. The lock is one of 64 stripes chosen by the key, so no key an
author chooses grows the table. The event is published after the lock is released, so a listener that saves another
form cannot deadlock on its stripe. A read-only repository answers `ReadOnly` before any work.

What a customizer, a validator, a store or a listener raises reaches the caller as raised (a `HookRefusedError` is the
one refusal a hook makes); a catalog that cannot be moved or a snapshot the store could not record
(any exception it raises) is a warning, because the definition is stored by then. No outcome, log record or event
carries definition text, a rule's source, the hash of a refused body or the principal.
"""

import copy
import logging
import threading
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Final, cast

from datum_core.builder.catalog import copy_catalog, move_locales, read_catalog
from datum_core.builder.changes import LocaleChanges
from datum_core.builder.drafts import (
    BuilderSaveCandidate,
    BuilderSaveCustomizer,
    BuilderSaveDraft,
    BuilderSaveValidator,
)
from datum_core.builder.outcomes import (
    BuilderOutcome,
    CatalogOutdated,
    CatalogSaved,
    Declined,
    Exists,
    Malformed,
    NotFound,
    Outdated,
    ReadOnly,
    Refused,
    Saved,
    TooLarge,
    Unavailable,
)
from datum_core.builder.shape import MAX_PROBLEMS, read_shape, version_of
from datum_core.builder.tree import TreeReading, read_tree
from datum_core.events import EventDispatcher, FormDefinitionSavedEvent
from datum_core.forms import (
    CustomizerIdentityError,
    DefinitionSnapshotStore,
    FormDefinitionRepository,
    StoredDefinition,
    TranslationCatalogStore,
    WritableFormDefinitionRepository,
    parse_form_key,
)
from datum_core.hooks import Awaiter, HookFindings, HookProblem, HookRefusedError, call_hook
from datum_core.loggers import BUILDER
from datum_core.stores import Catalog, StoredCatalog, StoreFullError, catalog_etag
from datum_sandbox.json import JsonValue
from datum_sandbox.protocol import (
    DefinitionTooCostlyError,
    DefinitionTooDeepError,
    ProgramUnavailableError,
    Sandbox,
    SandboxError,
)

__all__ = ["LOCK_STRIPES", "MAX_CATALOG_NESTING", "MOVE_ATTEMPTS", "BuilderService"]

logger = logging.getLogger(BUILDER)

LOCK_STRIPES: Final = 64
"""The per-form lock table: a fixed number of locks, one chosen by the form key."""
MOVE_ATTEMPTS: Final = 3
"""How many times a save reads and writes the catalog for its language changes before it gives up with a warning."""
MAX_CATALOG_NESTING: Final = 32
"""A catalog value nested deeper than this is not a catalog document at all (a catalog nests at most 14 levels)."""
_WHERE_LENGTH: Final = 256
"""The longest kernel location carried; a longer one is cut."""

_REFUSED: Final = "definition.refused"
_UNAVAILABLE: Final = "server.unavailable"
_WHOLE: Final = "definition"
_NOT_JSON: Final = "The definition is not a JSON document the builder reads."
_CATALOG_NOT_JSON: Final = "The catalog is not a JSON document the builder reads."
_NOT_CHECKED: Final = "The form could not be checked because the server runtime is not available, so it was not saved."
_NO_VERDICT: Final = "The form checker gave no verdict, so the form was not saved."
_FORMS_FULL: Final = "The server cannot hold another form now, so it was not saved."
_STOPPED: Final = "The server has stopped, so it was not saved."
_CATALOGS_FULL: Final = "The server cannot hold another catalog now, so it was not saved."
_CREATE_LOST: Final = "The form store refused the new form without naming the form that holds its id; try again."
_NOT_MOVED: Final = (
    "The form was saved, but its translations could not be moved to the new languages; open Translations to check them."
)
_RACED: Final = (
    "The form was saved, but its translations changed at the same time and were not moved to the new languages;"
    " open Translations to check them."
)
_NOT_READ: Final = "The form was saved, but its translations could not be read; open Translations to check them."
_NOT_RECORDED: Final = (
    "The form was saved, but the server could not record this version; a browser holding the previous version may"
    " have to reload."
)
_KERNEL_WORDS: Final = {
    "problems": "A rule of this form cannot be accepted.",
    "structure": "The structure of this form cannot be accepted here.",
    "warnings": "A rule of this form may not work as intended.",
    "structureWarnings": "The structure of this form may not work as intended here.",
}
"""The host's own words for a kernel finding: the kernel's message may quote a rule, a pattern or definition text."""
_IDENTITY: Final = ("id", "version")
_ABSENT: Final = object()


def _problem(code: str, message: str) -> HookProblem:
    return HookProblem(_WHOLE, code, message)


def _refused(code: str, message: str) -> Refused:
    return Refused(_REFUSED, (_problem(code, message),))


def _plain_key(key: object) -> str | None:
    """Return the key as a plain form id (no `@version`), or None when it is not one."""
    parsed = parse_form_key(key)
    if parsed is None or parsed[1] is not None:
        return None
    return parsed[0]


def _kernel_item(item: object, words: str) -> HookProblem | None:
    """One kernel finding in the host's words, its location as the field; None when the item cannot be read."""
    if not isinstance(item, dict):
        return None
    finding = cast("dict[str, object]", item)
    code, where = finding.get("code"), finding.get("where")
    if not isinstance(code, str):
        return None
    try:
        return HookProblem(where[:_WHERE_LENGTH] if isinstance(where, str) and where else None, code, words)
    except ValueError:  # a code outside the documented alphabet
        return None


def _kernel_list(answer: Mapping[str, JsonValue], member: str) -> tuple[HookProblem, ...] | None:
    listed = answer.get(member)
    if not isinstance(listed, list):
        return None
    found: list[HookProblem] = []
    for item in listed:
        problem = _kernel_item(item, _KERNEL_WORDS[member])
        if problem is None:
            return None
        found.append(problem)
    return tuple(found)


@dataclass(frozen=True, slots=True)
class _Verdict:
    """The kernel's check answer as the four lists of findings it must hold."""

    problems: tuple[HookProblem, ...]
    structure: tuple[HookProblem, ...]
    warnings: tuple[HookProblem, ...]
    structure_warnings: tuple[HookProblem, ...]


def _read_verdict(answer: object) -> _Verdict | None:
    """Read the answer closed: None (no verdict) unless every list is there and every finding is readable."""
    record = cast("dict[str, JsonValue]", answer) if isinstance(answer, dict) else {}
    problems = _kernel_list(record, "problems")
    structure = _kernel_list(record, "structure")
    warnings = _kernel_list(record, "warnings")
    structure_warnings = _kernel_list(record, "structureWarnings")
    if problems is None or structure is None or warnings is None or structure_warnings is None:
        return None
    if record.get("verdict") == "fail" and not (problems or structure):
        return None  # a failing verdict that names no finding is no verdict a save can trust
    return _Verdict(problems, structure, warnings, structure_warnings)


class BuilderService:
    """Save, create and write the catalog of form definitions; sync, keyword-only seams, no web framework."""

    def __init__(
        self,
        *,
        repository: FormDefinitionRepository,
        snapshots: DefinitionSnapshotStore,
        translations: TranslationCatalogStore,
        sandbox: Callable[[], Sandbox],
        types: Sequence[str],
        events: EventDispatcher,
        max_definition_bytes: int,
        now: Callable[[], datetime],
        customizers: Sequence[BuilderSaveCustomizer] = (),
        validators: Sequence[BuilderSaveValidator] = (),
        awaiter: Awaiter | None = None,
    ) -> None:
        """Keep the seams.

        `sandbox` resolves the composed sandbox per check (the runtime may be down); `types` is the UI assets manifest's
        `knownComponentTypes` (`known_component_types()`); `max_definition_bytes` is `datum.builder.max_definition_size`
        (also the catalog's cap); `awaiter` runs an `async` hook.
        """
        if max_definition_bytes < 1:
            raise ValueError("the definition cap is at least one byte")
        self._repository = repository
        self._snapshots = snapshots
        self._translations = translations
        self._sandbox = sandbox
        self._types: tuple[str, ...] = tuple(sorted(types))
        self._events = events
        self._max = max_definition_bytes
        self._now = now
        self._customizers: tuple[BuilderSaveCustomizer, ...] = tuple(customizers)
        self._validators: tuple[BuilderSaveValidator, ...] = tuple(validators)
        self._awaiter = awaiter
        self._locks: tuple[threading.Lock, ...] = tuple(threading.Lock() for _ in range(LOCK_STRIPES))

    # -- the lock table -----------------------------------------------------------------------------------------------
    @property
    def lock_count(self) -> int:
        """How many locks the table holds (fixed: 64)."""
        return len(self._locks)

    @property
    def max_definition_bytes(self) -> int:
        """The cap a definition and a catalog are measured against."""
        return self._max

    def stripe_of(self, key: str) -> int:
        """Return the stripe a form key takes: always the same one in this process, spread over the 64."""
        return hash(key) % LOCK_STRIPES

    def _writer(self) -> WritableFormDefinitionRepository | None:
        repository = self._repository
        if hasattr(repository, "create") and hasattr(repository, "replace"):
            return cast("WritableFormDefinitionRepository", repository)
        return None

    def _current(self, key: object) -> StoredDefinition | None:
        plain = _plain_key(key)
        return None if plain is None else self._repository.current(plain)

    # -- the writes ---------------------------------------------------------------------------------------------------
    def save(  # noqa: PLR0911 - one return per stage of the order
        self,
        key: str,
        definition: object,
        *,
        expected_sha256: str | None,
        principal: object | None,
        changes: LocaleChanges | Malformed | None = None,
    ) -> BuilderOutcome:
        """Save a new version of the form `key`; `expected_sha256` None saves as sent (never over an unseen write).

        `changes` is the language changes the save carries; a `Malformed` (changes that could not be read) is answered
        after the shape and the id.
        """
        current = self._current(key)
        if current is None:
            return NotFound(key)
        writer = self._writer()
        if writer is None:
            return ReadOnly()
        reading = read_tree(definition, self._max)
        if reading.size > self._max:
            return TooLarge(self._max)
        if expected_sha256 is not None and expected_sha256 != current.sha256:
            return Outdated(current.sha256, version_of(current.definition))
        judged = self._judge(definition, reading)
        if judged is not None:
            return judged
        tree = cast("dict[str, Any]", definition)
        held = tree.get("id")
        if not isinstance(held, str) or held != key:
            return _refused("definition.id.mismatch", "The definition's id is the form's key.")
        return self._write(
            writer,
            key,
            tree,
            reading,
            creating=False,
            expected_sha256=expected_sha256,
            principal=principal,
            changes=changes,
        )

    def create(
        self, definition: object, *, principal: object | None, changes: LocaleChanges | Malformed | None = None
    ) -> BuilderOutcome:
        """Create a form under the id the definition carries; a form that exists is `Exists`."""
        writer = self._writer()
        if writer is None:
            return ReadOnly()
        reading = read_tree(definition, self._max)
        if reading.size > self._max:
            return TooLarge(self._max)
        judged = self._judge(definition, reading)
        if judged is not None:
            return judged
        tree = cast("dict[str, Any]", definition)
        key = _plain_key(tree.get("id"))
        if key is None:
            return _refused("definition.id.invalid", "A new form's id is 1 to 128 letters, digits, dots, - or _.")
        existing = self._repository.current(key)
        if existing is not None:
            return Exists(key, existing.sha256)
        return self._write(
            writer, key, tree, reading, creating=True, expected_sha256=None, principal=principal, changes=changes
        )

    def save_translations(  # noqa: PLR0911 - one return per stage of the order
        self,
        key: str,
        catalog: object,
        *,
        expected_etag: str | None,
        principal: object | None,  # noqa: ARG002 - the catalog write runs no hook; the principal decides nothing
    ) -> BuilderOutcome:
        """Write the form's translation catalog; `expected_etag` None writes over whatever is there (never unseen)."""
        if self._current(key) is None:
            return NotFound(key)
        reading = read_tree(catalog, self._max)
        if reading.size > self._max:
            return TooLarge(self._max)
        if expected_etag is not None:
            held = self._catalog_etag(self._translations.read(key))
            if held != expected_etag:
                return CatalogOutdated(held)
        if reading.fault is not None or reading.depth > MAX_CATALOG_NESTING:
            return Malformed(_CATALOG_NOT_JSON)
        normalised = read_catalog(catalog)
        if isinstance(normalised, tuple):
            return Refused("catalog.invalid", normalised)
        with self._locks[self.stripe_of(key)]:
            held = self._catalog_etag(self._translations.read(key))
            if expected_etag is not None and held != expected_etag:
                return CatalogOutdated(held)
            if self._events.closed:  # a write the grace abandoned stores nothing after the stop
                return Unavailable(_UNAVAILABLE, _STOPPED, None)
            try:
                written = self._translations.write(key, normalised, expected_etag=held)
            except StoreFullError as error:
                return Unavailable(_UNAVAILABLE, _CATALOGS_FULL, error)
            if written is None:
                return CatalogOutdated(self._catalog_etag(self._translations.read(key)))
        return CatalogSaved(key, written.etag, copy_catalog(written.catalog), self._now())

    @staticmethod
    def _catalog_etag(held: StoredCatalog | None) -> str:
        return catalog_etag({}) if held is None else held.etag

    # -- the stages ---------------------------------------------------------------------------------------------------
    @staticmethod
    def _judge(value: object, reading: TreeReading) -> Malformed | Refused | None:
        """Strict JSON, then the shape (an object, the depth, the root, the components and their floors)."""
        if reading.fault is not None:
            return Malformed(_NOT_JSON)
        return read_shape(value)

    def _again(self, value: object) -> Malformed | Refused | TooLarge | None:
        """Hold what the customizers left to the rules again: the size, strict JSON, the shape, finite numbers."""
        reading = read_tree(value, self._max)
        if reading.size > self._max:
            return TooLarge(self._max)
        judged = self._judge(value, reading)
        if judged is not None:
            return judged
        if reading.non_finite:
            return _refused("definition.number.nonFinite", "A number is one JSON can write (finite).")
        return None

    def _write(  # noqa: PLR0911 - one return per stage of the order
        self,
        writer: WritableFormDefinitionRepository,
        key: str,
        tree: dict[str, Any],
        reading: TreeReading,
        *,
        creating: bool,
        expected_sha256: str | None,
        principal: object | None,
        changes: LocaleChanges | Malformed | None,
    ) -> BuilderOutcome:
        """Language changes, finite numbers, the customizers, the rules again, the kernel, the validators, the store."""
        if isinstance(changes, Malformed):
            return changes
        if reading.non_finite:
            return _refused("definition.number.nonFinite", "A number is one JSON can write (finite).")
        if self._customizers:
            draft = BuilderSaveDraft(key, creating, principal, copy.deepcopy(tree))
            identity = [tree.get(name, _ABSENT) for name in _IDENTITY]
            for customizer in self._customizers:
                try:
                    call_hook(customizer, self._awaiter, draft)
                except HookRefusedError as refusal:
                    return Declined(refusal)
                _check_identity(key, identity, draft.definition)
            tree = draft.definition
            again = self._again(tree)
            if again is not None:
                return again
        checked = self._check(tree)
        if not isinstance(checked, _Verdict):
            return checked
        warnings: list[str] = []
        if self._validators:
            declined = self._validate(
                key, creating=creating, principal=principal, tree=tree, verdict=checked, warnings=warnings
            )
            if declined is not None:
                return declined
        kernel_warnings = (*checked.warnings, *checked.structure_warnings)
        return self._store(
            writer,
            key,
            tree,
            creating=creating,
            expected_sha256=expected_sha256,
            changes=changes,
            warnings=warnings,
            kernel_warnings=kernel_warnings[:MAX_PROBLEMS],
        )

    def _check(self, tree: dict[str, Any]) -> "_Verdict | Refused | Unavailable":
        """Ask the kernel (never skipped, failing closed: an answer it cannot read is `Unavailable`)."""
        try:
            answer = self._sandbox().check(tree, self._types, ())
        except DefinitionTooDeepError as error:
            return Refused(
                "definition.tooDeep", (_problem("definition.tooDeep", "The form is nested too deeply."),), error
            )
        except DefinitionTooCostlyError as error:
            problem = _problem("definition.tooCostly", "The form is too costly to check.")
            return Refused("definition.tooCostly", (problem,), error)
        except (ProgramUnavailableError, SandboxError) as error:  # no verdict: the form is not let through
            return Unavailable(_UNAVAILABLE, _NOT_CHECKED, error)
        verdict = _read_verdict(answer)
        if verdict is None:
            return Unavailable(_UNAVAILABLE, _NO_VERDICT, None)
        errors = (*verdict.problems, *verdict.structure)
        if errors:
            return Refused(_REFUSED, errors[:MAX_PROBLEMS])
        return verdict

    def _validate(
        self,
        key: str,
        *,
        creating: bool,
        principal: object | None,
        tree: dict[str, Any],
        verdict: _Verdict,
        warnings: list[str],
    ) -> Declined | None:
        """Run every validator on one shared copy; the first refusal stops them, errors refuse together."""
        candidate = BuilderSaveCandidate(
            key,
            creating,
            principal,
            copy.deepcopy(tree),
            verdict.problems,
            verdict.warnings,
            verdict.structure_warnings,
        )
        errors: list[HookProblem] = []
        for validator in self._validators:
            try:
                found = call_hook(validator, self._awaiter, candidate)
            except HookRefusedError as refusal:
                return Declined(refusal)
            if found is None:
                continue
            if not isinstance(found, HookFindings):  # pyright: ignore[reportUnnecessaryIsInstance]
                raise TypeError(f"a builder save validator answered {type(found).__name__}, not HookFindings or None")
            errors.extend(found.errors)
            warnings.extend(problem.message or problem.code for problem in found.warnings)
        if errors:
            return Declined(HookRefusedError.invalid(errors))
        return None

    def _store(  # noqa: PLR0911 - one return per stage of the order
        self,
        writer: WritableFormDefinitionRepository,
        key: str,
        tree: dict[str, Any],
        *,
        creating: bool,
        expected_sha256: str | None,
        changes: LocaleChanges | None,
        warnings: list[str],
        kernel_warnings: tuple[HookProblem, ...],
    ) -> BuilderOutcome:
        """Under the form's lock: the hash again, the compare-and-set, the catalog's move, the snapshots."""
        with self._locks[self.stripe_of(key)]:
            if self._events.closed:  # a write the grace abandoned stores nothing after the stop
                return Unavailable(_UNAVAILABLE, _STOPPED, None)
            before = writer.current(key)
            if creating:
                if before is not None:
                    return Exists(key, before.sha256)
                try:
                    stored = writer.create(key, tree)
                except StoreFullError as error:
                    return Unavailable(_UNAVAILABLE, _FORMS_FULL, error)
                if stored is None:
                    return self._lost_create(key)
            else:
                if before is None:
                    return NotFound(key)
                if expected_sha256 is not None and before.sha256 != expected_sha256:
                    return Outdated(before.sha256, version_of(before.definition))
                stored = writer.replace(key, tree, before.sha256)
                if stored is None:
                    return self._lost_replace(key)
            removed, catalog = self._move(key, None if creating else changes, warnings)
            self._record(key, before, stored, warnings)
            saved_at = self._now()
        previous = None if before is None else before.sha256
        self._events.publish(FormDefinitionSavedEvent(key, stored.sha256, previous))
        return Saved(
            key,
            stored.sha256,
            version_of(stored.definition),
            removed,
            catalog,
            tuple(warnings),
            kernel_warnings,
            creating,
            saved_at,
        )

    def _lost_create(self, key: str) -> Exists | Unavailable:
        winner = self._repository.current(key)
        return Unavailable(_UNAVAILABLE, _CREATE_LOST, None) if winner is None else Exists(key, winner.sha256)

    def _lost_replace(self, key: str) -> Outdated | NotFound:
        winner = self._repository.current(key)
        return NotFound(key) if winner is None else Outdated(winner.sha256, version_of(winner.definition))

    # -- after the store: warnings, never a failed save ---------------------------------------------------------------
    def _move(self, key: str, changes: LocaleChanges | None, warnings: list[str]) -> tuple[tuple[str, ...], Catalog]:
        """Move the catalog for the language changes (read, write against its ETag, up to three times).

        Answer the locales removed (none when the move did not happen) and the catalog after the save.
        """
        if changes is None or changes.is_empty:
            return (), self._held_catalog(key, warnings)
        try:
            for _ in range(MOVE_ATTEMPTS):
                held = self._translations.read(key)
                catalog = {} if held is None else held.catalog
                moved = move_locales(catalog, changes)
                if moved == catalog:
                    return changes.removed, copy_catalog(catalog)
                written = self._translations.write(key, moved, expected_etag=self._catalog_etag(held))
                if written is not None:
                    return changes.removed, copy_catalog(written.catalog)
        except MemoryError:
            raise
        except Exception as error:  # a store's failure after the definition was stored is a warning
            logger.warning(
                "the translations of form %s were not moved after its save (%s)",
                key,
                type(error).__name__,
                extra={"datum_form_key": key},
            )
            warnings.append(_NOT_MOVED)
            return (), self._held_catalog(key, warnings)
        logger.warning(
            "the translations of form %s changed during each of %d attempts to move them after its save",
            key,
            MOVE_ATTEMPTS,
            extra={"datum_form_key": key},
        )
        warnings.append(_RACED)
        return (), self._held_catalog(key, warnings)

    def _held_catalog(self, key: str, warnings: list[str]) -> Catalog:
        try:
            held = self._translations.read(key)
        except MemoryError:
            raise
        except Exception as error:  # the definition is stored: the answer must still say so
            logger.warning(
                "the translations of form %s could not be read after its save (%s)",
                key,
                type(error).__name__,
                extra={"datum_form_key": key},
            )
            warnings.append(_NOT_READ)
            return {}
        return {} if held is None else copy_catalog(held.catalog)

    def _record(self, key: str, before: StoredDefinition | None, stored: StoredDefinition, warnings: list[str]) -> None:
        """Record the previous version (a browser holding it can still ask by hash) and the new one."""
        failed = False
        versions = [stored] if before is None else [before, stored]
        for version in versions:
            try:  # one try per record: a failure on the previous version does not skip the new one
                self._snapshots.record(key, version.sha256, version.definition)
            except MemoryError:
                raise
            except Exception as error:  # the definition is stored: any store's failure is a warning
                failed = True
                logger.warning(
                    "a version of form %s was not recorded after its save (%s)",
                    key,
                    type(error).__name__,
                    extra={"datum_form_key": key},
                )
        if failed:
            warnings.append(_NOT_RECORDED)


def _check_identity(key: str, identity: list[object], changed: object) -> None:
    """Refuse a customizer's change of who the form is (its id or version): a defect of the hook, raised."""
    if not isinstance(changed, dict):
        raise CustomizerIdentityError(f"a builder save customizer replaced the definition of {key} with a non-object")
    record = cast("dict[str, object]", changed)
    for name, before in zip(_IDENTITY, identity, strict=True):
        after = record.get(name, _ABSENT)
        if type(before) is not type(after) or before != after:
            raise CustomizerIdentityError(f"a builder save customizer changed the {name} of the definition of {key}")
