"""Lifecycle under uvicorn: one start and stop for four routers (one included twice), a raising start, no lifespan.

Each class runs one scenario in a uvicorn subprocess and checks it in several tests; serial (marker `server`).
"""

import json
import re
import signal

import pytest
from lifecycle_driver import HEADERS, MAIN, Outcome, named, run_scenario

pytest.importorskip("uvicorn", reason="the lifecycle scenarios boot uvicorn")
pytestmark = pytest.mark.server

PATHS = {
    "main": MAIN,
    "alt": "/alt" + MAIN,
    "second": named("/second"),
    "third": named("/third"),
    "fourth": named("/fourth"),
}
ALL = tuple((label, path, HEADERS) for label, path in PATHS.items())
OPENAPI = ("openapi", "/openapi.json", None)
STOPPED_GRACEFULLY = (0, -signal.SIGTERM)  # the runner reports a SIGTERM exit as -15


class TestNormalRunStoppedWithSigterm:
    @pytest.fixture(scope="class")
    @classmethod
    def outcome(cls, tmp_path_factory: pytest.TempPathFactory) -> Outcome:
        return run_scenario(tmp_path_factory.mktemp("normal"), "normal", requests=(*ALL, OPENAPI))

    def test_one_datum_start_and_one_stop(self, outcome: Outcome) -> None:
        assert outcome.events.count("datum start") == 1
        assert outcome.events.count("datum stop") == 1

    def test_five_entries_and_five_exits_for_four_routers_one_of_them_included_twice(self, outcome: Outcome) -> None:
        assert outcome.events.count("datum enter") == 5
        assert outcome.events.count("datum exit") == 5

    def test_the_applications_lifespan_encloses_datums(self, outcome: Outcome) -> None:
        assert outcome.events[0] == "app start"
        assert outcome.events[-1] == "app stop"

    def test_sigterm_ends_gracefully_with_no_error_logged(self, outcome: Outcome) -> None:
        assert "Finished server process" in outcome.stderr
        assert "ERROR" not in outcome.stderr
        assert outcome.exit_code in STOPPED_GRACEFULLY

    def test_every_route_answers_200(self, outcome: Outcome) -> None:
        assert outcome.listening
        assert {label: status for label, (status, _) in outcome.responses.items()} == dict.fromkeys(
            outcome.responses, 200
        )

    def test_the_include_time_dependency_runs_before_the_router_level_one(self, outcome: Outcome) -> None:
        deps = [line for line in outcome.events if line.startswith("dep ")]
        assert deps == ["dep b", "dep a"] * 5

    def test_openapi_shows_the_header_parameter_of_a_on_every_path(self, outcome: Outcome) -> None:
        document = json.loads(outcome.responses["openapi"][1])
        assert len(document["paths"]) == 10  # the definition and the translations route of each of the five
        for item in document["paths"].values():
            assert any(p["name"] == "x-a" for p in item["get"].get("parameters", []))

    def test_openapi_shows_the_security_of_b_on_every_path(self, outcome: Outcome) -> None:
        document = json.loads(outcome.responses["openapi"][1])
        for item in document["paths"].values():
            assert item["get"].get("security") == [{"APIKeyHeader": []}]


class TestStoppedWithSigint:
    @pytest.fixture(scope="class")
    @classmethod
    def outcome(cls, tmp_path_factory: pytest.TempPathFactory) -> Outcome:
        return run_scenario(
            tmp_path_factory.mktemp("sigint"), "normal_sigint", requests=ALL[:1], stop_with=signal.SIGINT
        )

    def test_exit_code_zero_with_one_start_and_one_stop(self, outcome: Outcome) -> None:
        assert outcome.exit_code == 0
        assert outcome.events.count("datum start") == 1
        assert outcome.events.count("datum stop") == 1


class TestRaisingStart:
    @pytest.fixture(scope="class")
    @classmethod
    def outcome(cls, tmp_path_factory: pytest.TempPathFactory) -> Outcome:
        return run_scenario(
            tmp_path_factory.mktemp("fail"), "fail_start", env_extra={"DATUM_TEST_FAIL_START": "1"}, requests=ALL[:1]
        )

    def test_uvicorn_exits_with_code_3(self, outcome: Outcome) -> None:
        assert outcome.exit_code == 3

    def test_the_server_never_listens_and_datum_never_starts(self, outcome: Outcome) -> None:
        assert outcome.exit_code == 3  # it stopped because the start raised, not because the application failed to load
        assert not outcome.listening
        assert "datum start" not in outcome.events

    def test_the_error_text_shows_the_problem_id(self, outcome: Outcome) -> None:
        assert "datum.E002" in outcome.stderr
        assert "Application startup failed. Exiting." in outcome.stderr


class TestLifespanOff:
    @pytest.fixture(scope="class")
    @classmethod
    def outcome(cls, tmp_path_factory: pytest.TempPathFactory) -> Outcome:
        requests = (
            ("forms_1", MAIN, HEADERS),
            ("forms_2", MAIN, HEADERS),
            ("second", named("/second"), HEADERS),
            ("third_no_auth", named("/third"), None),
            OPENAPI,
        )
        return run_scenario(
            tmp_path_factory.mktemp("off"), "lifespan_off", extra_args=("--lifespan", "off"), requests=requests
        )

    def test_every_route_answers_503_server_unavailable(self, outcome: Outcome) -> None:
        for label in ("forms_1", "forms_2", "second", "third_no_auth"):
            status, body = outcome.responses[label]
            assert status == 503, label
            assert json.loads(body)["errors"][0]["code"] == "server.unavailable"

    def test_exactly_one_error_is_logged_on_the_datum_logger_over_four_requests(self, outcome: Outcome) -> None:
        lines = re.findall(r"^ERROR datum[. ].*$", outcome.stderr, re.MULTILINE)
        assert len(lines) == 1
        assert "Datum's lifespan never ran" in lines[0]

    def test_datum_never_starts(self, outcome: Outcome) -> None:
        assert outcome.listening  # the application ran, with its lifespan off
        assert "datum start" not in outcome.events


class TestApplicationWithoutALifespanOfItsOwn:
    @pytest.fixture(scope="class")
    @classmethod
    def outcome(cls, tmp_path_factory: pytest.TempPathFactory) -> Outcome:
        return run_scenario(
            tmp_path_factory.mktemp("nolife"),
            "no_app_lifespan",
            env_extra={"DATUM_TEST_NO_APP_LIFESPAN": "1"},
            requests=ALL[:1],
        )

    def test_one_start_and_one_stop(self, outcome: Outcome) -> None:
        assert outcome.events.count("datum start") == 1
        assert outcome.events.count("datum stop") == 1
        assert outcome.events.count("datum enter") == 5


class TestLifespanOnExplicitly:
    @pytest.fixture(scope="class")
    @classmethod
    def outcome(cls, tmp_path_factory: pytest.TempPathFactory) -> Outcome:
        return run_scenario(
            tmp_path_factory.mktemp("on"), "lifespan_on_explicit", extra_args=("--lifespan", "on"), requests=ALL[:1]
        )

    def test_one_start_and_one_stop(self, outcome: Outcome) -> None:
        assert outcome.events.count("datum start") == 1
        assert outcome.events.count("datum stop") == 1
