"""`ReceiptStatement`: a submission's receipt that carries a timestamp token, and what a redelivery answers.

The imprint is the submission's digest as bytes (the canonical SHA-256 of the answers); `stamp(timestamper)` asks any
`Timestamper` (the authority, the client, the application's own) for a token over it and returns the JSON member the
handler puts in `SubmissionReceipt.receipt`. That receipt is what the idempotency store keeps, so a redelivery answers
the SAME token with no second call (the idempotency store's `record()` returns the receipt that stands).
"""

import base64
import json
import threading
from collections.abc import Mapping
from datetime import datetime

import pytest
from submissions_support import bus, envelope, started
from tsa_der import token_parts
from tsa_support import make_authority, sha256

from datum_core.config.models import TsaClientOptions
from datum_core.submissions import Accepted, AcceptedSubmission, Redelivered, SubmissionReceipt
from datum_core.testing.tsa_pki import INSTANT, TsaPki
from datum_core.timestamp import (
    ReceiptStatement,
    TimestampChannel,
    TimestampClient,
    Timestamper,
    TimestampGrant,
    TimestampQuery,
    TimestampRefusedError,
    TransportReply,
)

DIGEST_HEX = sha256(b"the canonical answers").hex()


def accepted(digest: str = DIGEST_HEX) -> AcceptedSubmission:
    return AcceptedSubmission(
        form_key="contact",
        digest=digest,
        values={"name": "Ada"},
        warnings=(),
        channel="bus",
        remote_address=None,
        user_agent=None,
    )


class Counting:
    """A `Timestamper` over a real authority that counts its calls and records what it was asked."""

    def __init__(self, tsa_pki: TsaPki) -> None:
        self.authority = make_authority(tsa_pki.ec)
        self.calls: list[tuple[bytes, str]] = []
        self.channels: list[str] = []
        self._lock = threading.Lock()

    def request(
        self,
        imprint: bytes,
        algorithm: str,
        *,
        policy: str | None = None,
        cert_req: bool = True,
        channel: TimestampChannel = "seal",
    ) -> TimestampGrant:
        with self._lock:
            self.calls.append((imprint, algorithm))
            self.channels.append(channel)
        from datum_core.timestamp import TimestampQuery  # noqa: PLC0415

        return self.authority.issue(TimestampQuery.of(imprint, algorithm, policy=policy, cert_req=cert_req))


def test_the_statement_fixes_the_imprint_as_the_submissions_digest_bytes() -> None:
    statement = ReceiptStatement.of(accepted())
    assert statement.imprint == bytes.fromhex(DIGEST_HEX)
    assert statement.algorithm == "sha256"


def test_a_digest_that_is_not_sha_256_hex_is_refused() -> None:
    for bad in ("", "zz" * 32, "ab" * 31, "ab" * 33):
        with pytest.raises(ValueError, match="digest"):
            ReceiptStatement.of(accepted(bad))


def test_stamp_asks_the_timestamper_once_for_a_token_over_the_digest(tsa_pki: TsaPki) -> None:
    timestamper = Counting(tsa_pki)
    ReceiptStatement.of(accepted()).stamp(timestamper)
    assert timestamper.calls == [(bytes.fromhex(DIGEST_HEX), "sha256")]
    assert timestamper.channels == ["receipt"]


def test_the_authority_and_the_client_are_timestampers() -> None:
    from datum_core.timestamp import TimestampAuthority, TimestampClient  # noqa: PLC0415

    for klass in (TimestampAuthority, TimestampClient):
        assert callable(getattr(klass, "request", None)), klass


def test_the_member_is_plain_json_holding_the_token_the_time_the_serial_and_the_imprint(tsa_pki: TsaPki) -> None:
    timestamper = Counting(tsa_pki)
    member = ReceiptStatement.of(accepted()).stamp(timestamper)
    assert json.loads(json.dumps(member)) == member
    stamp = member["timestamp"]
    assert isinstance(stamp, dict)
    token = base64.b64decode(str(stamp["token"]))
    parts = token_parts(token)
    assert parts.tst.imprint == bytes.fromhex(DIGEST_HEX)
    assert stamp["algorithm"] == "sha256"
    assert stamp["imprint"] == DIGEST_HEX
    assert datetime.fromisoformat(str(stamp["genTime"])) == INSTANT
    assert str(stamp["serial"]) == str(parts.tst.serial)


