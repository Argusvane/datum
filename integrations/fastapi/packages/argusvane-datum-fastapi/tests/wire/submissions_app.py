"""Boots A and B of the submissions wire gate (test_wire_submissions.py): forms, submissions and authoring,
settings from the environment.

The kit's fixture form is installed through DATUM_FORMS__LOCATIONS; the endpoint switches (SUBMISSIONS, VALIDATE, TEST,
DEFINITION) and the throttle limit come from the environment. The authoring router sits behind a test dependency that
lets the kit's persona in (a TEST deployment; real applications put their own security there). The real engine is used.
"""

from fastapi import Depends, FastAPI

from datum_fastapi import Datum, DatumSettings, routers


def permit() -> None:
    """The test dependency: every caller is the author."""


datum = Datum(config=DatumSettings().to_config())

app = FastAPI()
app.include_router(routers.forms(datum))
app.include_router(routers.submissions(datum))
app.include_router(routers.authoring(datum, dependencies=[Depends(permit)]))
