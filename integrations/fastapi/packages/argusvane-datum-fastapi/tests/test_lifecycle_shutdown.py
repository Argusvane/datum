"""Under uvicorn: a request in flight at SIGTERM, the native cancel, the drain and the grace.

Each class runs one scenario in a uvicorn subprocess (one definition read whose work takes a few seconds) and checks
it in several tests; serial (marker `server`).
"""

import signal

import pytest
from lifecycle_driver import Outcome, run_shutdown_scenario

pytest.importorskip("uvicorn", reason="the shutdown scenarios boot uvicorn")
pytestmark = pytest.mark.server

PATH = "/api/forms/contact/definition"
STOPPED_GRACEFULLY = (0, -signal.SIGTERM)


def before(events: list[str], first: str, second: str) -> bool:
    return first in events and second in events and events.index(first) < events.index(second)


class TestUvicornWaitsForTheRequest:
    """No graceful-shutdown timeout: uvicorn lets the request finish, then runs the lifespan exit."""

    @pytest.fixture(scope="class")
    @classmethod
    def outcome(cls, tmp_path_factory: pytest.TempPathFactory) -> Outcome:
        return run_shutdown_scenario(
            tmp_path_factory.mktemp("wait"), "wait", path=PATH, env_extra={"DATUM_TEST_EFFECT_SECONDS": "1.5"}
        )

    def test_the_client_gets_its_answer(self, outcome: Outcome) -> None:
        assert outcome.responses["request"][0] == 200

    def test_the_effect_ends_before_datum_stops(self, outcome: Outcome) -> None:
        assert before(outcome.events, "effect done", "datum stop")
        assert outcome.events.count("datum stop") == 1

    def test_the_server_exits_gracefully_with_no_error_logged(self, outcome: Outcome) -> None:
        assert outcome.exit_code in STOPPED_GRACEFULLY
        assert "ERROR" not in outcome.stderr


class TestTheNativeCancelDoesNotStopTheEffect:
    """`--timeout-graceful-shutdown 1` cancels the request task natively; the tracked call completes in the drain."""

    @pytest.fixture(scope="class")
    @classmethod
    def outcome(cls, tmp_path_factory: pytest.TempPathFactory) -> Outcome:
        return run_shutdown_scenario(
            tmp_path_factory.mktemp("cancel"),
            "cancel",
            path=PATH,
            extra_args=("--timeout-graceful-shutdown", "1"),
            env_extra={"DATUM_TEST_EFFECT_SECONDS": "3"},
        )

    def test_the_effect_completes_although_its_request_was_cancelled(self, outcome: Outcome) -> None:
        assert "effect done" in outcome.events
        assert outcome.responses["request"][0] != 200  # the answer itself was lost with the cancelled request

    def test_the_lifespan_exit_drains_before_datum_stops(self, outcome: Outcome) -> None:
        assert before(outcome.events, "effect done", "datum stop")
        assert "shutdown_grace" not in outcome.stderr  # within the grace: nothing was interrupted

    def test_the_server_exits_gracefully(self, outcome: Outcome) -> None:
        assert outcome.exit_code in STOPPED_GRACEFULLY
        assert "Finished server process" in outcome.stderr


class TestTheGraceExpires:
    """A call longer than `datum.runtime.shutdown_grace`: the drain gives up, the runtime interrupts, Datum stops."""

    @pytest.fixture(scope="class")
    @classmethod
    def outcome(cls, tmp_path_factory: pytest.TempPathFactory) -> Outcome:
        return run_shutdown_scenario(
            tmp_path_factory.mktemp("grace"),
            "grace",
            path=PATH,
            extra_args=("--timeout-graceful-shutdown", "1"),
            env_extra={"DATUM_TEST_EFFECT_SECONDS": "5", "DATUM_TEST_SHUTDOWN_GRACE": "0.5"},
        )

    def test_datum_stops_before_the_call_that_outlived_the_grace(self, outcome: Outcome) -> None:
        assert "datum stop" in outcome.events
        assert "effect done" not in outcome.events or before(outcome.events, "datum stop", "effect done")

    def test_the_interruption_is_logged_once_as_a_warning(self, outcome: Outcome) -> None:
        lines = [line for line in outcome.stderr.splitlines() if "shutdown_grace" in line]
        assert len(lines) == 1
        assert lines[0].startswith("WARNING datum.runtime")

    def test_the_server_still_exits(self, outcome: Outcome) -> None:
        assert outcome.exit_code in STOPPED_GRACEFULLY
