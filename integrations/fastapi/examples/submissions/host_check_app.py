"""TEST WIRING for `datum-host-check` (the conformance suite's black-box host check). Never enable it in production.

This is the submissions example plus what the external check needs and a real deployment must never have: the dry-run
route, a host context provider that trusts a request header (`X-Datum-Test-Role`, for the `datum-host-context` form
only), and the hostile rule module (loops, allocates, answers huge) registered for the fixture form. It refuses to
start unless `HOST_CHECK_TEST_WIRING=yes-this-is-a-test-deployment` is set. See README.md ("Running the host
check") for the commands.
"""

import os

from fastapi import FastAPI

from datum_core.testing.host_context import role_header_host_context
from datum_fastapi import Datum, DatumSettings, routers
from datum_sandbox.protocol import RuleModule
from datum_sandbox.testing.fixtures import hardening_rules

SWITCH = "HOST_CHECK_TEST_WIRING"
if os.environ.get(SWITCH) != "yes-this-is-a-test-deployment":
    raise SystemExit(f"host_check_app.py is test wiring: set {SWITCH}=yes-this-is-a-test-deployment to run it")

FIXTURE_FORM = "datum-security-suite"
_HARDENING = RuleModule("datum-tck-hardening", "1", hardening_rules())


def hostile_rules(form_key: str, definition: object, context: object) -> list[RuleModule]:  # noqa: ARG001
    """Register the kit's hostile rule module for the fixture form only."""
    return [_HARDENING] if form_key == FIXTURE_FORM else []


datum = Datum(
    config=DatumSettings().to_config(),
    host_context=role_header_host_context,
    rules_providers=[hostile_rules],
)

app = FastAPI()
app.include_router(routers.forms(datum))
app.include_router(routers.assets(datum))
app.include_router(routers.submissions(datum))
app.include_router(routers.authoring(datum, dependencies=[]))
