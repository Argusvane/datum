"""The lifespan every Datum router carries and the `started` guard.

Every router a factory builds has `lifespan=datum.lifespan`; `include_router` merges it into the application's
lifespan, once per inclusion, and each one enters Datum's reference-counted lifecycle (`datum_core.aio.AsyncLifecycle`:
the first entry starts Datum, the last exit drains and stops it). `async with datum:` is the same entry by hand: the
form for an application's own lifespan, for a Starlette parent of `datum.asgi_app()` (a `Mount` forwards no lifespan),
and for tests.

Until an entry, the guard on every Datum router answers 503 `server.unavailable` and logs one ERROR naming the
composition; the application's include-time dependencies run before it, so an unauthenticated request meets the
application's own 401 first.
"""

import logging
from typing import Final, NoReturn

from datum_core.aio import AsyncLifecycle
from datum_core.datum import Datum
from datum_core.forms import Unavailable
from datum_core.http import HttpAnswer, outcome_answer
from datum_fastapi.routing import AnswerError
from datum_sandbox.loggers import RUNTIME

__all__ = ["COMPOSITION_ERROR", "START_FAILED_ERROR", "StartedGuard"]

logger = logging.getLogger(RUNTIME)

COMPOSITION_ERROR: Final = (
    "A Datum route was called, but Datum's lifespan never ran, so its runtime is not started and every Datum route"
    " answers 503 server.unavailable. Datum starts when the application's lifespan enters its routers (do not serve"
    " the application with the lifespan off, as `uvicorn --lifespan off` does) or, for datum.asgi_app() under a"
    " Mount (which forwards no lifespan), when the parent application's lifespan writes `async with datum:`."
)
"""The one ERROR the guard logs when no start was ever tried: what was composed wrong and the two ways out."""

START_FAILED_ERROR: Final = (
    "A Datum route was called, but Datum's start failed (the error was raised out of the lifespan and caught by the"
    " application, or by its server), so the runtime is not running and every Datum route answers 503"
    " server.unavailable. The start's own error is in the log above; fix its cause and start again."
)
"""The one ERROR the guard logs when a start was tried and failed: the start failed, not the lifespan skipped."""


class StartedGuard:
    """The router-level `started` dependency of one `Datum` (first in every Datum router's list)."""

    def __init__(self, datum: Datum, lifecycle: AsyncLifecycle) -> None:
        """Guard `datum`'s routes on the state of its lifecycle."""
        self._datum = datum
        self._lifecycle = lifecycle
        self._reported = False
        self._start_failed = False

    def note_failed_start(self) -> None:
        """Record that a start was tried and failed (the binding calls this when entering Datum raised)."""
        self._start_failed = True

    async def __call__(self) -> None:
        """Pass when Datum is up; else answer 503 `server.unavailable` (and, before any start, log the ERROR once)."""
        runner = self._lifecycle.runner
        if runner is not None and not runner.closed and self._datum.ready:
            return
        self._refuse()

    async def entered(self) -> None:
        """Pass when a lifespan entered Datum, whether or not its runtime is up (the management probes use this).

        `readyz` and `health` must answer while the runtime is down, so they ask only that Datum was entered; the
        routes that run work ask `__call__`, which also wants the runtime up.
        """
        runner = self._lifecycle.runner
        if runner is not None and not runner.closed:
            return
        self._refuse()

    def is_entered(self) -> bool:
        """Whether a lifespan has entered Datum (its runtime up or not); a pure read, with no refusal and no log."""
        runner = self._lifecycle.runner
        return runner is not None and not runner.closed

    def _refuse(self) -> NoReturn:
        if not self._lifecycle.entered_once and not self._reported:
            self._reported = True
            logger.error(START_FAILED_ERROR if self._start_failed else COMPOSITION_ERROR)
        raise AnswerError(self.unavailable())

    def unavailable(self) -> HttpAnswer:
        """Return the 503 `server.unavailable` answer, with no `Retry-After`, in the configured error format."""
        api = self._datum.config.web.api
        return outcome_answer(Unavailable(), problem_details=api.problem_details)
