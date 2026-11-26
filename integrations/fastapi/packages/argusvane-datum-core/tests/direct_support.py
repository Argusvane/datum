"""A `SubmissionService` built directly (no `Datum`) over the recording seams of `submissions_support`.

The follow-up tests read the service and the answer table alone, so they need no started runtime.
"""

from dataclasses import dataclass, field
from typing import Any

from submissions_support import (
    Handler,
    RecordingIdempotency,
    RecordingSandbox,
    RecordingThrottle,
    Repository,
    definition,
)

from datum_core.events import DatumEvent, EventDispatcher
from datum_core.submissions import SubmissionService
from datum_sandbox.json import JsonValue


@dataclass
class Parts:
    """The recording seams of one directly built service, sharing one trail."""

    trail: list[str] = field(default_factory=list[str])
    events: list[DatumEvent] = field(default_factory=list[DatumEvent])

    def __post_init__(self) -> None:
        self.sandbox = RecordingSandbox(self.trail)
        self.repository = Repository(self.trail, definition())
        self.idempotency = RecordingIdempotency(self.trail)
        self.throttle = RecordingThrottle(self.trail)
        self.handler = Handler(self.trail)

    def service(self, **seams: Any) -> SubmissionService:
        options: dict[str, Any] = {
            "repository": self.repository,
            "sandbox": lambda: self.sandbox,
            "idempotency_store": self.idempotency,
            "events": EventDispatcher([(DatumEvent, self.events.append)]),
            "max_document_bytes": 1024 * 1024,
            "handler": self.handler,
            "throttle": self.throttle,
        }
        options.update(seams)
        return SubmissionService(**options)

    @property
    def sent(self) -> dict[str, JsonValue]:
        """The run input of the last validation."""
        return self.sandbox.validations[-1][0]
