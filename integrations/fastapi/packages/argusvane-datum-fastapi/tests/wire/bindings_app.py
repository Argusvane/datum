"""Boot of the per-route binding gate (test_wire_bindings.py): the forms, PDF and asset routers.

Settings come from the environment: `datum.bindings.*` (default, per-route overrides, the catalog entries and PDF theme
files of a binding the host registers) is `DATUM_BINDINGS__*`; this module adds nothing of its own. The PDF router is
mounted with `dependencies=[]`, the explicit opt-out of its privileged factory: a TEST deployment. The real engine is
used. `DATUM_TEST_DROP_PDF_THEME=1` drops the theme object from every request (the regression the gate must fail).
"""

import os

from fastapi import FastAPI

from datum_core.bindings import HostBindings
from datum_fastapi import Datum, DatumSettings, routers

if os.environ.get("DATUM_TEST_DROP_PDF_THEME") == "1":
    # The regression PDF-06 must catch: the reply still names the route's PDF theme, but no theme object reaches the
    # request, so the PDF is drawn under the engine's own look.
    HostBindings.pdf_theme = lambda self, form_key: None  # type: ignore[method-assign]

datum = Datum(config=DatumSettings().to_config())

app = FastAPI()
app.include_router(routers.forms(datum))
app.include_router(routers.pdf(datum, dependencies=[]))
app.include_router(routers.assets(datum))
