"""`DefinitionService`: the definition read in a fixed stage order.

    params > form (repository) / version (snapshot store) > customizers > the kernel's public copy > the answer

Built on: `copy.deepcopy` for the draft, `hashlib` and the canonical writer for the bytes and their ETag,
`typing.assert_never` is the caller's, `functools.lru_cache` does not fit a cache keyed on hooks' answers (see
`datum_core.stores.bounded`). The public-copy rule that matters most: whatever a customizer adds, the kernel's copy
carries no server-secret rule; the author's copy (`public=False`) is never customized and never asks the kernel.
"""

import copy
import hashlib
import logging
import re
import threading
from collections import deque
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Any, Final, cast

from datum_core.canonical import canonical_bytes, canonical_digest
from datum_core.forms.keys import parse_form_key, version_matches
from datum_core.forms.outcomes import DefinitionOutcome, NotFound, Served, TooDeep, Unavailable
from datum_core.forms.protocols import (
    DefinitionCustomizer,
    DefinitionDraft,
    DefinitionRequest,
    DefinitionSnapshotStore,
    FormDefinitionRepository,
    StoredDefinition,
)
from datum_core.hooks import Awaiter, call_hook
from datum_core.loggers import FORMS
from datum_core.stores.bounded import BoundedMap
from datum_sandbox.json import JsonValue
from datum_sandbox.protocol import DefinitionTooDeepError, ProgramUnavailableError, Sandbox, assert_shallow

__all__ = ["CustomizerIdentityError", "DefinitionService", "carries_server_secret_rule"]

logger = logging.getLogger(FORMS)

SERVER_SECRET: Final = "server-secret"  # noqa: S105 - a rule scope name, not a credential
_HASH: Final = re.compile(r"[0-9a-f]{64}")
_DEFAULT_LOCALE: Final = "en"
_ABSENT: Final = object()


class CustomizerIdentityError(RuntimeError):
    """A customizer changed the `id` or the `version`: a defect of the application's hook, answered 500 `internal`."""


def _strings(node: object) -> list[str]:
    """Every string value in a JSON tree, found without recursion (a hostile tree costs no stack)."""
    found: list[str] = []
    stack: list[object] = [node]
    while stack:
        item = stack.pop()
        if isinstance(item, str):
            found.append(item)
        elif isinstance(item, dict):
            stack.extend(item.values())  # pyright: ignore[reportUnknownMemberType, reportUnknownArgumentType]
        elif isinstance(item, list):
            stack.extend(item)  # pyright: ignore[reportUnknownMemberType, reportUnknownArgumentType]
    return found


def carries_server_secret_rule(definition: object) -> bool:
    """Whether any string in the tree names the `server-secret` run scope (case-folded, so a doubt calls the kernel)."""
    return any(SERVER_SECRET in text.casefold() for text in _strings(definition))


def _still_secret(definition: object) -> bool:
    """Whether a rule object with `run` exactly `server-secret` is left in a tree (the check on the kernel's answer)."""
    stack: list[object] = [definition]
    while stack:
        item = stack.pop()
        if isinstance(item, dict):
            if item.get("run") == SERVER_SECRET:  # pyright: ignore[reportUnknownMemberType]
                return True
            stack.extend(item.values())  # pyright: ignore[reportUnknownMemberType, reportUnknownArgumentType]
        elif isinstance(item, list):
            stack.extend(item)  # pyright: ignore[reportUnknownMemberType, reportUnknownArgumentType]
    return False


def _etag_of(body: bytes) -> str:
    return '"' + hashlib.sha256(body).hexdigest() + '"'


@dataclass(frozen=True, slots=True)
class _Cached:
    customized: str
    served: Served


type _Slot = tuple[str, str, tuple[str, ...]]


