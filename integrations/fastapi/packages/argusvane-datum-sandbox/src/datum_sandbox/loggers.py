"""The logger names the sandbox library writes on; it installs no handler, no NullHandler, never basicConfig."""

from typing import Final

from datum_sandbox.wasi import LOGGER_NAME

RUNTIME: Final = LOGGER_NAME
"""`datum.runtime`: the engine, the harness, the lifecycle and the capture's warnings."""
SANDBOX: Final = "datum.sandbox"
"""`datum.sandbox`: the run protocol and the run log relay."""
TRACE: Final = "datum.sandbox.trace"
"""`datum.sandbox.trace`: one line per traced run (`datum.runtime.diagnostics.trace`)."""
SETTINGS: Final = "datum.sandbox.settings"
"""`datum.sandbox.settings`: the effective-settings report at start (`datum.runtime.diagnostics.report`)."""
CHECKS: Final = "datum.checks"
"""`datum.checks`: the start-up checks the settings raise (`datum.W008`)."""

LOGGER_NAMES: Final = (RUNTIME, SANDBOX, TRACE, SETTINGS)
"""The loggers this library owns (`datum.checks` is shared with the host)."""
