"""Scenario application of the uvicorn shutdown tests.

One definition read whose work (the sandbox's public copy) takes DATUM_TEST_EFFECT_SECONDS; DATUM_TEST_SHUTDOWN_GRACE
sets `datum.runtime.shutdown_grace`. DATUM_EVENT_LOG gets one line per step: `effect start`, `effect done`,
`datum stop` (the runtime closed).
"""

import copy
import logging
import os
import sys
import time
from collections.abc import Mapping
from pathlib import Path
from typing import cast

from datum_fakes import StubRepository, definition, strip_secret
from fastapi import FastAPI

from datum_core import DatumConfig
from datum_fastapi import Datum, routers
from datum_sandbox.json import JsonValue
from datum_sandbox.protocol import Sandbox, Smoke
from datum_sandbox.wasi import EngineInfo, GuestRuntime


def event(line: str) -> None:
    path = os.environ.get("DATUM_EVENT_LOG")
    if path:
        with Path(path).open("a", encoding="utf-8") as handle:
            handle.write(line + "\n")


handler = logging.StreamHandler(sys.stderr)
handler.setFormatter(logging.Formatter("%(levelname)s %(name)s %(message)s"))
logger = logging.getLogger("datum")
logger.addHandler(handler)
logger.setLevel(logging.INFO)
logger.propagate = False


class LoggingRuntime:
    pools = frozenset({"validation"})  # a validation-only engine: no PDF pool, so the PDF program never runs here

    def engine_info(self) -> EngineInfo:
        return EngineInfo(id="stub", release="1.0", mode="test")

    def close(self) -> None:
        event("datum stop")


class SlowSandbox:
    def prove_abi(self) -> None:
        return None

    def smoke(self) -> Smoke:
        return Smoke(ok=True, elapsed=0.0, message="")

    def public_copy(self, definition: Mapping[str, JsonValue]) -> dict[str, JsonValue]:
        event("effect start")
        time.sleep(float(os.environ.get("DATUM_TEST_EFFECT_SECONDS", "3")))
        event("effect done")
        return cast("dict[str, JsonValue]", strip_secret(copy.deepcopy(dict(definition))))


sections = {
    "web": {"api": {"endpoints": {"definition": True}}},
    # The settings report names every key at start; these tests read the log for the one interruption line.
    "runtime": {
        "shutdown_grace": float(os.environ.get("DATUM_TEST_SHUTDOWN_GRACE", "10")),
        "diagnostics": {"report": False},
    },
}
datum = Datum(
    config=DatumConfig.model_validate(sections),
    runtime=cast("GuestRuntime", LoggingRuntime()),
    sandbox=cast("Sandbox", SlowSandbox()),
    form_repository=StubRepository(definition("contact", secret=True)),
)
app = FastAPI()
app.include_router(routers.forms(datum))
