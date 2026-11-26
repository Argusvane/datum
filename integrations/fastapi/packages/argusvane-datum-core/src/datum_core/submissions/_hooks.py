"""The submission hooks: callable types, the pre-check's two answers and their mapping, the stores.

A one-method hook is a callable type answering `T | Awaitable[T]`; an awaitable goes through the service's awaiter.
The stores are small Protocols, never `runtime_checkable`. Hooks are sequences on the `Datum` constructor, run in
list order.
"""

import re
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Final, Protocol

from datum_core.hooks import HookFindings, MaybeAwaitable
from datum_core.submissions._model import (
    AcceptedSubmission,
    IncomingSubmission,
    RememberedReceipt,
    RunSettings,
    SubmissionContext,
    SubmissionReceipt,
    ValidatedSubmission,
)
from datum_sandbox.json import JsonValue
from datum_sandbox.protocol import RuleModule

__all__ = [
    "Allow",
    "ContextContributor",
    "HostContextProvider",
    "HostOptionsCustomizer",
    "PreCheckDecision",
    "PreCheckStatuses",
    "Reject",
    "RulesProvider",
    "SubmissionHandler",
    "SubmissionIdempotencyStore",
    "SubmissionPreCheck",
    "SubmissionSignatureCheck",
    "SubmissionValidator",
]

_CODE: Final = re.compile(r"[A-Za-z][A-Za-z0-9._:\-]{0,127}")


@dataclass(frozen=True, slots=True)
class Allow:
    """A pre-check lets the call go on."""


@dataclass(frozen=True, slots=True)
class Reject:
    """A pre-check refuses: a stable code and words for a person.

    The code is letters, digits and `. _ : -`, starting with a letter, at most 128. It carries no status:
    `pre_check_statuses` decides the answer.
    """

    code: str
    message: str

    def __post_init__(self) -> None:
        """Hold the code to its alphabet."""
        if _CODE.fullmatch(self.code) is None:
            raise ValueError("a pre-check code is letters, digits and . _ : -, at most 128, starting with a letter")


type PreCheckDecision = Allow | Reject
"""What a pre-check answers."""

type SubmissionPreCheck = Callable[[IncomingSubmission], MaybeAwaitable[PreCheckDecision]]
"""Runs after the throttle and before the definition is read, in every mode; the first `Reject` stops the rest."""

type SubmissionHandler = Callable[[AcceptedSubmission], MaybeAwaitable[SubmissionReceipt]]
"""The effect: store, deliver or issue an accepted submission and answer its receipt; idempotent on `submission_key`."""

type SubmissionValidator = Callable[[ValidatedSubmission, SubmissionContext], MaybeAwaitable[HookFindings | None]]
"""Runs after the sandbox and before the effect: errors refuse, warnings ride along. All run, in list order."""

type ContextContributor = Callable[[SubmissionContext], MaybeAwaitable[Mapping[str, JsonValue] | None]]
"""Host-context entries for the run, merged in list order (a later contributor's key replaces an earlier one's)."""

type HostContextProvider = Callable[[str, SubmissionContext], MaybeAwaitable[Mapping[str, JsonValue] | None]]
"""The values the form's `host.` paths read (sandbox ABI 4.1.0 `hostContext`), worked out by the host for one call.

Handed the form key and the call's context (the principal the application's dependency answered, the headers a hook
may see), it answers a JSON object, or None for no context (every rule reading `host.` is then left unjudged, as
before the key existed). It is never read from the request body. An object the sandbox cannot take as JSON (a key
that is not text, a number JSON cannot carry, a value with no JSON form, deeper than 64 levels below a key, more than
1,000,000 values) is the host's own bug and answers `Unavailable` `server.unavailable`, as a raise does; a
`HookRefusedError` is raised as it is. One provider per `Datum`; a retry of a known submit attempt asks none."""

type HostOptionsCustomizer = Callable[
    [str, Mapping[str, JsonValue], RunSettings, SubmissionContext], MaybeAwaitable[None]
]
"""Changes the run's typed draft (`RunSettings`) for a form, or refuses (`HookRefusedError`); the first refusal stops
the rest. It is handed a copy of the definition: changing the copy changes nothing the run reads."""

type RulesProvider = Callable[[str, Mapping[str, JsonValue], SubmissionContext], MaybeAwaitable[Sequence[RuleModule]]]
"""The rule modules a form's run loads, in list order across providers."""


class PreCheckStatuses:
    """Two mappings from a pre-check's `Reject` to the status a route answers; any `Callable[[Reject], int]` will do.

    `standard()` answers 403 for every code. `by_suffix()` answers 422 for a code ending `.invalid`, 503 (with
    `Retry-After`) for one ending `.unavailable`, else 403; it never answers 429 (an application mapping may, and
    that answer carries no `Retry-After`: no window is known).
    """

    @staticmethod
    def standard() -> Callable[[Reject], int]:
        """403 for every code (`access.denied` included)."""

        def forbidden(decision: Reject) -> int:  # noqa: ARG001 - one answer for every code
            return 403

        return forbidden

    @staticmethod
    def by_suffix() -> Callable[[Reject], int]:
        """422 for `.invalid`, 503 for `.unavailable`, else 403."""

        def by_suffix(decision: Reject) -> int:
            if decision.code.endswith(".invalid"):
                return 422
            if decision.code.endswith(".unavailable"):
                return 503
            return 403

        return by_suffix


class SubmissionIdempotencyStore(Protocol):
    """Accepted submit attempts by (form key, version, submission key): asked before the run, told after the handler.

    Each entry keeps the digest the attempt was accepted with beside its receipt (`RememberedReceipt`): the same key
    and digest is a retry, answered with the receipt; the same key with another digest is refused. `record` is an
    idempotent insert: the first writer of a key wins and every later writer gets the winner's entry back, with no
    lock held between `find` and `record`. Synchronous, as the service runs on a worker thread (a store that answers
    an awaitable anyway is resolved through the service's awaiter); the contract kit
    `datum_core.testing.IdempotencyStoreContract` holds a store to the protocol.
    """

    def find(self, form_key: str, version: str, submission_key: str) -> RememberedReceipt | None:
        """Return the entry kept for the key, or None."""
        ...

    def record(
        self, form_key: str, version: str, submission_key: str, remembered: RememberedReceipt
    ) -> RememberedReceipt:
        """Keep `remembered` unless the key has an entry; return the entry that stands."""
        ...


class SubmissionSignatureCheck(Protocol):
    """The signature slot of the receiver order (after idempotency, before the validators).

    Reserved: the check, its `record_use` and `stored` steps arrive with the passkey capability; until then the slot
    is a documented no-op and `Datum(signature_check=None)` is the only value the service takes.
    """
