"""The UI example: the form builder and the forms it edits, served over memory stores.

Run it from this directory with the settings in README.md. The builder page is `/builder`; it loads the shipped page
glue from the assets path and saves with `If-Match`. Every store is in memory, so a restart forgets the saves.
"""

import json
from pathlib import Path

from fastapi import Depends, FastAPI
from fastapi.responses import HTMLResponse

from datum_core.stores.memory import MemoryFormDefinitionRepository
from datum_fastapi import Datum, DatumSettings, routers

FORMS = Path(__file__).resolve().parent / "forms"
"""Where the form definitions that seed the writable repository live (one JSON document per file)."""

FORM_KEY = "datum-security-suite"
"""The form the builder page opens."""

BUILDER_PAGE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Form builder</title>
</head>
<body>
<p id="status" role="status"></p>
<datum-form-builder></datum-form-builder>
<script type="module">
  import { DatumHost } from '/datum/assets/datum-host.js';
  const element = document.querySelector('datum-form-builder');
  const status = document.querySelector('#status');
  await DatumHost.builder(element, { formKey: '__FORM_KEY__', status });
</script>
</body>
</html>
"""


def permit() -> None:
    """Admit every caller: the example's stand-in for authentication. A real application puts its own here."""


seeds = [json.loads(path.read_text(encoding="utf-8")) for path in sorted(FORMS.glob("*.json"))]
datum = Datum(config=DatumSettings().to_config(), form_repository=MemoryFormDefinitionRepository(seeds))

app = FastAPI()
app.include_router(routers.forms(datum))
app.include_router(routers.assets(datum))
app.include_router(routers.builder(datum, dependencies=[Depends(permit)]))


@app.get("/builder", response_class=HTMLResponse, dependencies=[Depends(permit)], include_in_schema=False)
def builder_page() -> HTMLResponse:
    """Answer the builder page, whose glue opens `<datum-form-builder>` on the example form."""
    return HTMLResponse(BUILDER_PAGE.replace("__FORM_KEY__", FORM_KEY), headers={"Cache-Control": "no-store"})
