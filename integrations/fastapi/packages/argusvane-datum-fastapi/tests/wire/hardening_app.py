"""Boot C of the submissions wire gate (test_wire_submissions.py): the hardening cases in a TEST deployment,
never one people use.

The kit's `hardening-rules.js` (WIRE_HARDENING_RULES names the file `datum-host-check fixtures` wrote) is
registered for the fixture form through `rules_providers`, so a hostile answer can loop, take memory or write a
forged outcome. The run memory is raised to 512 MiB by the environment (DATUM_RUNTIME__VALIDATION__MEMORY).
"""

import os
from collections.abc import Sequence
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI

from datum_core.submissions import SubmissionContext
from datum_fastapi import Datum, DatumSettings, routers
from datum_sandbox.protocol import RuleModule

FIXTURE_FORM = "datum-security-suite"
HOSTILE = RuleModule("datum-tck-hardening", "1", Path(os.environ["WIRE_HARDENING_RULES"]).read_text("utf-8"))


def hostile_rules(form_key: str, form: Any, context: SubmissionContext) -> Sequence[RuleModule]:
    return [HOSTILE] if form_key == FIXTURE_FORM else []


def permit() -> None:
    """The test dependency: every caller is the author."""


datum = Datum(config=DatumSettings().to_config(), rules_providers=[hostile_rules])

app = FastAPI()
app.include_router(routers.forms(datum))
app.include_router(routers.submissions(datum))
app.include_router(routers.authoring(datum, dependencies=[Depends(permit)]))
