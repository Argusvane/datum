"""Boots E and F of the timestamp wire gate (test_wire_tsa.py): only the timestamp router, settings from the
environment.

`DATUM_TSA__ENABLED`, `ACCESS` (open or clients), `SIGNER__*` (self-signed or a PKCS#12 file), `CLIENTS`,
`ALLOW_MEMORY_STORES` and `SESSION_COOKIES` all come from `DatumSettings`; this module adds nothing of its own. The
real engine is used.
"""

from fastapi import FastAPI

from datum_fastapi import Datum, DatumSettings, routers

datum = Datum(config=DatumSettings().to_config())

app = FastAPI()
app.include_router(routers.tsa(datum))
