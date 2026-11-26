"""The timestamp server example: an RFC 3161 authority that answers `POST /tsa` over memory stores.

Run it from this directory with the settings in README.md. Every setting comes from the environment, so the signing key,
the access rule and the acknowledgement of memory stores are all visible there. Serials and the issue log are kept in
memory: a restart forgets them.
"""

from fastapi import FastAPI

from datum_fastapi import Datum, DatumSettings, routers

datum = Datum(config=DatumSettings().to_config())
"""The Datum object; the timestamp router reads `datum.tsa.*` from the environment at start."""

app = FastAPI()
app.include_router(routers.tsa(datum))
