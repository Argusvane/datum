# main.py — the endpoint the page delivers to: the submission validated, then written into an existing PDF form.
#   pip install fastapi uvicorn wasmtime
#   curl -LO https://github.com/quickjs-ng/quickjs/releases/download/v0.16.2/qjs-wasi.wasm
#   uvicorn main:app
#
# The PDF is one this server already has (templates/customer-intake.pdf): an AcroForm whose fields the
# form's template layout maps to the answers. datum-sandbox-program.js re-validates the envelope
# (see Validate on the server) and datum-pdf-program.js fills the PDF — the kernel behind the
# browser's PDF button, in a QuickJS of this process's own: QuickJS-ng's WebAssembly build, under
# wasmtime. Nothing about PDFs is written here.
import base64
import hashlib
import json
import logging
import math
import shutil
import tempfile
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import JSONResponse, Response
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

# What a run can reach: one directory holding the two programs, and nothing else — not this
# directory, not the disk. Made as the server starts, removed as it stops.
APP = tempfile.TemporaryDirectory(prefix="datum-")
for name in ("datum-sandbox-program.js", "datum-pdf-program.js"):
    shutil.copy(name, APP.name)

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


# The template layout, as the builder's PDF mode authored it: the PDF's fields and
# what fills each — a component's answer, an option's label through template text, a literal.
LAYOUT = next(layout for layout in FORM["pdf"]["layouts"] if layout["id"] == "intake-template")

# The PDF itself, from this server's disk. The layout's template source names it (a storage this
# server resolves, not bytes in the definition), and the bytes ride with each request, base64.
TEMPLATE = base64.b64encode(Path("templates/customer-intake.pdf").read_bytes()).decode("ascii")

# Validation first, so the PDF is filled with the sanitized values: what the form defines, nothing else.
VALIDATE = ["-I", "/app/datum-sandbox-program.js", "-e", "print(__datum_run(std.in.readAsString()));"]

# The PDF program, under the document profile; __datum_pdf's promise settles before qjs exits.
RENDER = ["-I", "/app/datum-pdf-program.js", "-e", "__datum_pdf(std.in.readAsString()).then((json) => print(json));"]


# The fonts the kernel draws the filled fields with when the standard 14 cannot show an answer.
def font(id, family, weight, file):
    data = base64.b64encode(Path("fonts", file).read_bytes()).decode("ascii")
    return {"id": id, "family": family, "weight": weight, "style": "normal", "data": data}


FONTS = [font("dejavu-sans", "sans-serif", 400, "DejaVuSans.ttf"), font("dejavu-sans-bold", "sans-serif", 700, "DejaVuSans-Bold.ttf")]

# What the Country select shows, resolved here: the layout's "{{country}}" writes the option's label.
COUNTRIES = [{"value": "CA", "label": "Canada"}, {"value": "US", "label": "United States"}, {"value": "MX", "label": "Mexico"}]

# What becomes of the filled fields. "editable" leaves them fields a reader may still change;
# "readonly" locks each one the fill touched; "flatten" burns the values into the page and drops
# the fields — an archive copy. The layout's own options are set here, per server.
FIELDS = "editable"

log = logging.getLogger("datum.fill")
logging.basicConfig(level=logging.INFO)

app = FastAPI()


@app.post("/api/submissions/fill")
def submit(envelope: dict):
    submission = envelope["submission"]
    locale = submission.get("locale", "en")
    # The journey, if the answers came through one: the path is worked out again from the values (see journey_of).
    context = {"formId": FORM["id"], "form": FORM["root"], "values": submission["values"], "locale": locale, "journey": journey_of(submission), "optionSnapshot": {"countries": COUNTRIES}}
    outcome = json.loads(qjs(VALIDATE, json.dumps(context), 0.25, 32 * 1024 * 1024))
    if outcome["errors"]:  # 422 with codes and fields, never text; the page's messages word them
        errors = [{"field": e.get("componentId"), "code": e["code"]} for e in outcome["errors"]]
        return JSONResponse(status_code=422, content={"errors": errors})
    response = render({
        "abi": "1.0.0",
        "op": "document",
        "form": FORM["root"],
        # The template layout, inline, with this server's fill options: this server's choice, so no
        # layout's "when" is tried, and the bytes below are that layout's.
        "layout": {**LAYOUT, "options": {"flatten": FIELDS == "flatten", "readOnly": FIELDS == "readonly", "appearances": "regenerate"}},
        # The PDF to fill: the bytes the layout's source names, resolved by this server.
        "template": {"data": TEMPLATE},
        "values": outcome["values"],
        "locale": locale,  # the language template texts resolve in: the country's name, here
        "optionSnapshot": {"country": COUNTRIES},
        "fonts": FONTS,
        # The only time and identity the program ever sees: the same request gives the same bytes.
        "env": {"createdAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z"), "documentId": str(uuid.uuid4())},
    })
    if not response["ok"]:  # {"code": "template" | "font" | "internal", "message": ...}
        return JSONResponse(status_code=500, content={"error": response["error"]})
    # The fill report, one entry per mapped field: filled; cleared (no answer, or one a rule hid);
    # missing (the PDF has no field of that name); unsupported (a kind the kernel cannot fill).
    for field in response["fields"]:
        log.info("%s %s (%s)", field["status"], field["pdfField"], field.get("kind", "-"))
    return Response(
        content=base64.b64decode(response["bytes"]),
        media_type="application/pdf",
        headers={"Content-Disposition": 'attachment; filename="customer-intake-filled.pdf"', "X-Page-Count": str(response["pageCount"])},
    )


def render(request: dict) -> dict:
    return json.loads(qjs(RENDER, json.dumps(request), 15, 256 * 1024 * 1024))
