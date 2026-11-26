"""The submissions example: an application that takes submissions over HTTP and keeps them in memory.

Run it from this directory with the settings in README.md. The same `datum` object serves consumer.py, which takes the
same handler's submissions from a queue outside HTTP.
"""

import logging
import threading
import uuid

from fastapi import Depends, FastAPI

from datum_core.submissions import AcceptedSubmission, SubmissionReceipt
from datum_fastapi import Datum, DatumSettings, routers

# The example prints its handler line: uvicorn configures only its own loggers, so the application sets INFO here.
logging.basicConfig(level=logging.INFO)
log = logging.getLogger("datum_example.submissions")

SUBMISSIONS: list[AcceptedSubmission] = []
"""Every accepted submission, in arrival order (the example's whole store)."""

_receipts: dict[tuple[str, str | None, str | None], SubmissionReceipt] = {}
_lock = threading.Lock()


def keep(accepted: AcceptedSubmission) -> SubmissionReceipt:
    """Keep each accepted submission once and answer its receipt (the handler).

    Datum calls it on a worker thread, so the list is guarded. Two deliveries of one submit attempt may both reach it
    (no lock holds across instances), so it is idempotent on the attempt's key: the second one reads the first
    receipt. Two people who give the same answers send two keys and are kept twice, so the digest is no key here.
    """
    attempt = (accepted.form_key, accepted.version, accepted.submission_key)
    with _lock:
        receipt = _receipts.get(attempt)
        if receipt is None:
            receipt = SubmissionReceipt(id=str(uuid.uuid4()), reference=uuid.uuid4().hex[:12].upper())
            _receipts[attempt] = receipt
            SUBMISSIONS.append(accepted)
    log.info("kept a submission of %s over %s (receipt %s)", accepted.form_key, accepted.channel, receipt.id)
    return receipt


def permit() -> None:
    """Admit every caller: the example's stand-in for authentication. A real application puts its own here."""


datum = Datum(config=DatumSettings().to_config(), handler=keep)

app = FastAPI()
app.include_router(routers.forms(datum))
app.include_router(routers.submissions(datum))
app.include_router(routers.management(datum, dependencies=[Depends(permit)]))
