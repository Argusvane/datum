"""`TimestampRefusal`: an RFC 3161 failure as a protocol answer.

The failInfo bits and the HTTP statuses bind (RFC 3161 section 2.4.2 and the catalog); the words are Datum's own. A
refusal is a `TimeStampResp` with PKIStatus 2 (rejection), one failure bit and one status text, and no token. The text
is the refusal's message when it has one (a customizer's words, the authority's list of accepted policies, a time
source's reason) and the failure's own words otherwise; it never carries a request byte.
"""

from dataclasses import dataclass
from typing import Final, Self

from datum_core.timestamp import _der
from datum_core.timestamp.protocols import TimestampFailure, TimestampRefusedError

__all__ = ["FAILURES", "TimestampRefusal"]

FAILURES: Final[dict[TimestampFailure, tuple[int, int, str]]] = {
    "badAlg": (0, 400, "The imprint algorithm is not taken: use SHA-256, SHA-384 or SHA-512."),
    "badRequest": (2, 400, "This timestamp request is not permitted."),
    "badDataFormat": (5, 400, "The request is not a well-formed version 1 timestamp request."),
    "timeNotAvailable": (14, 503, "The timestamp server's time source is not available."),
    "unacceptedPolicy": (15, 400, "The requested policy is not one this server issues under."),
    "unacceptedExtension": (16, 400, "This timestamp server accepts no request extensions."),
    "systemFailure": (25, 503, "The timestamp server cannot answer now; try again later."),
}
"""Failure name: the PKIFailureInfo bit, the HTTP status and Datum's words for it."""


@dataclass(frozen=True, slots=True)
class TimestampRefusal:
    """A refused timestamp request: the failure, its bit, the HTTP status and the status text."""

    failure: TimestampFailure
    bit: int
    http_status: int
    text: str

    @classmethod
    def of(cls, error: TimestampRefusedError) -> Self:
        """Return the refusal `error` answers with (an unknown failure name is a `systemFailure`)."""
        failure: TimestampFailure = error.failure if error.failure in FAILURES else "systemFailure"
        bit, status, words = FAILURES[failure]
        message = error.message if failure == error.failure else ""
        return cls(failure, bit, status, message or words)

    def to_der(self) -> bytes:
        """Return the rejected `TimeStampResp`: PKIStatus 2, the bit, the text, no token."""
        return _der.rejection(self.bit, self.text)
