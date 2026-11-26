# main.py — the endpoint the page delivers to.
#   pip install fastapi uvicorn wasmtime
#   curl -LO https://github.com/quickjs-ng/quickjs/releases/download/v0.16.2/qjs-wasi.wasm
#   uvicorn main:app
#
# The submission is re-validated in the very program the browser's sandbox runs
# (datum-sandbox-program.js, written beside the bundles), in a QuickJS of this process's own —
# QuickJS-ng's WebAssembly build, run by wasmtime: the same kernel over the same schema, the
# same rules, so the same verdict — codes and fields, never text — and the same sanitized
# values. Nothing is re-implemented here; nothing the page did is trusted either.
import hashlib
import json
import logging
import math
import shutil
import tempfile
import threading
import time
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from wasmtime import Config, Engine, ExitTrap, Linker, Module, Store, Trap, WasiConfig

FORM = json.loads(Path("forms/customer-intake.json").read_text())


# The journey the answers were given through, from this server's own copy of the form: the
# envelope names it (submission.journey.id) and nothing more. Handed to the sandbox, it has the
# kernel work the path out again from the values, as the browser did: an answer on a page the
# path skipped is judged hidden, and a form field one of the journey's own fields fills or works
# out counts as asked on that page. None named, or one the form does not have: null, and the
# answers are judged as the whole form, which asks for every required field.
def journey_of(submission: dict):
    named = (submission.get("journey") or {}).get("id")
    return next((j for j in FORM.get("journey", {}).get("journeys", []) if j["id"] == named), None)


# The engine: qjs-wasi.wasm, QuickJS-ng's own WebAssembly build from its release page, compiled
# once and shared. Every request runs it afresh in a store of its own, so requests need no lock.
config = Config()
config.epoch_interruption = True  # the time budget: a run past its deadline traps
engine = Engine(config)
# The file is checked before it is compiled: only the release this server names may run.
QJS_SHA256 = "d2939e98c808e8b9f4164cd0d7b0398cbc0121ddf52862bcd92157d923e461cc"  # v0.16.2
wasm = Path("qjs-wasi.wasm").read_bytes()
if hashlib.sha256(wasm).hexdigest() != QJS_SHA256:
    raise SystemExit("qjs-wasi.wasm is not the release this server names")
QJS = Module(engine, wasm)
linker = Linker(engine)
linker.define_wasi()

# What a run can reach: one directory holding the program, and nothing else — not this
# directory, not the disk. Made as the server starts, removed as it stops.
APP = tempfile.TemporaryDirectory(prefix="datum-")
shutil.copy("datum-sandbox-program.js", APP.name)

# The clock every budget is kept by, one for all the runs at once: a tick every 50 ms; a run's
# deadline is its budget in ticks, plus one for the tick already under way when it started. The
# epoch it advances is the engine's, shared by every store on it, so no run may bump it for
# itself: a timer of the run's own, fired when its budget was spent, would advance the epoch under
# every other run in flight too, and cut short one that had set its deadline a tick earlier — a
# wrong verdict for a submission that was never judged. One clock, and no run can touch another.
TICK = 0.05


def clock() -> None:
    while True:
        time.sleep(TICK)
        engine.increment_epoch()


threading.Thread(target=clock, daemon=True).start()


class SandboxError(Exception):
    """A run that ended without an outcome: a limit cut it off, or a program or rule module would not load."""


def qjs(argv: list, request: str, seconds: float, memory: int) -> str:
    # One run: the programs' directory mounted read-only as /app, the request on stdin, the
    # answer on stdout — all the run can reach; wasmtime hands it nothing else. The limits are
    # wasmtime's, at the browser's profile: the budget in seconds, the memory in bytes. Runaway
    # recursion exhausts the instance's own stack and traps, which ends the run too.
    out, err = [], []
    with tempfile.NamedTemporaryFile("w", suffix=".json") as stdin:
        stdin.write(request)
        stdin.flush()
        store = Store(engine)
        store.set_limits(memory_size=memory)
        store.set_epoch_deadline(math.ceil(seconds / TICK) + 1)
        wasi = WasiConfig()
        wasi.argv = ["qjs", "--std", *argv]  # --std: the std module, which reads stdin
        wasi.preopen_dir(APP.name, "/app", fs_mutable=False)
        wasi.stdin_file = stdin.name
        wasi.stdout_custom = out.append
        wasi.stderr_custom = err.append
        store.set_wasi(wasi)
        try:
            linker.instantiate(store, QJS).exports(store)["_start"](store)
        except ExitTrap as exit:  # a throw: qjs printed it to stderr and exited 1
            if exit.code != 0:
                raise SandboxError(b"".join(err).decode().strip()) from exit
        except Trap as trap:  # "interrupt": the budget; "stack_overflow": the recursion
            raise SandboxError(f"{trap.trap_code}") from trap
    return b"".join(out).decode().rstrip("\n")


