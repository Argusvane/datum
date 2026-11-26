"""Boot of the wire gate for test_wire_host_check.py: forms and assets under uvicorn,
settings from the environment.

The kit's fixture form is installed through DATUM_FORMS__LOCATIONS; the endpoint and asset switches come from the
environment too (DATUM_WEB__API__ENDPOINTS__DEFINITION, DATUM_WEB__ASSETS__ENABLED, DATUM_BUILDER__ENABLED). The real
engine is used: nothing here is a fake.
"""

from fastapi import FastAPI

from datum_fastapi import Datum, DatumSettings, routers

datum = Datum(config=DatumSettings().to_config())

app = FastAPI()
app.include_router(routers.forms(datum))
app.include_router(routers.assets(datum))
