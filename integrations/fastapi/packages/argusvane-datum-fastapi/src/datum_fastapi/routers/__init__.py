"""Datum's router factories (`routers.forms`, `routers.submissions`, ...): include each once, with its lifespan.

Every factory takes the `Datum` and keyword-only `prefix` and `dependencies`; a privileged factory (the management,
authoring, builder and pdf routers of later phases) is declared with `@privileged`, so its `dependencies` keyword is
required.
"""

from datum_fastapi.routers._factory import Dependencies, capability_router, privileged
from datum_fastapi.routers.assets import assets
from datum_fastapi.routers.authoring import authoring
from datum_fastapi.routers.builder import builder
from datum_fastapi.routers.forms import forms
from datum_fastapi.routers.management import management
from datum_fastapi.routers.pdf import pdf
from datum_fastapi.routers.submissions import submissions
from datum_fastapi.routers.tsa import tsa

__all__ = [
    "Dependencies",
    "assets",
    "authoring",
    "builder",
    "capability_router",
    "forms",
    "management",
    "pdf",
    "privileged",
    "submissions",
    "tsa",
]