# What one run evaluates: the program, the page's rules registered into it, then the call — the
# context from stdin, the outcome to stdout. The program itself disables Date and Math.random.
RULES = Path("rules/intake-rules.js").read_text()
VALIDATE = ["-I", "/app/datum-sandbox-program.js", "-e", "__datum_register(" + RULES + "); print(__datum_run(std.in.readAsString()));"]

# What the rules read beside the values. The page injected a copy of its own; the server has the say.
PHONE_COUNTRIES = ["CA", "US"]

# What the Country select shows, resolved here: the program never fetches a data source. An answer to a
# choice whose source is missing from the optionSnapshot below is refused (option.sourceUnavailable).
COUNTRIES = [{"value": "CA", "label": "Canada"}, {"value": "US", "label": "United States"}, {"value": "MX", "label": "Mexico"}]

# The run log comes back with the outcome — the sandbox has no console — and goes to this
# process's logger: what the kernel did, step by step, and what the rules said, at LOG_LEVEL.
LOG_LEVEL = "debug"  # "off", "error", "warn" (the kernel's default), "info" or "debug"
LEVELS = {"debug": logging.DEBUG, "info": logging.INFO, "warn": logging.WARNING, "error": logging.ERROR}
log = logging.getLogger("datum.sandbox")
logging.basicConfig(level=logging.DEBUG)  # so the forwarded entries reach the console

app = FastAPI()


@app.post("/api/submissions")
def submit(body: dict):
    key = body.get("submissionKey")  # one per attempt: the same key again is the same submission
    if not isinstance(key, str) or not key:  # without one a retry could not be told from a new submission
        return JSONResponse(status_code=400, content={"errors": [{"code": "bad_document"}]})
    submission = body["document"]["submission"]  # the delivery is { document, submissionKey }
    context = {
        "formId": FORM["id"],
        "form": FORM["root"],  # the schema: field constraints and sanitization come from it
        "values": submission["values"],
        "locale": submission.get("locale", "en"),
        "externalData": {"phoneCountries": PHONE_COUNTRIES},
        "optionSnapshot": {"countries": COUNTRIES},  # the lists a choice's data source holds, by source id
        "journey": journey_of(submission),  # the path, worked out again from the values (see journey_of)
        "logLevel": LOG_LEVEL,
    }
    try:
        outcome = json.loads(qjs(VALIDATE, json.dumps(context), 0.25, 32 * 1024 * 1024))
    except SandboxError:  # a limit cut the run off, or a rule module would not load: fail closed, as the browser does
        log.exception("sandbox failed for %s", FORM["id"])
        return JSONResponse(status_code=503, content={"errors": [{"code": "wasm.execution_error"}]})
    for entry in outcome.get("logs", []):
        log.log(LEVELS[entry["level"]], "%s %s", entry["message"], json.dumps(entry["data"]) if "data" in entry else "")
    if outcome["errors"]:
        # 422 with the error contract, as the browser would have seen it; the page's messages word it.
        errors = [{"field": e.get("componentId"), "code": e["code"]} for e in outcome["errors"]]
        return JSONResponse(status_code=422, content={"errors": errors})
    store(key, outcome["values"])  # the sanitized values: what the form defines, nothing else
    return {"ok": True}


def store(key: str, values: dict) -> None:
    ...  # wherever submissions go: one record per key: the same key with the same values is that record again; the same key with other values is refused (409 submission.keyConflict)
