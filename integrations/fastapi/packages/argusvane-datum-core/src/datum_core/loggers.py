"""Logger names. Datum installs no handler, no NullHandler and never calls basicConfig."""

from typing import Final

from datum_sandbox import loggers as sandbox_loggers

ROOT: Final = "datum"
EVENTS: Final = "datum.events"
CHECKS: Final = "datum.checks"
SUBMISSIONS: Final = "datum.submissions"
FORMS: Final = "datum.forms"
BUILDER: Final = "datum.builder"
PDF: Final = "datum.pdf"
TSA: Final = "datum.tsa"
ASSETS: Final = "datum.assets"

LOGGER_NAMES: Final = (
    sandbox_loggers.SANDBOX,
    EVENTS,
    CHECKS,
    sandbox_loggers.RUNTIME,
    SUBMISSIONS,
    FORMS,
    BUILDER,
    PDF,
    TSA,
    ASSETS,
    sandbox_loggers.TRACE,
    sandbox_loggers.SETTINGS,
)
"""Every documented logger, argusvane-datum-sandbox's four included; ``extra`` keys on records are prefixed
``datum_``."""
