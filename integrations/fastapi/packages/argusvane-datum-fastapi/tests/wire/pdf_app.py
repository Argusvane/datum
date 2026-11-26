"""Boots G and H of the PDF wire gate (test_wire_pdf.py): the forms and PDF routers, settings from the environment.

The kit's fixture form is installed through DATUM_FORMS__LOCATIONS; the five PDF switches and the definition switch
(DATUM_WEB__API__ENDPOINTS__{PDF,FILL,SIGN,VERIFY,CERTIFICATE,DEFINITION}), the PKCS#12 signing key, the seal and the
in-process timestamp authority all come from `DatumSettings`; this module adds nothing of its own. The PDF router is
mounted with `dependencies=[]`, the explicit opt-out of its privileged factory: a TEST deployment, real applications
put their own security there. The real engine is used.
"""

from fastapi import FastAPI

from datum_fastapi import Datum, DatumSettings, routers

datum = Datum(config=DatumSettings().to_config())

app = FastAPI()
app.include_router(routers.forms(datum))
app.include_router(routers.pdf(datum, dependencies=[]))
