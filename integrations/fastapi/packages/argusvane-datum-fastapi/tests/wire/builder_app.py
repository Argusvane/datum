"""Boot D of the builder wire gate (test_wire_builder.py): forms, assets and the builder over a writable memory
repository, settings from the environment.

The kit's fixture form is installed through DATUM_FORMS__LOCATIONS and seeded into a `MemoryFormDefinitionRepository`
(BLD writes the stored fixture; every boot is fresh). The builder router sits behind a test persona: no `X-Persona`
header is a visitor (401), `person` may build, anyone else is another person (403). A TEST deployment; real
applications put their own security there. The real engine is used.
"""

import json
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, HTTPException, Request

from datum_core.stores.memory import MemoryFormDefinitionRepository
from datum_fastapi import Datum, DatumSettings, routers


def persona(request: Request) -> None:
    """The test dependency: a visitor is refused 401, the person builds, another person is refused 403."""
    who = request.headers.get("x-persona")
    if who is None:
        raise HTTPException(401, "sign in")
    if who != "person":
        raise HTTPException(403, "not you")


config = DatumSettings().to_config()
seed: list[dict[str, Any]] = [
    json.loads(Path(location).read_text(encoding="utf-8")) for location in config.forms.locations
]
datum = Datum(config=config, form_repository=MemoryFormDefinitionRepository(seed=seed))

app = FastAPI()
app.include_router(routers.forms(datum))
app.include_router(routers.assets(datum))
app.include_router(routers.builder(datum, dependencies=[Depends(persona)]))