def test_the_member_never_carries_a_credential_or_a_key(tsa_pki: TsaPki) -> None:
    text = json.dumps(ReceiptStatement.of(accepted()).stamp(Counting(tsa_pki)))
    assert "PRIVATE" not in text
    assert "Bearer" not in text


def test_a_refusal_from_the_timestamper_reaches_the_caller_as_it_was_raised() -> None:
    class Refusing:
        def request(
            self,
            imprint: bytes,
            algorithm: str,
            *,
            policy: str | None = None,
            cert_req: bool = True,
            channel: TimestampChannel = "seal",
        ) -> TimestampGrant:
            raise TimestampRefusedError("timeNotAvailable", "down")

    with pytest.raises(TimestampRefusedError):
        ReceiptStatement.of(accepted()).stamp(Refusing())


def test_the_protocol_is_the_one_phase_7_seals_with(tsa_pki: TsaPki) -> None:
    timestamper: Timestamper = Counting(tsa_pki)
    assert timestamper.request(sha256(b"x"), "sha256").serial >= 1


# -- redelivery: no second call ----------------------------------------------------------------------------------------
def test_a_redelivery_answers_the_same_token_and_never_asks_the_timestamper_again(tsa_pki: TsaPki) -> None:
    timestamper = Counting(tsa_pki)

    def handler(accepted_submission: AcceptedSubmission) -> SubmissionReceipt:
        member = ReceiptStatement.of(accepted_submission).stamp(timestamper)
        return SubmissionReceipt(id="id-1", reference="REF-1", receipt=member)

    with started(handler=handler) as rig:
        first = rig.submit(envelope(), bus(submission_key="attempt-1"))
        again = rig.submit(envelope(), bus(submission_key="attempt-1"))
    assert isinstance(first, Accepted)
    assert isinstance(again, Redelivered)
    assert len(timestamper.calls) == 1
    assert again.receipt == first.receipt
    assert first.receipt.receipt is not None
    assert again.receipt.receipt == first.receipt.receipt


def test_the_digest_of_a_real_delivery_is_the_imprint_the_token_covers(tsa_pki: TsaPki) -> None:
    timestamper = Counting(tsa_pki)

    def handler(accepted_submission: AcceptedSubmission) -> SubmissionReceipt:
        return SubmissionReceipt("id-1", "REF-1", ReceiptStatement.of(accepted_submission).stamp(timestamper))

    with started(handler=handler) as rig:
        outcome = rig.submit()
    assert isinstance(outcome, Accepted)
    ((imprint, _),) = timestamper.calls
    assert imprint.hex() == outcome.submission.digest


class CountingTransport:
    """A `TsaTransport` double over a real authority: it answers every POST with a real reply and counts the POSTs."""

    def __init__(self, tsa_pki: TsaPki) -> None:
        self.authority = make_authority(tsa_pki.ec)
        self.posts = 0
        self._lock = threading.Lock()

    def post(
        self, url: str, body: bytes, *, content_type: str, accept: str, headers: Mapping[str, str], timeout: float
    ) -> TransportReply:
        with self._lock:
            self.posts += 1
        grant = self.authority.issue(TimestampQuery.parse(body))
        return TransportReply(200, "application/timestamp-reply", grant.response)


def test_a_redelivery_through_a_real_client_makes_one_transport_call_and_answers_the_same_token(
    tsa_pki: TsaPki,
) -> None:
    """Two deliveries, one POST to the authority, one token: the real client is the `Timestamper`."""
    transport = CountingTransport(tsa_pki)
    client = TimestampClient(
        TsaClientOptions.model_validate({"url": "https://tsa.example.test/tsa", "timeout": 5}), transport=transport
    )

    def handler(accepted_submission: AcceptedSubmission) -> SubmissionReceipt:
        member = ReceiptStatement.of(accepted_submission).stamp(client)
        return SubmissionReceipt(id="id-1", reference="REF-1", receipt=member)

    with started(handler=handler) as rig:
        first = rig.submit(envelope(), bus(submission_key="attempt-1"))
        again = rig.submit(envelope(), bus(submission_key="attempt-1"))
    assert isinstance(first, Accepted)
    assert isinstance(again, Redelivered)
    assert transport.posts == 1
    assert first.receipt.receipt is not None
    assert again.receipt.receipt == first.receipt.receipt
    stamp = first.receipt.receipt["timestamp"]
    assert isinstance(stamp, dict)
    assert token_parts(base64.b64decode(str(stamp["token"]))).tst.imprint == bytes.fromhex(first.submission.digest)
