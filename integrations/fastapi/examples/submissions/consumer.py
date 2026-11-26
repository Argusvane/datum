"""An async queue consumer: submissions taken from a queue outside HTTP, through the same Datum and handler as app.py.

Run it from this directory (see README.md). It puts three sample messages on an asyncio queue, a valid one, the
broker's second delivery of it and one that is not JSON, consumes them inside `async with datum:` and stops when the
queue is drained.

Each message is submitted under its broker message id as the submission key: a submission is its submit attempt, and
a message the broker delivers again is the same attempt, answered with the first receipt (`Redelivered`) instead of
being kept twice. Two messages with the same answers and different ids are two submissions.
"""

import asyncio
import json
import logging
from typing import Final

from app import SUBMISSIONS, datum

from datum_core.submissions import FormRef, SubmissionContext, Unavailable
from datum_sandbox.json import BadDocumentError, read

log = logging.getLogger("datum_example.consumer")

MAX_ATTEMPTS = 3
"""Deliveries of one message before it is dead-lettered (the Unavailable retry is bounded, so `queue.join` returns)."""

BACKOFF = 0.1
"""Seconds to wait per delivery before the message goes back on the queue: `BACKOFF * attempt`, so a runtime that is
down is not asked again in a hot loop."""

FORM = "datum-security-suite"  # the fixture form in forms/, a version 1 form

_ADA: Final = json.dumps(
    {
        "versionContext": {"form": {"id": FORM, "version": "1"}, "client": {"runtimeVersion": "example"}},
        "submission": {"locale": "en", "values": {"name": "Ada Lovelace", "addr": {"city": "London"}}},
    }
).encode()

SAMPLE_MESSAGES: tuple[tuple[str, bytes], ...] = (
    ("msg-0001", _ADA),
    ("msg-0001", _ADA),  # the broker delivers the first message again: the same id, the same submit attempt
    ("msg-0002", b"this is not JSON"),
)
"""(broker message id, body) pairs, in delivery order."""

type Delivery = tuple[str, bytes, int]
"""What the queue holds: the broker's message id, the message's bytes and which delivery of it this is."""


async def handle(message_id: str, message: bytes, queue: asyncio.Queue[Delivery], attempt: int) -> None:
    """Judge one message through `datum.async_submissions`: dead-letter what cannot be read, retry on Unavailable.

    The message id is the submission key, so every delivery of one message is one submit attempt (an id outside
    `SUBMISSION_KEY` is dead-lettered). An Unavailable message goes back on the queue under the same id, after a short
    back-off (`BACKOFF` times the attempt), until `MAX_ATTEMPTS` deliveries have failed, then it is dead-lettered.
    """
    if len(message) > datum.config.web.api.max_body_size:
        log.warning("dead-lettered a message of %d bytes: too large", len(message))
        return
    try:
        document = read(message, max_depth=256)
    except BadDocumentError as error:
        log.warning("dead-lettered a message that is not a JSON submission (%s)", error.reason)
        return
    try:
        context = SubmissionContext(channel="bus", submission_key=message_id)
    except ValueError:
        log.warning("dead-lettered a message whose id is not a submission key")
        return
    outcome = await datum.async_submissions.submit(FormRef.from_document(), document, context)
    if isinstance(outcome, Unavailable):
        if attempt >= MAX_ATTEMPTS:
            log.warning("dead-lettered a message after %d unavailable deliveries: %s", attempt, outcome.code)
            return
        log.warning("left a message for a retry (%d of %d): %s", attempt, MAX_ATTEMPTS, outcome.code)
        await asyncio.sleep(BACKOFF * attempt)
        await queue.put((message_id, message, attempt + 1))
        return
    log.info("consumed a message: %s", type(outcome).__name__)


async def consume(queue: asyncio.Queue[Delivery]) -> None:
    """Take messages until cancelled; each delivery is marked done whether it was kept, dropped or requeued."""
    while True:
        message_id, message, attempt = await queue.get()
        try:
            await handle(message_id, message, queue, attempt)
        finally:
            queue.task_done()


async def main() -> None:
    """Fill the queue, consume it inside the runtime's lifespan, then stop."""
    queue: asyncio.Queue[Delivery] = asyncio.Queue()
    for message_id, message in SAMPLE_MESSAGES:
        queue.put_nowait((message_id, message, 1))
    async with datum:
        worker = asyncio.create_task(consume(queue))
        try:
            await queue.join()
        finally:
            worker.cancel()
    log.info("done: %d submission(s) kept", len(SUBMISSIONS))


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    asyncio.run(main())