class DefinitionService:
    """Read a form's definition: the public copy (customized, secret rules removed) or the author's own copy."""

    def __init__(
        self,
        *,
        repository: FormDefinitionRepository,
        snapshots: DefinitionSnapshotStore,
        sandbox: Callable[[], Sandbox],
        customizers: Sequence[DefinitionCustomizer] = (),
        cache_size: int = 256,
        awaiter: Awaiter | None = None,
    ) -> None:
        """Keep the seams.

        `sandbox` resolves the composed sandbox when a copy needs it; `cache_size` is
        `datum.forms.snapshots.public_copy_cache_size`; `awaiter` runs a customizer that is `async`.
        """
        self.repository = repository
        self.snapshots = snapshots
        self.customizers = tuple(customizers)
        self._sandbox = sandbox
        self._awaiter = awaiter
        self._cache: BoundedMap[_Slot, _Cached] = BoundedMap(cache_size)
        self._warned: deque[_Slot] = deque(maxlen=cache_size)
        self._warned_lock = threading.Lock()

    # -- the read ---------------------------------------------------------------------------------------------------
    def read(
        self,
        key: str,
        *,
        public: bool = True,
        sha256: str | None = None,
        principal: object | None = None,
        locale: str = _DEFAULT_LOCALE,
    ) -> DefinitionOutcome:
        """Return the definition: current, or the version recorded under `sha256`; `key` may be `id@version`."""
        parsed = parse_form_key(key)
        if parsed is None or (sha256 is not None and _HASH.fullmatch(sha256) is None):
            return NotFound()
        form_id, version = parsed
        stored = self._stored(form_id, sha256)
        if stored is None or not version_matches(stored.definition, version):
            return NotFound()
        if not public:
            return self._served(canonical_bytes(stored.definition))
        return self._public(stored, current=sha256 is None, principal=principal, locale=locale)

    def _stored(self, form_id: str, sha256: str | None) -> StoredDefinition | None:
        if sha256 is not None:
            found = self.snapshots.find(form_id, sha256)
            if found is not None:
                return StoredDefinition(form_id, found, sha256)
            # A browser holding the current hash is never answered 404 after a restart or on another worker: the
            # current version is served and recorded when it is the one asked for. Any other hash stays a miss.
            current = self.repository.current(form_id)
            if current is None or current.sha256 != sha256:
                return None
            self.snapshots.record(form_id, current.sha256, current.definition)
            return current
        current = self.repository.current(form_id)
        if current is not None:
            self.snapshots.record(form_id, current.sha256, current.definition)
        return current

    @staticmethod
    def _served(body: bytes) -> Served:
        return Served(body, _etag_of(body))

    # -- the public copy ----------------------------------------------------------------------------------------------
    def _public(
        self, stored: StoredDefinition, *, current: bool, principal: object | None, locale: str
    ) -> DefinitionOutcome:
        request = DefinitionRequest(stored.key, stored.sha256, current, principal, locale)
        draft = DefinitionDraft(request, copy.deepcopy(dict(stored.definition)))
        for customizer in self.customizers:
            call_hook(customizer, self._awaiter, draft)
            _check_identity(stored, draft)
        slot = self._slot(request)
        customized = canonical_digest(draft.definition) if self.customizers else stored.sha256
        if slot is not None:
            cached = self._cache.get(slot)
            if cached is not None:
                if cached.customized == customized:
                    return cached.served
                self._warn_too_little(slot, stored.key)
                return self._fresh(draft.definition, None, customized)
        return self._fresh(draft.definition, slot, customized)

    def _slot(self, request: DefinitionRequest) -> _Slot | None:
        """Name the cache slot: the form, the stored hash and each customizer's key; None when any answers None."""
        keys: list[str] = []
        for customizer in self.customizers:
            ask = cast("Callable[[DefinitionRequest], str | None] | None", getattr(customizer, "cache_key", None))
            answer = ask(request) if callable(ask) else None
            if answer is None:
                return None
            keys.append(answer)
        return request.form_key, request.sha256, tuple(keys)

    def _fresh(self, definition: dict[str, Any], slot: _Slot | None, customized: str) -> DefinitionOutcome:
        copied = self._kernel_copy(definition)
        if not isinstance(copied, dict):
            return copied
        served = self._served(canonical_bytes(copied))
        if slot is not None:
            self._cache.put(slot, _Cached(customized, served))
        return served

    def _kernel_copy(self, definition: dict[str, Any]) -> dict[str, JsonValue] | Unavailable | TooDeep:
        try:
            assert_shallow(definition)
        except DefinitionTooDeepError:
            return TooDeep()
        if not carries_server_secret_rule(definition):
            return definition
        try:
            result = self._sandbox().public_copy(definition)
        except ProgramUnavailableError:
            return Unavailable()
        except DefinitionTooDeepError:
            return TooDeep()
        if _still_secret(result):
            raise RuntimeError("the sandbox's public copy still carries a server-secret rule; it is not served")
        return result

    def _warn_too_little(self, slot: _Slot, form_key: str) -> None:
        with self._warned_lock:
            if slot in self._warned:
                return
            self._warned.append(slot)
        logger.warning(
            "A definition customizer's cache_key names too little: two requests for form %s with the same key"
            " customized the definition differently, so a fresh copy is served. Name everything cache_key depends on"
            " (the principal, the locale) or answer None.",
            form_key,
        )


def _check_identity(stored: StoredDefinition, draft: DefinitionDraft) -> None:
    """Refuse a customizer's change of who the form is; run after each one, before the kernel."""
    changed = draft.definition
    if not isinstance(changed, dict):  # pyright: ignore[reportUnnecessaryIsInstance]
        raise CustomizerIdentityError(f"a customizer replaced the definition of {stored.key} with a non-object")
    for field in ("id", "version"):
        before, after = stored.definition.get(field, _ABSENT), changed.get(field, _ABSENT)
        if type(before) is not type(after) or before != after:
            raise CustomizerIdentityError(f"a customizer changed the {field} of the definition of {stored.key}")
