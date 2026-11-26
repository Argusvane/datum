"""`ReceiptStatement`: a submission's receipt that carries a timestamp token.

`ReceiptStatement.of(accepted)` fixes the imprint as the submission's digest bytes (the canonical SHA-256 of the
answers, as the pipeline computed it). `stamp(timestamper)` asks any `Timestamper` (the in-process authority, the
client of a remote one, the application's own) for a token over it on the `receipt` channel and returns the JSON member
a handler puts in `SubmissionReceipt.receipt`::

    {
        "timestamp": {
            "algorithm": "sha256",
            "imprint": "<hex>",
            "token": "<base64 DER>",
            "genTime": "<ISO 8601>",
            "serial": "<decimal>",
        }
    }

The idempotency store keeps the receipt the handler returned, so a redelivery answers the SAME token and the
timestamper is not asked again (the idempotency store's `record()` returns the receipt that stands). Two deliveries that
race, before
either is recorded, may both ask: a handler is idempotent on the submission key, and the receipt that stands is the
first recorded. A refusal of the timestamper reaches the caller as it was raised; the handler decides whether the
submission is then answered without a token or not at all. The member holds no credential and no key.

Libraries: the standard library (`bytes.fromhex`, `base64`, `dataclasses`) covers it; nothing carries a receipt
vocabulary.
"""

import base64
import re
from dataclasses import dataclass
from typing import Final, Self

from datum_core.submissions import AcceptedSubmission
from datum_core.timestamp.protocols import Timestamper
from datum_sandbox.json import JsonValue

__all__ = ["ReceiptStatement"]

_SHA256_HEX: Final = re.compile(r"[0-9a-fA-F]{64}")


@dataclass(frozen=True, slots=True)
class ReceiptStatement:
    """What a receipt asks a timestamp over: the imprint (a SHA-256 digest) and its algorithm name."""

    imprint: bytes
    algorithm: str = "sha256"

    @classmethod
    def of(cls, accepted: AcceptedSubmission) -> Self:
        """Fix the imprint as the submission's digest bytes; raise `ValueError` when the digest is not SHA-256 hex."""
        if not _SHA256_HEX.fullmatch(accepted.digest):
            raise ValueError("the submission's digest is not 64 hexadecimal characters (a SHA-256)")
        return cls(bytes.fromhex(accepted.digest))

    def stamp(self, timestamper: Timestamper) -> dict[str, JsonValue]:
        """Ask `timestamper` once for a token over the imprint and return the receipt member that carries it."""
        grant = timestamper.request(self.imprint, self.algorithm, channel="receipt")
        return {
            "timestamp": {
                "algorithm": self.algorithm,
                "imprint": self.imprint.hex(),
                "token": base64.b64encode(grant.token).decode("ascii"),
                "genTime": grant.gen_time.isoformat(),
                "serial": str(grant.serial),
            }
        }
